from pyirda.packet import Packet

from .constants import PI_MAX_SDU_SIZE


class DataPDU(Packet):
    def __init__(self, delta_credit: int, data: bytes = b"", *, more: bool = False) -> None:
        self.payload = bytearray(1) + data

        self.delta_credit = delta_credit
        self.more = more

    @property
    def more(self) -> bool:
        return bool(self.payload[0] & 0b10000000)

    @more.setter
    def more(self, value: bool) -> None:
        self.payload[0] = (self.payload[0] & 0b01111111) | (0b10000000 if value else 0)

    @property
    def delta_credit(self) -> int:
        return self.payload[0] & 0b01111111

    @delta_credit.setter
    def delta_credit(self, value: int) -> None:
        self.payload[0] = (self.payload[0] & 0b10000000) | value

    @property
    def data(self) -> bytes:
        return bytes(self.payload[1:])


class ConnectPDU(Packet):
    def __init__(self, initial_credit: int, max_sdu_size: int = 0, data: bytes = b"") -> None:
        parameters = _parameter(PI_MAX_SDU_SIZE, max_sdu_size) if max_sdu_size else b""
        self.payload = bytearray(1) + (bytes([len(parameters)]) + parameters if parameters else b"") + data

        self.payload[0] = initial_credit | (0b10000000 if parameters else 0)

    @property
    def parameters_present(self) -> bool:
        return bool(self.payload[0] & 0b10000000)

    @property
    def initial_credit(self) -> int:
        return self.payload[0] & 0b01111111

    @property
    def parameters(self) -> dict[int, bytes]:
        if not self.parameters_present:
            return {}

        parameters, i = {}, 2
        while i + 2 <= 2 + self.payload[1]:
            pi, pl = self.payload[i], self.payload[i + 1]
            parameters[pi] = bytes(self.payload[i + 2 : i + 2 + pl])
            i += 2 + pl

        return parameters

    @property
    def max_sdu_size(self) -> int:
        return int.from_bytes(self.parameters.get(PI_MAX_SDU_SIZE, b""), "big")

    @property
    def data(self) -> bytes:
        return bytes(self.payload[2 + self.payload[1] :] if self.parameters_present else self.payload[1:])


def _parameter(pi: int, value: int) -> bytes:
    encoded = value.to_bytes((value.bit_length() + 7) // 8, "big")

    return bytes([pi, len(encoded)]) + encoded
