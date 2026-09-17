import asyncio
import logging
import random
from asyncio import Transport
from collections import deque
from enum import Enum, auto
from math import ceil
from typing import Callable

from crc import Calculator, Crc16

from pyirda.irlap.events import (
    Event,
    DiscoveryRequest,
    ConnectRequest,
    ConnectResponse,
    DisconnectRequest,
    DataRequest,
    ResetRequest,
)
from pyirda.irlap.negotiation import NegotiationParameters, NegotiationError
from pyirda.timer import Timer
from pyirda.irlap.constants import (
    BOF,
    CE,
    EOF,
    XBOF,
    SLOT_TIMEOUT,
    XID_BROADCAST,
    QUERY_TIMEOUT,
    BROADCAST,
    P_TIMEOUT,
    WD_TIMEOUT,
    RETRY_COUNT,
)
from pyirda.irlap.frame import (
    Frame,
    XIDResponseFrame,
    XIDCommandFrame,
    SNRMCommandFrame,
    TESTCommandFrame,
    TESTResponseFrame,
    UAResponseFrame,
    DMResponseFrame,
    RRFrame,
    DISCCommandFrame,
    IFrame,
    UIResponseFrame,
    REJFrame,
    SREJFrame,
    RNRFrame,
    FRMRResponseFrame,
    RDResponseFrame,
    RNRMResponseFrame,
    SFrame,
)

logger = logging.getLogger(__name__)

crc = Calculator(Crc16.X25.value, optimized=True)


def _stuff_bytes(data: bytes) -> bytes:
    out = bytearray()

    for b in data:
        if b in (BOF, EOF, CE):
            out.append(CE)
            out.append(b ^ 0x20)
        else:
            out.append(b)

    return bytes(out)


def _unstuff_bytes(data: bytes) -> bytes:
    out = bytearray()
    i = iter(data)

    for b in i:
        if b == CE:
            b = next(i) ^ 0x20
        out.append(b)

    return bytes(out)


class State(Enum):
    _BUSY = auto()
    NDM = auto()
    QUERY = auto()
    REPLY = auto()
    CONN = auto()
    SETUP = auto()
    # NRMP = auto()
    # NRMS = auto()
    XMIT = auto()
    RECV = auto()
    PCLOSE_WAIT = auto()
    RESET_WAIT = auto()
    RESET_CHECK = auto()
    RESET = auto()
    BUSY = auto()
    BUSY_WAIT = auto()
    PCLOSE = auto()


