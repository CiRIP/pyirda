import asyncio
import logging
import random
from collections import deque
from collections.abc import Callable
from enum import Enum, auto
from functools import partial
from math import ceil

from crc import Calculator, Crc16

from pyirda.exceptions import IrdaException
from pyirda.irlap.constants import (
    BAUD_RATE,
    BOF,
    BROADCAST,
    CE,
    EOF,
    F_TIMEOUT,
    FRAME_OVERHEAD,
    P_TIMEOUT,
    QUERY_TIMEOUT,
    RETRY_COUNT,
    SLOT_TIMEOUT,
    WD_TIMEOUT,
    XBOF,
    XID_BROADCAST,
)
from pyirda.irlap.events import (
    ConnectRequest,
    ConnectResponse,
    DataRequest,
    DisconnectRequest,
    DiscoveryRequest,
    Event,
    FTimerExpired,
    PTimerExpired,
    QueryTimerExpired,
    Request,
    SlotTimerExpired,
    WDTimerExpired,
)
from pyirda.irlap.frame import (
    DISCCommandFrame,
    DMResponseFrame,
    Frame,
    FRMRResponseFrame,
    IFrame,
    RDResponseFrame,
    REJFrame,
    RNRFrame,
    RNRMResponseFrame,
    RRFrame,
    SFrame,
    SNRMCommandFrame,
    SREJFrame,
    TESTCommandFrame,
    TESTResponseFrame,
    UAResponseFrame,
    UICommandFrame,
    UIResponseFrame,
    XIDCommandFrame,
    XIDResponseFrame,
)
from pyirda.irlap.negotiation import CAPABILITIES, CONTENTION, NegotiationError, NegotiationParameters
from pyirda.timer import Timer

logger = logging.getLogger(__name__)

crc = Calculator(Crc16.X25.value, optimized=True)


class State(Enum):
    NDM = auto()
    QUERY = auto()
    REPLY = auto()
    CONN = auto()
    SETUP = auto()


class Primary(Enum):
    XMIT = auto()
    RECV = auto()
    PCLOSE_WAIT = auto()
    PCLOSE = auto()


class Secondary(Enum):
    XMIT = auto()
    RECV = auto()
    ERROR = auto()
    SCLOSE = auto()


class Link(asyncio.Transport):
    def __init__(self, irlap: "IrLAP") -> None:
        super().__init__({"irlap": irlap, "address": irlap.dst_device_address, "data_size": irlap.theirs.data_size})
        self._irlap = irlap
        self._closing = False

    def write(self, data: bytes) -> None:
        if self.is_closing():
            logger.debug("Dropping %d bytes written to a closing link", len(data))
            return

        if len(data) > self._irlap.theirs.data_size:
            msg = f"Frame of {len(data)} bytes exceeds the negotiated {self._irlap.theirs.data_size}"
            raise ValueError(msg)

        self._irlap.data_request(bytes(data))

    def close(self) -> None:
        self._closing = True
        self._irlap.disconnect_request()

    def is_closing(self) -> bool:
        return self._closing or self._irlap.link is not self


