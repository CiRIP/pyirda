import asyncio
import logging
from collections import deque
from typing import TYPE_CHECKING

from pyirda.packet import Packet

from .constants import LSAP_IAS
from .pdu import CHARSETS

if TYPE_CHECKING:
    from .irlmp import IrLMP

logger = logging.getLogger(__name__)

GET_VALUE_BY_CLASS = 4
UNSUPPORTED = 0xFF

Value = int | bytes | str | None


class IAPFrame(Packet):
    def __init__(self, opcode: int, last: bool, ack: bool, data: bytes = b"") -> None:
        self.payload = bytearray(1) + data

        self.opcode = opcode
        self.last = last
        self.ack = ack

    @property
    def opcode(self) -> int:
        return self.payload[0] & 0b00111111

    @opcode.setter
    def opcode(self, value: int) -> None:
        self.payload[0] = (self.payload[0] & 0b11000000) | value

    @property
    def last(self) -> bool:
        return bool(self.payload[0] & 0b10000000)

    @last.setter
    def last(self, value: bool) -> None:
        self.payload[0] = (self.payload[0] & 0b01111111) | (0b10000000 if value else 0)

    @property
    def ack(self) -> bool:
        return bool(self.payload[0] & 0b01000000)

    @ack.setter
    def ack(self, value: bool) -> None:
        self.payload[0] = (self.payload[0] & 0b10111111) | (0b01000000 if value else 0)

    @property
    def data(self) -> bytes:
        return bytes(self.payload[1:])


def encode(value: Value) -> bytes:
    match value:
        case None:
            return bytes([0])

        case int():
            return bytes([1]) + value.to_bytes(4, "big", signed=True)

        case bytes():
            return bytes([2]) + len(value).to_bytes(2, "big") + value

        case str():
            for code in (0x00, 0x01, 0xFF):
                try:
                    encoded = value.encode(CHARSETS[code])
                except UnicodeEncodeError:
                    continue
                return bytes([3, code, len(encoded)]) + encoded

    raise TypeError(value)


def decode(data: bytes, offset: int) -> tuple[Value, int]:
    match data[offset]:
        case 0:
            return None, offset + 1

        case 1:
            return int.from_bytes(data[offset + 1 : offset + 5], "big", signed=True), offset + 5

        case 2:
            length = int.from_bytes(data[offset + 1 : offset + 3], "big")
            return bytes(data[offset + 3 : offset + 3 + length]), offset + 3 + length

        case 3:
            charset, length = data[offset + 1], data[offset + 2]
            end = offset + 3 + length
            return data[offset + 3 : end].decode(CHARSETS.get(charset, "latin-1"), errors="replace"), end

    raise ValueError(data[offset])


class IAS:
    def __init__(self, irlmp: "IrLMP", nickname: str) -> None:
        self.irlmp = irlmp
        self.objects: dict[str, dict[str, Value]] = {
            "Device": {"DeviceName": nickname, "IrLMPSupport": b"\x01\x00\x00"}
        }

        irlmp.listeners[LSAP_IAS] = lambda: IASServer(self)

    async def get_value_by_class(self, address: int, class_name: str, attribute: str) -> list[tuple[int, Value]]:
        endpoint, client = await self.irlmp.connect(address, LSAP_IAS, IASClient)
        args = _octets(class_name) + _octets(attribute)

        try:
            result = await client.call(GET_VALUE_BY_CLASS, args)
        finally:
            endpoint.close()

        if result[0] != 0:
            return []

        values, offset = [], 3
        for _ in range(int.from_bytes(result[1:3], "big")):
            value, end = decode(result, offset + 2)
            values.append((int.from_bytes(result[offset : offset + 2], "big"), value))
            offset = end

        return values

    def get_value_by_class_local(self, class_name: bytes, attribute: bytes) -> bytes:
        attributes = self.objects.get(class_name.decode("ascii", errors="replace"))
        if attributes is None:
            return bytes([1])

        name = attribute.decode("ascii", errors="replace")
        if name not in attributes:
            return bytes([2])

        object_id = list(self.objects).index(class_name.decode("ascii", errors="replace"))

        return bytes([0]) + (1).to_bytes(2, "big") + object_id.to_bytes(2, "big") + encode(attributes[name])


class IASClient(asyncio.Protocol):
    def __init__(self) -> None:
        self.transport: asyncio.Transport | None = None
        self._result = bytearray()
        self._call: asyncio.Future[bytes] | None = None

    def connection_made(self, transport: asyncio.Transport) -> None:
        self.transport = transport

    def connection_lost(self, exc: Exception | None) -> None:
        if self._call:
            self._call.set_exception(exc or ConnectionResetError())
            self._call = None

    async def call(self, opcode: int, args: bytes) -> bytes:
        self._call = asyncio.get_running_loop().create_future()
        self._result.clear()
        self.transport.write(bytes(IAPFrame(opcode, last=True, ack=False, data=args).payload))

        return await self._call

    def data_received(self, data: bytes) -> None:
        frame = IAPFrame.parse(data)
        if frame.ack:
            return

        self._result += frame.data

        if frame.last:
            self._call.set_result(bytes(self._result))
            self._call = None
        else:
            self.transport.write(bytes(IAPFrame(frame.opcode, last=False, ack=True).payload))


class IASServer(asyncio.Protocol):
    def __init__(self, ias: IAS) -> None:
        self.ias = ias
        self.transport: asyncio.Transport | None = None
        self._command = bytearray()
        self._reply: deque[IAPFrame] = deque()

    def connection_made(self, transport: asyncio.Transport) -> None:
        self.transport = transport

    def data_received(self, data: bytes) -> None:
        frame = IAPFrame.parse(data)

        if frame.ack:
            self._send_next()
            return

        self._command += frame.data

        if not frame.last:
            self.transport.write(bytes(IAPFrame(frame.opcode, last=False, ack=True).payload))
            return

        command, self._command = bytes(self._command), bytearray()
        self._queue_reply(frame.opcode, self._execute(frame.opcode, command))
        self._send_next()

    def _execute(self, opcode: int, command: bytes) -> bytes:
        if opcode != GET_VALUE_BY_CLASS:
            return bytes([UNSUPPORTED])

        class_name, offset = _read_octets(command, 0)
        attribute, _ = _read_octets(command, offset)

        return self.ias.get_value_by_class_local(class_name, attribute)

    def _queue_reply(self, opcode: int, result: bytes) -> None:
        size = self.transport.get_extra_info("data_size") - 1
        chunks = [result[i : i + size] for i in range(0, len(result), size)]

        self._reply.clear()
        self._reply.extend(IAPFrame(opcode, last=chunk is chunks[-1], ack=False, data=chunk) for chunk in chunks)

    def _send_next(self) -> None:
        if self._reply:
            self.transport.write(bytes(self._reply.popleft().payload))


def _octets(text: str) -> bytes:
    encoded = text.encode("ascii")

    return bytes([len(encoded)]) + encoded


def _read_octets(data: bytes, offset: int) -> tuple[bytes, int]:
    end = offset + 1 + data[offset]

    return data[offset + 1 : end], end
