import asyncio
import logging
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum, auto
from functools import partial

from pyirda.events import Event, Request
from pyirda.irlap import IrLAP, Link
from pyirda.irlap.frame import XIDResponseFrame
from pyirda.irlmp.constants import (
    LINGER_TIMEOUT,
    LSAP_CONNECTIONLESS,
    LSAP_IAS,
    LSAP_MAX,
    WATCHDOG_TIMEOUT,
    Hints,
    Reason,
)
from pyirda.irlmp.events import (
    ConnectRequest,
    ConnectResponse,
    DataRequest,
    DisconnectRequest,
    LSConnectConfirm,
    LSDisconnectIndication,
    WatchdogExpired,
)
from pyirda.irlmp.ias import IAS
from pyirda.irlmp.pdu import (
    LMPDU,
    AccessModeConfirmPDU,
    AccessModePDU,
    ConnectConfirmPDU,
    ConnectPDU,
    DataPDU,
    DeviceInfo,
    DisconnectPDU,
)
from pyirda.timer import Timer

logger = logging.getLogger(__name__)

HEADER_SIZE = 2


class State(Enum):
    DISCONNECTED = auto()
    SETUP_PEND = auto()
    SETUP = auto()
    CONNECT_PEND = auto()
    CONNECT = auto()
    DTR = auto()


@dataclass(frozen=True)
class Device:
    address: int
    hints: Hints
    nickname: str

    @classmethod
    def parse(cls, xid: XIDResponseFrame) -> "Device":
        info = DeviceInfo.parse(xid.discovery_info)

        return cls(xid.src_device_address, info.hints, info.nickname)


class Endpoint(asyncio.Transport):
    def __init__(self, connection: "LSAPConnection", connect_data: bytes) -> None:
        link = connection.irlmp.link
        super().__init__(
            {
                "irlmp": connection.irlmp,
                "address": link.get_extra_info("address"),
                "data_size": link.get_extra_info("data_size") - HEADER_SIZE,
                "connect_data": connect_data,
            }
        )
        self._connection = connection
        self._closing = False

    def write(self, data: bytes) -> None:
        if len(data) > self.get_extra_info("data_size"):
            msg = f"LM-PDU of {len(data)} bytes exceeds the {self.get_extra_info('data_size')} that fit an I frame"
            raise ValueError(msg)

        self._connection.data_request(bytes(data))

    def accept(self, data: bytes = b"") -> None:
        self._connection.connect_response(data)

    def close(self) -> None:
        self._closing = True
        self._connection.disconnect_request()

    def is_closing(self) -> bool:
        return self._closing or self._connection.state is State.DISCONNECTED