class IrLAP(asyncio.Protocol):
    def __init__(
        self,
        protocol_factory: Callable[[], asyncio.BaseProtocol] | None = None,
        discovery_info: bytes = b"\x80 \x00TMGC",
        slots: int = 6,
        capabilities: NegotiationParameters = CAPABILITIES,
    ) -> None:
        self.protocol_factory = protocol_factory
        self.discovery_info = discovery_info
        self.capabilities = capabilities

        self.transport: asyncio.Transport | None = None
        self.ready = asyncio.Event()
        self._rx = bytearray()
        self._tx_end = 0.0
        self._turnaround = False

        self.state: State | Primary | Secondary = State.NDM
        self.src_device_address = random.getrandbits(32)
        self.dst_device_address: int | None = None
        self.connection_address: int | None = None
        self.theirs = CONTENTION

        self.link: Link | None = None
        self.protocol: asyncio.BaseProtocol | None = None
        self._discovering: asyncio.Future[list[XIDResponseFrame]] | None = None
        self._connecting: asyncio.Future[tuple[Link, asyncio.BaseProtocol]] | None = None

        self._slot_count = slots
        self._slot_number = 0
        self._slot = 0
        self._frame_sent = False
        self._discovered: list[XIDResponseFrame] = []
        self._snrm: SNRMCommandFrame | None = None

        self.vs = 0
        self.vr = 0
        self._store: deque[IFrame] = deque()
        self._pending: deque[bytes] = deque()
        self._closing = False
        self._remote_busy = False
        self._retry_count = 0
        self._frmr: FRMRResponseFrame | None = None

        self._slot_timer = Timer(SLOT_TIMEOUT, partial(self._dispatch, SlotTimerExpired()))
        self._query_timer = Timer(QUERY_TIMEOUT, partial(self._dispatch, QueryTimerExpired()))
        self._p_timer = Timer(P_TIMEOUT, partial(self._dispatch, PTimerExpired()))
        self._f_timer = Timer(F_TIMEOUT, partial(self._dispatch, FTimerExpired()), self._transmission_remaining)
        self._wd_timer = Timer(WD_TIMEOUT, partial(self._dispatch, WDTimerExpired()), self._transmission_remaining)

    # --- service interface ---

    async def discover(self) -> list[XIDResponseFrame]:
        await self.ready.wait()
        self._require(State.NDM)

        self._discovering = asyncio.get_running_loop().create_future()
        self._dispatch(DiscoveryRequest())

        return await self._discovering

    async def connect(self, address: int) -> tuple[Link, asyncio.BaseProtocol]:
        await self.ready.wait()
        self._require(State.NDM)

        self._connecting = asyncio.get_running_loop().create_future()
        self._dispatch(ConnectRequest(address=address))

        return await self._connecting

    def _require(self, state: State) -> None:
        if self.state is not state:
            msg = f"Cannot do that while in {self.state}"
            raise IrdaException(msg)

    def data_request(self, data: bytes) -> None:
        self._pending.append(data)
        self._dispatch(DataRequest())

    def disconnect_request(self) -> None:
        self._closing = True
        self._dispatch(DisconnectRequest())

    # --- serial side ---

    def connection_made(self, transport: asyncio.Transport) -> None:
        self.transport = transport
        self.ready.set()

    def connection_lost(self, exc: Exception | None) -> None:
        self.ready.clear()
        self.transport = None

    def data_received(self, data: bytes) -> None:
        self._rx.extend(data)

        for frame in self._extract_frames():
            self._dispatch(frame)

    def _extract_frames(self) -> list[Frame]:
        frames = []

        while True:
            start = self._rx.find(BOF)
            if start == -1:
                self._rx.clear()
                break

            del self._rx[:start]

            end = self._rx.find(EOF, 1)
            if end == -1:
                break

            raw = bytes(self._rx[1:end]).strip(bytes([XBOF, BOF]))
            del self._rx[: end + 1]

            try:
                payload = _unstuff_bytes(raw)
                data, fcs = payload[:-2], int.from_bytes(payload[-2:], "little")
                if fcs == crc.checksum(data):
                    frames.append(Frame.parse(data))
            except Exception:
                logger.debug("Dropping malformed frame %s", raw.hex())

        return frames

    def _send(self, frame: Frame) -> None:
        logger.debug("<--- %s", frame)

        raw = self._bofs() + _frame_to_bytes(frame)
        self.transport.write(raw)

        now = asyncio.get_running_loop().time()
        self._tx_end = max(now, self._tx_end) + len(raw) * 10 / BAUD_RATE
        self._turnaround = False

    def _bofs(self) -> bytes:
        count = self.theirs.additional_bofs_at_115200 * BAUD_RATE // 115200

        if self._turnaround:
            count += ceil(self.theirs.min_turn_around_ms * BAUD_RATE / 10_000)

        return bytes([XBOF]) * count

    def _transmission_remaining(self) -> float:
        return max(0.0, self._tx_end - asyncio.get_running_loop().time())

    # --- state machine ---

    def _dispatch(self, trigger: Frame | Event) -> None:
        state = self.state

        match trigger:
            case Frame(address=address) if self.connected and address != self.connection_address:
                return

            case Frame() if self.state in (Primary.RECV, Secondary.RECV):
                self._turnaround = True
                self._retry_count = 0

            case Frame():
                self._turnaround = True

        logger.debug("---> %s", trigger)

        match (state, trigger):
            # --- DISCOVERY ---

            case (State.NDM, DiscoveryRequest()):
                self._slot_number = 0
                self._discovered.clear()
                self._send_xid_command(self._slot_number)
                self._slot_timer.start()

                self.state = State.QUERY

            case (State.NDM, XIDCommandFrame(slot_number=0xFF)):
                self.state = State.NDM

            case (State.NDM, XIDCommandFrame() as xid):
                self._slot = random.randint(xid.slot_number, xid.slot_count - 1)
                self._frame_sent = self._slot == xid.slot_number

                if self._frame_sent:
                    self._send_xid_response(xid)

                self._query_timer.start()

                self.state = State.REPLY

            case (State.QUERY, SlotTimerExpired()) if self._slot_number < self._slot_count - 1:
                self._slot_number += 1
                self._send_xid_command(self._slot_number)
                self._slot_timer.start()

                self.state = State.QUERY

            case (State.QUERY, SlotTimerExpired()):
                self._send_xid_command(0xFF)
                self._discovering.set_result(self._discovered[:])

                self.state = State.NDM

            case (State.QUERY, XIDResponseFrame(dst_device_address=self.src_device_address) as xid):
                self._discovered.append(xid)

                self.state = State.QUERY

            case (State.REPLY, XIDCommandFrame(slot_number=0xFF) as xid):
                self._query_timer.stop()
                logger.debug("Announced ourselves to %s", xid.discovery_info)

                self.state = State.NDM

            case (State.REPLY, XIDCommandFrame() as xid) if xid.slot_number >= self._slot and not self._frame_sent:
                self._send_xid_response(xid)
                self._frame_sent = True

                self.state = State.REPLY

            case (State.REPLY, QueryTimerExpired()):
                self.state = State.NDM

            case (State.QUERY | State.REPLY, Frame()):
                self.state = state

            # --- CONNECTION ---

            case (State.NDM, ConnectRequest(address=address)):
                self.connection_address = random.getrandbits(7)
                self.dst_device_address = address
                self._send_snrm()
                self._f_timer.start()
                self._retry_count = 0

                self.state = State.SETUP

            case (State.NDM, SNRMCommandFrame() as snrm):
                self.dst_device_address = snrm.src_device_address
                self.connection_address = snrm.connection_address
                self._snrm = snrm

                self.state = State.CONN

                self._dispatch(ConnectResponse())

            case (State.NDM, TESTCommandFrame() as test):
                self._send(
                    TESTResponseFrame(
                        address=BROADCAST,
                        src_device_address=self.src_device_address,
                        dst_device_address=test.src_device_address,
                        data=test.data,
                    )
                )

                self.state = State.NDM

            case (State.CONN, ConnectResponse()):
                try:
                    self._accept(self._snrm)

                except NegotiationError:
                    logger.exception("Negotiation failed")
                    self._send(DMResponseFrame(address=self.connection_address))

                    self.state = State.NDM

                else:
                    self._wd_timer.start()

                    self.state = Secondary.RECV

            case (State.SETUP, FTimerExpired()) if self._retry_count < RETRY_COUNT:
                self._send_snrm()
                self._f_timer.start()
                self._retry_count += 1

                self.state = State.SETUP

            case (State.SETUP, FTimerExpired()):
                self._disconnect_indication()

                self.state = State.NDM

            case (State.SETUP, SNRMCommandFrame() as snrm) if snrm.src_device_address > self.src_device_address:
                self._f_timer.stop()
                self.connection_address = snrm.connection_address
                self._accept(snrm)
                self._wd_timer.start()

                self.state = Secondary.RECV

            case (State.SETUP, UAResponseFrame() as ua):
                self._f_timer.stop()
                _, self.theirs = self.capabilities.negotiate(ua.negotiation_parameters)
                self._initialize_connection_state()
                self._connect()
                self._send(RRFrame(address=self.connection_address, command=True, nr=self.vr))
                self._f_timer.start()

                self.state = Primary.RECV

            case (State.SETUP, DMResponseFrame() | DISCCommandFrame()):
                self._f_timer.stop()
                self._disconnect_indication()

                self.state = State.NDM

            # --- NRM(P) ---

            case (Primary.XMIT, DataRequest()) if not self._remote_busy:
                self._p_timer.stop()
                self._send_data()
                self._f_timer.start()

                self.state = Primary.RECV

            case (Primary.XMIT, DisconnectRequest()) if not self._pending or self._remote_busy:
                self._p_timer.stop()
                self._send(DISCCommandFrame(address=self.connection_address))
                self._f_timer.start()
                self._retry_count = 0

                self.state = Primary.PCLOSE

            case (Primary.XMIT, PTimerExpired()):
                self._send(RRFrame(address=self.connection_address, command=True, nr=self.vr))
                self._f_timer.start()

                self.state = Primary.RECV

            case (Primary.RECV, IFrame(command=False) | SFrame(command=False) as f) if not self._valid_nr(f.nr):
                if f.pf:
                    self._send(DISCCommandFrame(address=self.connection_address))
                    self._f_timer.start()
                    self._retry_count = 0

                    self.state = Primary.PCLOSE

                else:
                    self.state = Primary.PCLOSE_WAIT

            case (Primary.RECV, IFrame(command=False, pf=False, ns=self.vr) as i):
                self._data_indication(i.information)
                self.vr = (self.vr + 1) % 8
                self._ack(i.nr)

                self.state = Primary.RECV

            case (Primary.RECV, IFrame(command=False, pf=True, ns=self.vr, nr=self.vs) as i):
                self._f_timer.stop()
                self._data_indication(i.information)
                self.vr = (self.vr + 1) % 8
                self._ack(i.nr)
                self._p_timer.start()

                self.state = Primary.XMIT

            case (Primary.RECV, IFrame(command=False, pf=True, ns=self.vr) as i):
                self._data_indication(i.information)
                self.vr = (self.vr + 1) % 8
                self._ack(i.nr)
                self._resend()
                self._f_timer.start()

                self.state = Primary.RECV

            case (Primary.RECV, IFrame(command=False, pf=False) as i):
                self._ack(i.nr)

                self.state = Primary.RECV

            case (Primary.RECV, IFrame(command=False, pf=True) as i):
                self._ack(i.nr)
                self._send(RRFrame(address=self.connection_address, command=True, nr=self.vr))
                self._f_timer.start()

                self.state = Primary.RECV

            case (Primary.RECV, RRFrame(command=False, pf=True, nr=self.vs) as rr):
                self._f_timer.stop()
                self._remote_busy = False
                self._ack(rr.nr)
                self._p_timer.start()

                self.state = Primary.XMIT

            case (Primary.RECV, RRFrame(command=False, pf=True) as rr):
                self._remote_busy = False
                self._ack(rr.nr)
                self._resend()
                self._f_timer.start()

                self.state = Primary.RECV

            case (Primary.RECV, REJFrame(command=False, pf=True) as rej):
                self._ack(rej.nr)

                if self._remote_busy:
                    self._send(RRFrame(address=self.connection_address, command=True, nr=self.vr))
                else:
                    self._resend()

                self._f_timer.start()

                self.state = Primary.RECV

            case (Primary.RECV, SREJFrame(command=False, pf=True) as srej):
                self._ack(srej.nr)

                if self._remote_busy:
                    self._send(RRFrame(address=self.connection_address, command=True, nr=self.vr))
                else:
                    self._resend(srej.nr)

                self._f_timer.start()

                self.state = Primary.RECV

            case (Primary.RECV, RNRFrame(command=False, pf=True) as rnr):
                self._f_timer.stop()
                self._remote_busy = True
                self._ack(rnr.nr)
                self._p_timer.start()

                self.state = Primary.XMIT

            case (Primary.RECV, UIResponseFrame(pf=False) as ui):
                self._unitdata_indication(ui.information)

                self.state = Primary.RECV

            case (Primary.RECV, UIResponseFrame(pf=True) as ui):
                self._f_timer.stop()
                self._unitdata_indication(ui.information)
                self._p_timer.start()

                self.state = Primary.XMIT

            case (Primary.RECV, FRMRResponseFrame() | RDResponseFrame() | RNRMResponseFrame()):
                self._send(DISCCommandFrame(address=self.connection_address))
                self._f_timer.start()
                self._retry_count = 0

                self.state = Primary.PCLOSE

            case (Primary.RECV, FTimerExpired()) if self._retry_count < self._n2:
                self._send(RRFrame(address=self.connection_address, command=True, nr=self.vr))
                self._f_timer.start()
                self._retry_count += 1

                self.state = Primary.RECV

            case (Primary.RECV, FTimerExpired()):
                self._disconnect_indication(ConnectionResetError("No response"))

                self.state = State.NDM

            case (Primary.RECV | Primary.PCLOSE_WAIT | Primary.PCLOSE, SFrame(command=True) | IFrame(command=True)):
                self._f_timer.stop()
                self._disconnect_indication(ConnectionResetError("Primary conflict"))

                self.state = State.NDM

            case (Primary.RECV, Frame(pf=False)):
                self.state = Primary.RECV

            case (Primary.RECV, Frame(pf=True)):
                self._f_timer.stop()
                self._p_timer.start()

                self.state = Primary.XMIT

            case (Primary.PCLOSE_WAIT, FTimerExpired() | Frame(pf=True)):
                self._send(DISCCommandFrame(address=self.connection_address))
                self._f_timer.start()
                self._retry_count = 0

                self.state = Primary.PCLOSE

            case (Primary.PCLOSE_WAIT, Frame(pf=False)):
                self.state = Primary.PCLOSE_WAIT

            case (Primary.PCLOSE, UAResponseFrame() | DMResponseFrame()):
                self._f_timer.stop()
                self._disconnect_indication()

                self.state = State.NDM

            case (Primary.PCLOSE, FTimerExpired()) if self._retry_count < RETRY_COUNT:
                self._send(DISCCommandFrame(address=self.connection_address))
                self._f_timer.start()
                self._retry_count += 1

                self.state = Primary.PCLOSE

            case (Primary.PCLOSE, FTimerExpired()):
                self._disconnect_indication()

                self.state = State.NDM

            case (Primary.PCLOSE, Frame()):
                self.state = Primary.PCLOSE

            # --- NRM(S) ---

            case (Secondary.XMIT, DataRequest()) if not self._remote_busy:
                self._send_data()
                self._wd_timer.start()

                self.state = Secondary.RECV

            case (Secondary.XMIT, DisconnectRequest()) if not self._pending or self._remote_busy:
                self._send(RDResponseFrame(address=self.connection_address))
                self._wd_timer.start()

                self.state = Secondary.SCLOSE

            case (Secondary.RECV, IFrame(command=True) | SFrame(command=True) as f) if not self._valid_nr(f.nr):
                self._frmr = FRMRResponseFrame(
                    address=self.connection_address,
                    rejected_control=f.control,
                    ns=self.vs,
                    cr=f.command,
                    nr=self.vr,
                    z=True,
                )

                if f.pf:
                    self._send(self._frmr)
                    self._wd_timer.start()

                    self.state = Secondary.RECV

                else:
                    self.state = Secondary.ERROR

            case (Secondary.RECV, IFrame(command=True, pf=False, ns=self.vr) as i):
                self._data_indication(i.information)
                self.vr = (self.vr + 1) % 8
                self._ack(i.nr)

                self.state = Secondary.RECV

            case (Secondary.RECV, IFrame(command=True, pf=True, ns=self.vr, nr=self.vs) as i) if self._requests_pending:
                self._data_indication(i.information)
                self.vr = (self.vr + 1) % 8
                self._ack(i.nr)
                self._wd_timer.stop()

                self.state = Secondary.XMIT

            case (Secondary.RECV, IFrame(command=True, pf=True, ns=self.vr, nr=self.vs) as i):
                self._data_indication(i.information)
                self.vr = (self.vr + 1) % 8
                self._ack(i.nr)
                self._send(RRFrame(address=self.connection_address, command=False, nr=self.vr))
                self._wd_timer.start()

                self.state = Secondary.RECV

            case (Secondary.RECV, IFrame(command=True, pf=True, ns=self.vr) as i):
                self._data_indication(i.information)
                self.vr = (self.vr + 1) % 8
                self._ack(i.nr)
                self._resend()
                self._wd_timer.start()

                self.state = Secondary.RECV

            case (Secondary.RECV, IFrame(command=True, pf=False) as i):
                self._ack(i.nr)

                self.state = Secondary.RECV

            case (Secondary.RECV, IFrame(command=True, pf=True) as i):
                self._ack(i.nr)
                self._send(RRFrame(address=self.connection_address, command=False, nr=self.vr))
                self._wd_timer.start()

                self.state = Secondary.RECV

            case (Secondary.RECV, RRFrame(command=True, pf=True, nr=self.vs) as rr) if self._requests_pending:
                self._remote_busy = False
                self._ack(rr.nr)
                self._wd_timer.stop()

                self.state = Secondary.XMIT

            case (Secondary.RECV, RRFrame(command=True, pf=True, nr=self.vs) as rr):
                self._remote_busy = False
                self._ack(rr.nr)
                self._send(RRFrame(address=self.connection_address, command=False, nr=self.vr))
                self._wd_timer.start()

                self.state = Secondary.RECV

            case (Secondary.RECV, RRFrame(command=True, pf=True) as rr):
                self._remote_busy = False
                self._ack(rr.nr)
                self._resend()
                self._wd_timer.start()

                self.state = Secondary.RECV

            case (Secondary.RECV, REJFrame(command=True, pf=True) as rej):
                self._ack(rej.nr)

                if self._remote_busy:
                    self._send(RRFrame(address=self.connection_address, command=False, nr=self.vr))
                else:
                    self._resend()

                self._wd_timer.start()

                self.state = Secondary.RECV

            case (Secondary.RECV, SREJFrame(command=True, pf=True) as srej):
                self._ack(srej.nr)

                if self._remote_busy:
                    self._send(RRFrame(address=self.connection_address, command=False, nr=self.vr))
                else:
                    self._resend(srej.nr)

                self._wd_timer.start()

                self.state = Secondary.RECV

            case (Secondary.RECV, RNRFrame(command=True, pf=True) as rnr):
                self._remote_busy = True
                self._ack(rnr.nr)
                self._send(RRFrame(address=self.connection_address, command=False, nr=self.vr))
                self._wd_timer.start()

                self.state = Secondary.RECV

            case (Secondary.RECV, UICommandFrame(pf=False) as ui):
                self._unitdata_indication(ui.information)

                self.state = Secondary.RECV

            case (Secondary.RECV, UICommandFrame(pf=True) as ui) if self._requests_pending:
                self._unitdata_indication(ui.information)
                self._wd_timer.stop()

                self.state = Secondary.XMIT

            case (Secondary.RECV, UICommandFrame(pf=True) as ui):
                self._unitdata_indication(ui.information)
                self._send(RRFrame(address=self.connection_address, command=False, nr=self.vr))
                self._wd_timer.start()

                self.state = Secondary.RECV

            case (Secondary.RECV, TESTCommandFrame(pf=True) as test):
                self._send(TESTResponseFrame(address=self.connection_address, data=test.data))
                self._wd_timer.start()

                self.state = Secondary.RECV

            case (Secondary.RECV | Secondary.ERROR, DISCCommandFrame(pf=True)):
                self._send(UAResponseFrame(address=self.connection_address))
                self._wd_timer.stop()
                self._disconnect_indication()

                self.state = State.NDM

            case (Secondary.RECV, SNRMCommandFrame(pf=True)):
                self._send(RDResponseFrame(address=self.connection_address))
                self._wd_timer.start()

                self.state = Secondary.SCLOSE

            case (Secondary.RECV, WDTimerExpired()) if self._retry_count < self._n2:
                self._retry_count += 1
                self._wd_timer.start()

                self.state = Secondary.RECV

            case (Secondary.RECV, WDTimerExpired()):
                self._disconnect_indication(ConnectionResetError("No response"))

                self.state = State.NDM

            case (Secondary.RECV | Secondary.SCLOSE, SFrame(command=False) | IFrame(command=False)):
                self._wd_timer.stop()
                self._disconnect_indication(ConnectionResetError("Primary conflict"))

                self.state = State.NDM

            case (Secondary.RECV, Frame()):
                self.state = Secondary.RECV

            case (Secondary.ERROR, Frame(pf=True)):
                self._send(self._frmr)
                self._wd_timer.start()

                self.state = Secondary.RECV

            case (Secondary.ERROR, Frame(pf=False)):
                self.state = Secondary.ERROR

            case (Secondary.SCLOSE, DISCCommandFrame(pf=True)):
                self._wd_timer.stop()
                self._send(UAResponseFrame(address=self.connection_address))
                self._disconnect_indication()

                self.state = State.NDM

            case (Secondary.SCLOSE, DMResponseFrame()):
                self._wd_timer.stop()
                self._disconnect_indication()

                self.state = State.NDM

            case (Secondary.SCLOSE, Frame(pf=True)):
                self._send(RDResponseFrame(address=self.connection_address))
                self._wd_timer.start()

                self.state = Secondary.SCLOSE

            case (Secondary.SCLOSE, Frame(pf=False)):
                self.state = Secondary.SCLOSE

            case (Secondary.SCLOSE, WDTimerExpired()):
                self._disconnect_indication()

                self.state = State.NDM

            case (_, Request()):
                pass

            case _:
                logger.debug("Ignoring %s in %s", trigger, state)

        logger.debug("<--> %s", self.state)

        if self.state in (Primary.XMIT, Secondary.XMIT) and self.state is not state:
            self._service_pending_requests()

    def _service_pending_requests(self) -> None:
        if self._pending and not self._remote_busy:
            self._dispatch(DataRequest())

        elif self._closing:
            self._dispatch(DisconnectRequest())

    # --- predicates ---

    @property
    def connected(self) -> bool:
        return isinstance(self.state, Primary | Secondary)

    @property
    def _requests_pending(self) -> bool:
        return self._closing or (bool(self._pending) and not self._remote_busy)

    @property
    def _n2(self) -> int:
        timeout = F_TIMEOUT if isinstance(self.state, Primary) else WD_TIMEOUT

        return ceil(self.theirs.link_disconnect_secs / timeout)

    def _valid_nr(self, nr: int) -> bool:
        return nr == self.vs or any(frame.ns == nr for frame in self._store)

    # --- actions ---

    def _send_xid_command(self, slot_number: int) -> None:
        self._send(
            XIDCommandFrame(
                src_device_address=self.src_device_address,
                dst_device_address=XID_BROADCAST,
                generate_new_address=False,
                slot_count=self._slot_count,
                slot_number=slot_number,
                discovery_info=self.discovery_info if slot_number == 0xFF else b"",
            )
        )

    def _send_xid_response(self, xid: XIDCommandFrame) -> None:
        self._send(
            XIDResponseFrame(
                src_device_address=self.src_device_address,
                dst_device_address=xid.src_device_address,
                generate_new_address=False,
                slot_count=xid.slot_count,
                slot_number=self._slot,
                discovery_info=self.discovery_info,
            )
        )

    def _send_snrm(self) -> None:
        self._send(
            SNRMCommandFrame(
                address=BROADCAST,
                src_device_address=self.src_device_address,
                dst_device_address=self.dst_device_address,
                connection_address=self.connection_address,
                negotiation_parameters=self.capabilities,
            )
        )

    def _accept(self, snrm: SNRMCommandFrame) -> None:
        ours, self.theirs = self.capabilities.negotiate(snrm.negotiation_parameters)
        self._initialize_connection_state()
        self._connect()
        self._send(
            UAResponseFrame(
                address=self.connection_address,
                src_device_address=self.src_device_address,
                dst_device_address=self.dst_device_address,
                negotiation_parameters=ours,
            )
        )

    def _initialize_connection_state(self) -> None:
        self.vs = 0
        self.vr = 0
        self._store.clear()
        self._remote_busy = False
        self._retry_count = 0

    def _take_window(self) -> list[bytes]:
        budget = BAUD_RATE * self.theirs.max_turn_around_ms // 10_000
        overhead = FRAME_OVERHEAD + len(self._bofs())
        window = [self._pending.popleft()]

        while self._pending and len(window) < self.theirs.window_size:
            budget -= len(window[-1]) + overhead

            if budget < len(self._pending[0]) + overhead:
                break

            window.append(self._pending.popleft())

        return window

    def _send_data(self) -> None:
        window = self._take_window()

        for data in window:
            frame = IFrame(
                address=self.connection_address,
                command=isinstance(self.state, Primary),
                ns=self.vs,
                nr=self.vr,
                information=data,
                pf=data is window[-1],
            )
            self._store.append(frame)
            self._send(frame)
            self.vs = (self.vs + 1) % 8

    def _ack(self, nr: int) -> None:
        while self._store and self._store[0].ns != nr:
            self._store.popleft()

    def _resend(self, nr: int | None = None) -> None:
        frames = [frame for frame in self._store if nr is None or frame.ns == nr]

        if not frames:
            frames = [RRFrame(address=self.connection_address, command=isinstance(self.state, Primary), nr=self.vr)]

        for frame in frames:
            frame.pf = frame is frames[-1]
            self._send(frame)

    def _connect(self) -> None:
        self.link = Link(self)
        self.protocol = self.protocol_factory()
        asyncio.get_running_loop().call_soon(self.protocol.connection_made, self.link)

        if self._connecting:
            self._connecting.set_result((self.link, self.protocol))
            self._connecting = None

    def _disconnect_indication(self, exc: Exception | None = None) -> None:
        self.theirs = CONTENTION
        self.connection_address = None
        self._store.clear()
        self._pending.clear()
        self._closing = False

        if self._connecting:
            self._connecting.set_exception(exc or ConnectionRefusedError())
            self._connecting = None

        if self.link:
            self.protocol.connection_lost(exc)
            self.link = None
            self.protocol = None

    def _data_indication(self, data: bytes) -> None:
        self.protocol.data_received(bytes(data))

    def _unitdata_indication(self, data: bytes) -> None:
        logger.info("Received unit data %s", bytes(data))


def _stuff_bytes(data: bytes) -> bytes:
    out = bytearray()

    for b in data:
        if b in (BOF, EOF, CE):
            out += bytes([CE, b ^ 0x20])
        else:
            out.append(b)

    return bytes(out)


def _unstuff_bytes(data: bytes) -> bytes:
    out = bytearray()
    i = iter(data)

    for b in i:
        out.append(next(i) ^ 0x20 if b == CE else b)

    return bytes(out)


def _frame_to_bytes(frame: Frame) -> bytes:
    fcs = crc.checksum(frame.payload)
    raw = bytes(frame.payload) + fcs.to_bytes(2, byteorder="little")

    return bytes([BOF]) + _stuff_bytes(raw) + bytes([EOF])
