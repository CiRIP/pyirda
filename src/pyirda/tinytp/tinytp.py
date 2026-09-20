import asyncio
import logging
from collections import deque
from collections.abc import Callable

from pyirda.irlmp import Endpoint as LSAPEndpoint
from pyirda.irlmp import IrLMP
from pyirda.tinytp.constants import INITIAL_CREDIT, LOW_THRESHOLD, MAX_CREDIT, UNBOUNDED
from pyirda.tinytp.pdu import ConnectPDU, DataPDU

logger = logging.getLogger(__name__)

HEADER_SIZE = 1


class Endpoint(asyncio.Transport):
    def __init__(self, connection: "TTPConnection", lsap: LSAPEndpoint) -> None:
        super().__init__(
            {
                "tinytp": connection,
                "address": lsap.get_extra_info("address"),
                "data_size": connection.max_seg_size,
                "max_sdu_size": connection.tx_max_sdu_size,
                "connect_data": connection.connect_data,
            }
        )
        self._connection = connection
        self._closing = False

    def write(self, data: bytes) -> None:
        limit = self._connection.tx_max_sdu_size or self._connection.max_seg_size

        if not data or len(data) > limit:
            msg = f"SDU of {len(data)} bytes must be 1 to {limit} bytes"
            raise ValueError(msg)

        self._connection.data_request(bytes(data))

    def close(self) -> None:
        self._closing = True
        self._connection.disconnect_request()

    def is_closing(self) -> bool:
        return self._closing or not self._connection.connected


class TTPConnection(asyncio.Protocol):
    def __init__(self, protocol_factory: Callable[[], asyncio.BaseProtocol], max_sdu_size: int = 0) -> None:
        self.protocol_factory = protocol_factory
        self.rx_max_sdu_size = max_sdu_size

        self.lsap: LSAPEndpoint | None = None
        self.endpoint: Endpoint | None = None
        self.protocol: asyncio.BaseProtocol | None = None
        self.connected = False
        self.offered = False
        self.connect_data = b""

        self.send_credit = 0
        self.remote_credit = 0
        self.avail_credit = 0
        self.tx_max_sdu_size = 0
        self.max_seg_size = 0

        self._tx_queue: deque[DataPDU | None] = deque()
        self._rx_sdu = bytearray()

    def connect_pdu(self) -> ConnectPDU:
        credit = min(INITIAL_CREDIT, MAX_CREDIT)
        self.avail_credit = INITIAL_CREDIT - credit
        self.remote_credit = credit
        self.offered = True

        return ConnectPDU(credit, self.rx_max_sdu_size)

    # --- service interface ---

    def data_request(self, sdu: bytes) -> None:
        if self.tx_max_sdu_size:
            segments = [sdu[i : i + self.max_seg_size] for i in range(0, len(sdu), self.max_seg_size)]
        else:
            segments = [sdu]

        self._tx_queue.extend(DataPDU(0, segment, more=segment is not segments[-1]) for segment in segments)
        self._service()

    def disconnect_request(self) -> None:
        self._tx_queue.append(None)
        self._service()

    # --- LSAP side ---

    def connection_made(self, lsap: LSAPEndpoint) -> None:
        self.lsap = lsap
        peer = ConnectPDU.parse(lsap.get_extra_info("connect_data"))
        self.send_credit = peer.initial_credit
        self.tx_max_sdu_size = peer.max_sdu_size
        self.max_seg_size = lsap.get_extra_info("data_size") - HEADER_SIZE
        self.connect_data = peer.data

        if not self.offered:
            lsap.accept(bytes(self.connect_pdu().payload))

        self.connected = True
        self.endpoint = Endpoint(self, lsap)
        self.protocol = self.protocol_factory()
        self.protocol.connection_made(self.endpoint)

    def connection_lost(self, exc: Exception | None) -> None:
        self.connected = False
        self._tx_queue.clear()
        self.protocol.connection_lost(exc)

    def data_received(self, data: bytes) -> None:
        pdu = DataPDU.parse(data)
        logger.debug("---> %s", pdu)
        self.send_credit += pdu.delta_credit

        if pdu.data:
            self.remote_credit -= 1
            self.avail_credit += 1
            self._reassemble(pdu)

        self._service()

    # --- actions ---

    def _reassemble(self, pdu: DataPDU) -> None:
        self._rx_sdu += pdu.data

        if pdu.more and self.rx_max_sdu_size:
            return

        sdu, self._rx_sdu = bytes(self._rx_sdu), bytearray()

        if self.rx_max_sdu_size not in (0, UNBOUNDED) and len(sdu) > self.rx_max_sdu_size:
            logger.warning("Truncating %d byte SDU to %d", len(sdu), self.rx_max_sdu_size)
            sdu = sdu[: self.rx_max_sdu_size]

        self.protocol.data_received(sdu)

    def _service(self) -> None:
        while self._tx_queue and (self._tx_queue[0] is None or self.send_credit):
            pdu = self._tx_queue.popleft()

            if pdu is None:
                self.connected = False
                self._tx_queue.clear()
                self.lsap.close()
                return

            self.send_credit -= 1
            pdu.delta_credit = self._advance_credit()
            self._send(pdu)

        if (not self._tx_queue or not self.send_credit) and self.remote_credit <= LOW_THRESHOLD and self.avail_credit:
            self._send(DataPDU(self._advance_credit()))

    def _advance_credit(self) -> int:
        credit = min(self.avail_credit, MAX_CREDIT)
        self.avail_credit -= credit
        self.remote_credit += credit

        return credit

    def _send(self, pdu: DataPDU) -> None:
        logger.debug("<--- %s", pdu)
        self.lsap.write(bytes(pdu.payload))


class TinyTP:
    def __init__(self, irlmp: IrLMP) -> None:
        self.irlmp = irlmp

    async def connect(
        self,
        address: int,
        sel: int | str,
        protocol_factory: Callable[[], asyncio.BaseProtocol],
        max_sdu_size: int = 0,
        data: bytes = b"",
    ) -> tuple[Endpoint, asyncio.BaseProtocol]:
        if isinstance(sel, str):
            sel = await self.irlmp.resolve(address, sel, "IrDA:TinyTP:LsapSel")

        connection = TTPConnection(protocol_factory, max_sdu_size)
        connect_data = bytes(connection.connect_pdu().payload) + data
        await self.irlmp.connect(address, sel, lambda: connection, data=connect_data)

        return connection.endpoint, connection.protocol

    def server(
        self, protocol_factory: Callable[[], asyncio.BaseProtocol], max_sdu_size: int = 0
    ) -> Callable[[], TTPConnection]:
        return lambda: TTPConnection(protocol_factory, max_sdu_size)