class IrLAP(asyncio.Protocol):
    DEFAULT_WINDOW_SIZE = 1
    MAX_RETRIES = 3

    class SlotTimer(Timer):
        def __init__(self, dispatch: Callable) -> None:
            super().__init__(SLOT_TIMEOUT, dispatch)

    class QueryTimer(Timer):
        def __init__(self, dispatch: Callable) -> None:
            super().__init__(QUERY_TIMEOUT, dispatch)

    class PFTimer(Timer):
        def __init__(self, dispatch: Callable) -> None:
            super().__init__(P_TIMEOUT, dispatch)

    class WDTimer(Timer):
        def __init__(self, dispatch: Callable) -> None:
            super().__init__(WD_TIMEOUT, dispatch)

    def __init__(self, discovery_info: bytes = b"\x80 \x00TMGC", slots: int = 6) -> None:
        self.transport: Transport | None = None

        self.discovery_info = discovery_info

        self.ready: asyncio.Event = asyncio.Event()

        self._rx = bytearray()

        self.vs = 0
        self.vr = 0

        self.connection_address: int | None = None
        self.src_device_address: int = random.getrandbits(32)
        self.dst_device_address: int | None = None

        self.window_size = self.DEFAULT_WINDOW_SIZE
        self.max_turn_around_time = 500  # ms
        self.data_size = 64  # bytes
        self.baud_rate = 9600
        self.additional_bofs = 10

        self.ours = NegotiationParameters()
        self.theirs = NegotiationParameters()

        self.p_bit_outstanding = False

        self.state: State = State.NDM
        self._state_changed: asyncio.Event = asyncio.Event()
        self._free: asyncio.Event = asyncio.Event()
        self._free.set()
        self._primary: bool = True

        self._tx_queue: deque[bytes] = deque()
        self.rx_queue: asyncio.Queue[bytes] = asyncio.Queue()

        self._retry_count = 0

        self._slot_timer: Timer = self.SlotTimer(self._dispatch)
        self._query_timer: Timer = self.QueryTimer(self._dispatch)
        self._slot_count = slots
        self._slot_number = 0
        self._slot = 0
        self._frame_sent = False
        self._discovered: list[XIDResponseFrame] = []
        self._discovery_completed: asyncio.Event = asyncio.Event()
        self._discovery_completed.set()

        self._pf_timer: Timer = self.PFTimer(self._dispatch)
        self._wd_timer: Timer = self.WDTimer(self._dispatch)
        self._received_snrm: SNRMCommandFrame | None = None
        self._connect_completed: asyncio.Event = asyncio.Event()
        self._connect_completed.set()

        self._remote_busy = False
        self._window = 0
        self._ack_required = False

    def connection_made(self, transport: Transport) -> None:
        self.ready.set()
        self.transport = transport

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
            # Skip leading XBOFs and find BOF
            start = self._rx.find(BOF)
            if start == -1:
                self._rx.clear()
                break

            # Discard anything before the BOF
            if start > 0:
                del self._rx[:start]

            # Find EOF after the BOF
            end = self._rx.find(EOF, 1)
            if end == -1:
                break  # incomplete frame, wait for more data

            raw = bytes(self._rx[1:end]).strip(bytes([XBOF, BOF]))
            del self._rx[: end + 1]

            try:
                payload = _unstuff_bytes(raw)
                data, fcs_bytes = payload[:-2], payload[-2:]
                fcs_received = int.from_bytes(fcs_bytes, "little")
                fcs_computed = crc.checksum(data)
                if fcs_received != fcs_computed:
                    continue
                frames.append(Frame.parse(data))
            except Exception:
                continue

        return frames

    def _dispatch(self, trigger: Frame | Event | Timer) -> None:
        state = self.state
        # self.state = State._BUSY
        self._free.clear()
        logger.debug("---> %s", trigger)
        match (state, trigger):
            # --- DISCOVERY ---
            case (State.NDM, DiscoveryRequest()) if self._discovery_completed.is_set():
                self._discovery_completed.clear()
                self._slot_number = 0
                self._send(
                    XIDCommandFrame(
                        src_device_address=self.src_device_address,
                        dst_device_address=XID_BROADCAST,
                        generate_new_address=False,
                        slot_count=self._slot_count,
                        slot_number=self._slot_number,
                    )
                )
                self._discovered.clear()
                self._slot_timer.start()

                self.state = State.QUERY

            case (State.NDM, XIDCommandFrame() as other):
                self._slot = random.randint(other.slot_number, other.slot_count - 1)
                if self._slot == other.slot_number:
                    self._send(
                        XIDResponseFrame(
                            src_device_address=self.src_device_address,
                            dst_device_address=other.src_device_address,
                            generate_new_address=False,
                            slot_count=other.slot_count,
                            slot_number=self._slot,
                            discovery_info=self.discovery_info,
                        )
                    )
                    self._frame_sent = True
                else:
                    self._frame_sent = False
                self._query_timer.start()

                self.state = State.REPLY

            case (State.QUERY, self.SlotTimer()) if self._slot_number < self._slot_count - 1:
                self._slot_number += 1
                self._send(
                    XIDCommandFrame(
                        src_device_address=self.src_device_address,
                        dst_device_address=XID_BROADCAST,
                        generate_new_address=False,
                        slot_count=self._slot_count,
                        slot_number=self._slot_number,
                    )
                )
                self._slot_timer.start()

                self.state = State.QUERY

            case (State.QUERY, self.SlotTimer()) if self._slot_number >= self._slot_count - 1:
                self._send(
                    XIDCommandFrame(
                        src_device_address=self.src_device_address,
                        dst_device_address=XID_BROADCAST,
                        generate_new_address=False,
                        slot_count=self._slot_count,
                        slot_number=0xFF,
                        discovery_info=self.discovery_info,
                    )
                )
                self._discovery_completed.set()

                self.state = State.NDM

            case (State.QUERY, XIDResponseFrame(dst_device_address=self.src_device_address) as other):
                self._discovered.append(other)

                self.state = State.QUERY

            case (State.QUERY, _):
                pass

            case (State.REPLY, XIDCommandFrame(slot_number=0xFF) as other):
                self._query_timer.stop()
                logger.debug("Announced ourselves to %s", other.discovery_info)

                self.state = State.NDM

            case (State.REPLY, XIDCommandFrame() as other) if other.slot_number >= self._slot and not self._frame_sent:
                self._send(
                    XIDResponseFrame(
                        src_device_address=self.src_device_address,
                        dst_device_address=other.src_device_address,
                        generate_new_address=False,
                        slot_count=other.slot_count,
                        slot_number=self._slot,
                        discovery_info=self.discovery_info,
                    )
                )
                self._frame_sent = True

                self.state = State.REPLY

            case (State.REPLY, self.QueryTimer()):
                self.state = State.NDM

            case (State.REPLY, _):
                pass

            # --- CONNECTION ---
            case (State.NDM, ConnectRequest(address=address)):
                self._connect_completed.clear()
                self.connection_address = random.getrandbits(7)
                self.dst_device_address = address

                self._send(
                    SNRMCommandFrame(
                        address=BROADCAST,
                        src_device_address=self.src_device_address,
                        dst_device_address=self.dst_device_address,
                        connection_address=self.connection_address,
                        negotiation_parameters=self.ours,
                    )
                )

                self._pf_timer.start()
                self._retry_count = 0

                self.state = State.SETUP

            case (State.NDM, SNRMCommandFrame() as frame):
                logger.debug("Received request to connect from %s", frame.dst_device_address)
                self._connect_completed.clear()

                self.dst_device_address = frame.src_device_address
                self.connection_address = frame.connection_address
                self._received_snrm = frame

                self.state = State.CONN

                self._dispatch(ConnectResponse())

            case (State.NDM, TESTCommandFrame() as frame):
                self._send(
                    TESTResponseFrame(
                        address=BROADCAST,
                        src_device_address=self.src_device_address,
                        dst_device_address=self.dst_device_address,
                        data=frame.data,
                    )
                )

                self.state = State.NDM

            case (State.NDM, _):
                pass

            case (State.CONN, ConnectResponse()):
                try:
                    ours, theirs = self.ours.negotiate(self._received_snrm.negotiation_parameters)

                except NegotiationError:
                    logger.exception("Negotiation failed")
                    self._connect_completed.set()
                    self.state = State.NDM

                else:
                    self.vr = 0
                    self.vs = 0
                    self.window_size = theirs.window_size
                    self._window = theirs.window_size
                    self._retry_count = 0

                    self._send(
                        UAResponseFrame(
                            address=self.connection_address,
                            src_device_address=self.src_device_address,
                            dst_device_address=self.dst_device_address,
                            negotiation_parameters=ours,
                        )
                    )

                    self.ours = ours
                    self.theirs = theirs

                    self._connect_completed.set()
                    self._wd_timer.start()

                    self._primary = False
                    self.state = State.RECV

            case (State.CONN, DisconnectRequest()):
                self._send(DMResponseFrame(address=self.connection_address))

                self._connect_completed.set()

                self.state = State.NDM

            case (State.CONN, _):
                pass

            case (State.SETUP, self.PFTimer()) if self._retry_count < RETRY_COUNT:
                # TODO: random backoff
                self._send(
                    SNRMCommandFrame(
                        address=BROADCAST,
                        src_device_address=self.src_device_address,
                        dst_device_address=self.dst_device_address,
                        connection_address=self.connection_address,
                        negotiation_parameters=self.ours,
                    )
                )
                self._pf_timer.start()
                self._retry_count += 1

                self.state = State.SETUP

            case (State.SETUP, self.PFTimer()) if self._retry_count >= RETRY_COUNT:
                self._connect_completed.set()
                self.state = State.NDM

            case (State.SETUP, SNRMCommandFrame() as frame) if frame.src_device_address > self.src_device_address:
                self._pf_timer.stop()

                try:
                    ours, theirs = self.ours.negotiate(frame.negotiation_parameters)

                except NegotiationError:
                    logger.exception("Negotiation failed")
                    self._connect_completed.set()
                    self.state = State.NDM

                else:
                    self.vr = 0
                    self.vs = 0
                    self.window_size = theirs.window_size
                    self._window = theirs.window_size
                    self._retry_count = 0

                    self._send(
                        UAResponseFrame(
                            address=self.connection_address,
                            src_device_address=self.src_device_address,
                            dst_device_address=self.dst_device_address,
                            negotiation_parameters=ours,
                        )
                    )

                    self.ours = ours
                    self.theirs = theirs

                    self._connect_completed.set()
                    self._wd_timer.start()

                    self._primary = False
                    self.state = State.RECV

            case (State.SETUP, SNRMCommandFrame() as frame) if frame.src_device_address < self.src_device_address:
                # the small cat yields to the big cat
                self.state = State.SETUP

            case (State.SETUP, UAResponseFrame() as frame):
                self._pf_timer.stop()

                try:
                    ours, theirs = self.ours.negotiate(frame.negotiation_parameters)

                except NegotiationError:
                    logger.exception("Negotiation failed")
                    self._connect_completed.set()
                    self.state = State.NDM

                else:
                    self.vr = 0
                    self.vs = 0
                    self.window_size = theirs.window_size
                    self._window = theirs.window_size
                    self._retry_count = 0

                    self._connect_completed.set()

                    self._send(
                        RRFrame(
                            address=self.connection_address,
                            command=True,
                            nr=self.vr,
                        )
                    )

                    self._pf_timer.start()

                    self._primary = True
                    self.state = State.RECV

            case (State.SETUP, DMResponseFrame()):
                self._pf_timer.stop()
                self._connect_completed.set()

                self.state = State.NDM

            case (State.SETUP, DISCCommandFrame()):
                self._pf_timer.stop()
                self._connect_completed.set()

                self.state = State.NDM

            case (State.SETUP, _):
                pass

            # --- NRM(P) ---

            case (State.XMIT, DataRequest(data=data)) if self._primary and not self._remote_busy and self._window > 1:
                # TODO: implement
                ...

                self.state = State.RECV

            case (State.XMIT, DataRequest(data=data)) if self._primary and not self._remote_busy and self._window == 1:
                # TODO: implement
                ...

                self.state = State.RECV

            case (State.XMIT, ResetRequest()) if self._primary:
                self._pf_timer.stop()
                self._wait_minimum_turnaround_delay()
                self._send(SNRMCommandFrame(address=self.connection_address))
                self._retry_count = 0
                self._pf_timer.start()

                self.state = State.RESET

            case (State.XMIT, DisconnectRequest()) if self._primary:
                self._pf_timer.stop()
                self._wait_minimum_turnaround_delay()
                self._send(DISCCommandFrame(address=self.connection_address))
                self._retry_count = 0
                self._pf_timer.start()

                self.state = State.PCLOSE

            case (State.XMIT, self.PFTimer()) if self._primary:
                self._send(
                    RRFrame(
                        address=self.connection_address,
                        command=True,
                        nr=self.vr,
                    )
                )

                self.state = State.RECV

            case (State.RECV, IFrame(command=False, pf=False, ns=self.vr, nr=self.vs) as i) if self._primary:
                self._recv(i.information)
                self.vr = (self.vr + 1) & 0b111
                self._ack(i.nr)
                self._ack_required = True

                self.state = State.RECV

            case (State.RECV, IFrame(command=False, pf=True, ns=self.vr, nr=self.vs) as i) if self._primary:
                self._pf_timer.stop()
                self._recv(i.information)
                self.vr = (self.vr + 1) & 0b111
                self._ack(i.nr)
                self._ack_required = True

                self._pf_timer.start()
                self.state = State.XMIT

            case (State.RECV, UIResponseFrame(pf=False) as ui) if self._primary:
                self._recv_unit(ui.information)

                self.state = State.RECV

            case (State.RECV, UIResponseFrame(pf=True) as ui) if self._primary:
                self._pf_timer.stop()
                self._recv_unit(ui.information)

                self._pf_timer.start()
                self.state = State.XMIT

            case (State.RECV, XIDResponseFrame()) if self._primary:
                self._wait_minimum_turnaround_delay()
                self._send(RRFrame(address=self.connection_address, command=True, nr=self.vr))
                self._ack_required = False

                self._pf_timer.start()
                self.state = State.RECV

            case (State.RECV, IFrame(command=False, pf=False, nr=self.vs) as i) if self._primary:
                self._ack(i.nr)

                self.state = State.RECV

            case (State.RECV, IFrame(command=False, pf=True, nr=self.vs) as i) if self._primary:
                self._ack(i.nr)
                self._wait_minimum_turnaround_delay()
                self._send(RRFrame(address=self.connection_address, command=True, nr=self.vr))
                self._ack_required = False

                self._pf_timer.start()
                self.state = State.RECV

            case (State.RECV, IFrame(command=False, pf=True, ns=self.vr) as i) if self._primary:
                self._recv(i.information)
                self.vr = (self.vr + 1) & 0b111
                self._ack(i.nr)
                self._resend(i.nr)
                self._ack_required = False

                self._pf_timer.start()
                self.state = State.RECV

            case (State.RECV, RRFrame(command=False) as rr) if rr.nr != self.vs and self._primary:
                self._remote_busy = False
                self._ack(rr.nr)
                self._resend(rr.nr)

                self._pf_timer.start()
                self.state = State.RECV

            case (State.RECV, REJFrame(command=False) as rej) if self._primary:
                self._ack(rej.nr)

                if not self._remote_busy:
                    self._resend(rej.nr)
                else:
                    self._wait_minimum_turnaround_delay()
                    self._send(RRFrame(address=self.connection_address, command=True, nr=self.vr))

                self._pf_timer.start()
                self.state = State.RECV

            case (State.RECV, RRFrame(command=False) as rr) if self._primary:
                self._pf_timer.stop()
                self._remote_busy = False
                self._ack(rr.nr)

                self._pf_timer.start()
                self.state = State.XMIT

            case (State.RECV, SREJFrame(command=False) as srej) if self._primary:
                self._ack(srej.nr)

                if not self._remote_busy:
                    self._resend_specific(srej.nr)
                else:
                    self._wait_minimum_turnaround_delay()
                    self._send(RRFrame(address=self.connection_address, command=True, nr=self.vr))

                self._pf_timer.start()
                self.state = State.RECV

            case (State.RECV, RNRFrame(command=False) as rnr) if self._primary:
                self._pf_timer.stop()
                self._remote_busy = True
                self._ack(rnr.nr)

                self._pf_timer.start()
                self.state = State.XMIT

            case (State.RECV, FRMRResponseFrame(command=False) as frmr) if self._primary:
                self._pf_timer.stop()

                self._pf_timer.start()
                self.state = State.XMIT

            case (State.RECV, RDResponseFrame()) if self._primary:
                self._wait_minimum_turnaround_delay()
                self._send(DISCCommandFrame(address=self.connection_address))
                self._release_buffered_data()

                self._pf_timer.start()
                self._retry_count = 0
                self.state = State.PCLOSE

            case (State.RECV, RNRMResponseFrame()) if self._primary:
                self._wait_minimum_turnaround_delay()
                self._send(DISCCommandFrame(address=self.connection_address))
                self._release_buffered_data()

                self._pf_timer.start()
                self._retry_count = 0
                self.state = State.PCLOSE

            case (State.RECV, self.PFTimer()) if self._retry_count < self._retry_count_max and self._primary:
                self._wait_minimum_turnaround_delay()
                self._send(RRFrame(address=self.connection_address, command=True, nr=self.vr))

                self._retry_count += 1
                self._pf_timer.start()
                self.state = State.RECV

            case (State.RECV, self.PFTimer()) if self._retry_count >= self._retry_count_max and self._primary:
                self._apply_default_connection_parameters()

                # TODO: Disconnect-Indication
                self.state = State.NDM

            case (State.RECV, Frame(pf=False)) if self._primary:
                pass

            case (State.RECV, Frame(pf=True)) if self._primary:
                self._pf_timer.stop()
                self._pf_timer.start()
                self.state = State.XMIT

            case (State.RECV, Frame(command=True)) if self._primary:
                logger.error("Another primary in conversation.")
                self._pf_timer.stop()
                self._apply_default_connection_parameters()

                # TODO: Disconnect-Indication
                self.state = State.NDM

            case (State.RESET, UAResponseFrame()) if self._primary:
                self._pf_timer.stop()

                self.vr = 0
                self.vs = 0
                self.window_size = self.theirs.window_size
                self._window = self.theirs.window_size
                self._retry_count = 0

                # TODO: Reset-Confirm

                self._remote_busy = False

                self._pf_timer.start()
                self.state = State.XMIT

            case (State.RESET, DMResponseFrame()) if self._primary:
                self._pf_timer.stop()
                self._apply_default_connection_parameters()

                # TODO: Disconnect-Indication
                self.state = State.NDM

            case (State.RESET, Frame(command=False, pf=True)) if self._primary:
                self._wait_minimum_turnaround_delay()
                self._send(SNRMCommandFrame(address=self.connection_address))

                self._pf_timer.start()
                self.state = State.RESET

            case (State.RESET, self.PFTimer()) if self._retry_count < RETRY_COUNT and self._primary:
                self._wait_minimum_turnaround_delay()
                self._send(SNRMCommandFrame(address=self.connection_address))

                self._pf_timer.start()
                self.state = State.RESET

            case (State.RESET, self.PFTimer()) if self._retry_count >= RETRY_COUNT and self._primary:
                self._apply_default_connection_parameters()

                # TODO: Disconnect-Indication
                self.state = State.NDM

            case (State.RESET, _):
                pass

            case (
                State.PCLOSE,
                UAResponseFrame() | DMResponseFrame() | SFrame(command=True) | IFrame(command=True),
            ) if self._primary:
                self._pf_timer.stop()
                self._apply_default_connection_parameters()

                # TODO: Disconnect-Indication
                self.state = State.NDM

            case (State.PCLOSE, self.PFTimer()) if self._retry_count < RETRY_COUNT and self._primary:
                self._wait_minimum_turnaround_delay()
                self._send(DISCCommandFrame(address=self.connection_address))

                self._retry_count += 1
                self._pf_timer.start()
                self.state = State.PCLOSE

            case (State.PCLOSE, self.PFTimer()) if self._retry_count >= RETRY_COUNT and self._primary:
                self._apply_default_connection_parameters()

                # TODO: Disconnect-Indication
                self.state = State.NDM

            case _:
                logger.debug("Unhandled frame or event: %s", trigger)

        self._free.set()
        if self.state == State._BUSY:
            self.state = state

        self._state_changed.set()
        self._state_changed.clear()

        logger.debug("<--> %s", self.state)

    @property
    def _retry_count_max(self) -> int:
        return ceil(self.theirs.link_disconnect_secs // self._pf_timer.timeout)

    def _wait_minimum_turnaround_delay(self):
        # TODO: implement
        ...

    def _apply_default_connection_parameters(self):
        self.ours = NegotiationParameters()
        self.theirs = NegotiationParameters()

        self.window_size = self.DEFAULT_WINDOW_SIZE
        self.max_turn_around_time = 500  # ms
        self.data_size = 64  # bytes
        self.baud_rate = 9600
        self.additional_bofs = 10

    def _recv(self, data: bytes):
        logger.info("Received %s", data)

    def _recv_unit(self, data: bytes):
        logger.info("Received unit %s", data)

    def _ack(self, nr: int):
        # TODO: implement
        ...

    def _release_buffered_data(self):
        # TODO: implement
        ...

    def _resend(self, nr: int):
        # TODO: implement
        ...

    def _resend_specific(self, nr: int):
        # TODO: implement
        ...

    def _send(self, frame: Frame) -> None:
        if self.transport is None:
            msg = "Not connected"
            raise RuntimeError(msg)
        self.transport.write(_frame_to_bytes(frame, self.additional_bofs))

    async def discover(self) -> list[XIDResponseFrame]:
        self._dispatch(DiscoveryRequest())
        await self._discovery_completed.wait()
        return self._discovered[:]

    async def connect(self, device: XIDResponseFrame) -> None:
        self._dispatch(ConnectRequest(address=device.src_device_address))
        await self._connect_completed.wait()

    async def wait_state(self, state: State) -> None:
        while self.state != state:
            await self._state_changed.wait()

    async def send(self, data: bytes):
        await self.wait_state(State.XMIT)
        self._dispatch(DataRequest(data=data))


def _frame_to_bytes(frame: Frame, additional_bofs: int = 10) -> bytes:
    fcs = crc.checksum(frame.payload)
    raw = bytes(frame.payload) + fcs.to_bytes(2, byteorder="little")
    return additional_bofs * bytes([XBOF]) + bytes([BOF]) + _stuff_bytes(raw) + bytes([EOF])