class LSAPConnection:
    def __init__(
        self, irlmp: "IrLMP", local: int, remote: int, protocol_factory: Callable[[], asyncio.BaseProtocol]
    ) -> None:
        self.irlmp = irlmp
        self.local = local
        self.remote = remote
        self.protocol_factory = protocol_factory

        self.state = State.DISCONNECTED
        self.endpoint: Endpoint | None = None
        self.protocol: asyncio.BaseProtocol | None = None
        self.confirmed: asyncio.Future[tuple[Endpoint, asyncio.BaseProtocol]] | None = None

        self._connect_data = b""
        self._pending: deque[bytes] = deque()
        self._watchdog = Timer(WATCHDOG_TIMEOUT, partial(self.dispatch, WatchdogExpired()))

    def __repr__(self) -> str:
        return f"LSAPConnection({self.local:#04x}<->{self.remote:#04x}, {self.state.name})"

    # --- service interface ---

    def connect_request(self, data: bytes) -> asyncio.Future[tuple[Endpoint, asyncio.BaseProtocol]]:
        self.confirmed = asyncio.get_running_loop().create_future()
        self.dispatch(ConnectRequest(data))

        return self.confirmed

    def connect_response(self, data: bytes) -> None:
        self.dispatch(ConnectResponse(data))

    def data_request(self, data: bytes) -> None:
        self._pending.append(data)
        self.dispatch(DataRequest())

    def disconnect_request(self) -> None:
        self.dispatch(DisconnectRequest())

    # --- state machine ---

    def dispatch(self, trigger: LMPDU | Event) -> None:
        state = self.state
        logger.debug("---> %s %s", self, trigger)

        match (state, trigger):
            case (State.DISCONNECTED, ConnectRequest(data=data)):
                self._connect_data = data

                self.state = State.SETUP_PEND

                self.irlmp.bind(self)

            case (State.DISCONNECTED, ConnectPDU(data=data)):
                self._connect_data = data

                self.state = State.CONNECT_PEND

                self.irlmp.bind(self)

            case (State.SETUP_PEND, LSConnectConfirm()):
                self._send(ConnectPDU(self.remote, self.local, self._connect_data))
                self._watchdog.start()

                self.state = State.SETUP

            case (State.CONNECT_PEND, LSConnectConfirm()):
                self._open()
                asyncio.get_running_loop().call_soon(self.dispatch, ConnectResponse(b""))

                self.state = State.CONNECT

            case (State.SETUP, ConnectConfirmPDU(data=data)):
                self._watchdog.stop()
                self._connect_data = data
                self._open()
                self.confirmed.set_result((self.endpoint, self.protocol))
                self.confirmed = None

                self.state = State.DTR

            case (State.SETUP, ConnectPDU()):
                self._watchdog.stop()
                self._closed(ConnectionResetError("Connection race"))

                self.state = State.DISCONNECTED

            case (State.SETUP, DisconnectPDU(reason=reason)):
                self._watchdog.stop()
                self._closed(ConnectionRefusedError(reason.name))

                self.state = State.DISCONNECTED

            case (State.SETUP, WatchdogExpired()):
                self._closed(TimeoutError("Peer did not respond"))

                self.state = State.DISCONNECTED

            case (State.CONNECT, ConnectResponse(data=data)):
                self._send(ConnectConfirmPDU(self.remote, self.local, data))

                self.state = State.DTR

            case (State.CONNECT | State.DTR, DisconnectRequest()):
                self._send(DisconnectPDU(self.remote, self.local, Reason.USER_REQUEST))
                self._closed(None)

                self.state = State.DISCONNECTED

            case (State.DTR, DataRequest()):
                while self._pending:
                    self._send(DataPDU(self.remote, self.local, self._pending.popleft()))

                self.state = State.DTR

            case (State.DTR, DataPDU(data=data)):
                asyncio.get_running_loop().call_soon(self.protocol.data_received, data)

                self.state = State.DTR

            case (State.DTR, ConnectPDU()):
                self._send(DisconnectPDU(self.remote, self.local, Reason.HALF_OPEN))
                self._closed(ConnectionResetError(Reason.HALF_OPEN.name))

                self.state = State.DISCONNECTED

            case (State.DTR, DisconnectPDU(reason=reason)):
                self._closed(None if reason is Reason.USER_REQUEST else ConnectionResetError(reason.name))

                self.state = State.DISCONNECTED

            case (_, LSDisconnectIndication(exc=exc)) if state is not State.DISCONNECTED:
                self._watchdog.stop()
                self._closed(exc)

                self.state = State.DISCONNECTED

            case (_, Request()):
                pass

            case _:
                logger.debug("Ignoring %s in %s", trigger, state)

        logger.debug("<--> %s", self)

        if self.state is State.DTR and state is not State.DTR and self._pending:
            self.dispatch(DataRequest())

    # --- actions ---

    def _send(self, pdu: LMPDU) -> None:
        self.irlmp.link.write(bytes(pdu.payload))

    def _open(self) -> None:
        self.endpoint = Endpoint(self, self._connect_data)
        self.protocol = self.protocol_factory()
        asyncio.get_running_loop().call_soon(self.protocol.connection_made, self.endpoint)

    def _closed(self, exc: Exception | None) -> None:
        self.irlmp.unbind(self)
        self._pending.clear()

        if self.confirmed:
            self.confirmed.set_exception(exc or ConnectionResetError())
            self.confirmed = None

        if self.protocol:
            asyncio.get_running_loop().call_soon(self.protocol.connection_lost, exc)


