from pyirda.packet import Packet

from .constants import FINAL, UNICODE, VERSION, Header, Opcode

Headers = list[tuple[int, str | bytes | int]]


def encode_header(hi: int, value: str | bytes | int) -> bytes:
    match hi & 0xC0:
        case 0x00:
            encoded = value.encode("utf-16-be") + b"\x00\x00" if value else b""
        case 0x40:
            encoded = bytes(value)
        case 0x80:
            return bytes([hi, value])
        case _:
            return bytes([hi]) + value.to_bytes(4, "big")

    return bytes([hi]) + (len(encoded) + 3).to_bytes(2, "big") + encoded


def encode_headers(headers: Headers) -> bytes:
    return b"".join(encode_header(hi, value) for hi, value in headers)


def decode_headers(data: bytes) -> Headers:
    headers, i = [], 0

    while i < len(data):
        hi = data[i]

        match hi & 0xC0:
            case 0x00 | 0x40:
                length = max(int.from_bytes(data[i + 1 : i + 3], "big"), 3)
                raw = data[i + 3 : i + length]
                value = raw.removesuffix(b"\x00\x00").decode("utf-16-be", "replace") if hi & 0xC0 == UNICODE else raw
                i += length
            case 0x80:
                value = data[i + 1]
                i += 2
            case _:
                value = int.from_bytes(data[i + 1 : i + 5], "big")
                i += 5

        headers.append((_name(hi), value))

    return headers


def _name(hi: int) -> int:
    try:
        return Header(hi)
    except ValueError:
        return hi


class OBEXPacket(Packet):
    HEADERS_OFFSET = 3

    def __init__(self, opcode: int, data: bytes = b"") -> None:
        self.payload = bytearray(3) + data

        self.opcode = opcode
        self.length = len(self.payload)

    @property
    def opcode(self) -> int:
        return self.payload[0]

    @opcode.setter
    def opcode(self, value: int) -> None:
        self.payload[0] = value

    @property
    def code(self) -> int:
        return self.payload[0] & ~FINAL

    @property
    def final(self) -> bool:
        return bool(self.payload[0] & FINAL)

    @property
    def length(self) -> int:
        return int.from_bytes(self.payload[1:3], "big")

    @length.setter
    def length(self, value: int) -> None:
        self.payload[1:3] = value.to_bytes(2, "big")

    @property
    def headers(self) -> Headers:
        return decode_headers(bytes(self.payload[self.HEADERS_OFFSET :]))

    @property
    def body(self) -> bytes | None:
        chunks = [value for hi, value in self.headers if hi in (Header.BODY, Header.END_OF_BODY)]

        return b"".join(chunks) if chunks else None


class ConnectPacket(OBEXPacket):
    HEADERS_OFFSET = 7

    def __init__(self, opcode: int, max_packet_length: int, headers: Headers = (), flags: int = 0) -> None:
        prefix = bytes([VERSION, flags]) + max_packet_length.to_bytes(2, "big")
        super().__init__(opcode, prefix + encode_headers(headers))

    def is_valid(self) -> bool:
        return super().is_valid() and self.opcode == Opcode.CONNECT | FINAL and len(self.payload) >= self.HEADERS_OFFSET

    @property
    def version(self) -> int:
        return self.payload[3]

    @property
    def flags(self) -> int:
        return self.payload[4]

    @property
    def max_packet_length(self) -> int:
        return int.from_bytes(self.payload[5:7], "big")


class SetPathPacket(OBEXPacket):
    HEADERS_OFFSET = 5

    def __init__(self, opcode: int, flags: int, headers: Headers = (), constants: int = 0) -> None:
        super().__init__(opcode, bytes([flags, constants]) + encode_headers(headers))

    def is_valid(self) -> bool:
        return super().is_valid() and self.opcode == Opcode.SETPATH | FINAL and len(self.payload) >= self.HEADERS_OFFSET

    @property
    def flags(self) -> int:
        return self.payload[3]

    @property
    def constants(self) -> int:
        return self.payload[4]