class IrLMP(asyncio.Protocol):
    def __init__(self, irlap: IrLAP, nickname: str = "pyirda", hints: Hints = Hints.COMPUTER) -> None:
        self.irlap = irlap
        self.irlap.protocol_factory = lambda: self
        self.irlap.discovery_info = DeviceInfo(hints, nickname).build()

        self.link: Link | None = None
        self.listeners: dict[int, Callable[[], asyncio.BaseProtocol]] = {}
        self.ias = IAS(self, nickname)

        self._connections: dict[tuple[int, int], LSAPConnection] = {}
        self._connecting: asyncio.Future[tuple[Link, asyncio.BaseProtocol]] | None = None
        self._released: asyncio.Future[None] | None = None
        self._cache: list[Device] = []
        self._linger = Timer(LINGER_TIMEOUT, self._close_link)

    # --- service interface ---

    async def discover(self) -> list[Device]:
        if self._connecting or self._connections:
            return self._cache

        await self._release()
        devices = {xid.src_device_address: Device.parse(xid) for xid in await self.irlap.discover()}
        self._cache = list(devices.values())

        return self._cache

    async def connect(
        self, address: int, sel: int | str, protocol_factory: Callable[[], asyncio.BaseProtocol], data: bytes = b""
    ) -> tuple[Endpoint, asyncio.BaseProtocol]:
        await self._link(address)

        if isinstance(sel, str):
            sel = await self.resolve(address, sel)

        connection = LSAPConnection(self, self._free_sel(sel), sel, protocol_factory)

        return await connection.connect_request(data)

    async def resolve(self, address: int, service: str, attribute: str = "IrDA:IrLMP:LsapSel") -> int:
        values = await self.ias.get_value_by_class(address, service, attribute)

        if not values:
            msg = f"No {service} service on {address:#010x}"
            raise LookupError(msg)

        return values[0][1]

    def _free_sel(self, remote: int) -> int:
        used = {local for local, peer in self._connections if peer == remote}

        return next(sel for sel in range(LSAP_IAS + 1, LSAP_MAX + 1) if sel not in used and sel not in self.listeners)

    # --- IrLAP connection control ---

    async def _link(self, address: int) -> Link:
        if self.link and self.link.get_extra_info("address") == address:
            return self.link

        if self._connecting is None:
            await self._release()
            self._connecting = asyncio.ensure_future(self.irlap.connect(address))

        try:
            link, _ = await self._connecting
        finally:
            self._connecting = None

        return link

    async def _release(self) -> None:
        if self.link is None or self._connections:
            return

        if self._released is None:
            self._released = asyncio.get_running_loop().create_future()
            self._close_link()

        await self._released

    def _close_link(self) -> None:
        if self.link:
            self.link.close()

    def bind(self, connection: LSAPConnection) -> None:
        self._connections[connection.local, connection.remote] = connection
        self._linger.stop()

        connection.dispatch(LSConnectConfirm())

    def unbind(self, connection: LSAPConnection) -> None:
        self._connections.pop((connection.local, connection.remote), None)

        if not self._connections and self.link:
            self._linger.start()

    # --- IrLAP side ---

    def connection_made(self, link: Link) -> None:
        self.link = link

    def connection_lost(self, exc: Exception | None) -> None:
        self.link = None
        self._linger.stop()

        for connection in list(self._connections.values()):
            connection.dispatch(
                LSDisconnectIndication(exc or ConnectionResetError(Reason.UNEXPECTED_IRLAP_DISCONNECT.name))
            )

        if self._released:
            self._released.set_result(None)
            self._released = None

    def data_received(self, data: bytes) -> None:
        if len(data) < HEADER_SIZE:
            return

        pdu = LMPDU.parse(data)

        match pdu:
            case LMPDU(dlsap=dlsap, slsap=slsap) if max(dlsap, slsap) >= LSAP_CONNECTIONLESS:
                pass

            case AccessModePDU():
                self._send(AccessModeConfirmPDU(pdu.slsap, pdu.dlsap, status=0xFF, mode=0))

            case LMPDU(dlsap=dlsap, slsap=slsap) if (dlsap, slsap) in self._connections:
                self._connections[dlsap, slsap].dispatch(pdu)

            case ConnectPDU(dlsap=dlsap) if dlsap in self.listeners:
                LSAPConnection(self, dlsap, pdu.slsap, self.listeners[dlsap]).dispatch(pdu)

            case ConnectPDU():
                self._send(DisconnectPDU(pdu.slsap, pdu.dlsap, Reason.NO_PEER_MUX_CLIENT))

            case DataPDU() | ConnectConfirmPDU():
                self._send(DisconnectPDU(pdu.slsap, pdu.dlsap, Reason.DISCONNECTED))

            case _:
                logger.debug("Ignoring %s", pdu)

    def _send(self, pdu: LMPDU) -> None:
        self.link.write(bytes(pdu.payload))
