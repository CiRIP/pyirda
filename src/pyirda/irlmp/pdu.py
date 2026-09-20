from dataclasses import dataclass

from pyirda.packet import Packet

from .constants import Hints, Reason

CHARSETS = {0x00: "ascii", 0xFF: "utf-16-be"} | {code: f"iso-8859-{code}" for code in range(1, 10)}


class LMPDU(Packet):
    def __init__(self, dlsap: int, slsap: int, control: bool, body: bytes = b"") -> None:
        self.payload = bytearray(2) + body

        self.dlsap = dlsap
        self.slsap = slsap
        self.control = control

    @property
    def control(self) -> bool:
        return bool(self.payload[0] & 0b10000000)

    @control.setter
    def control(self, value: bool) -> None:
        self.payload[0] = (self.payload[0] & 0b01111111) | (0b10000000 if value else 0)

    @property
    def dlsap(self) -> int:
        return self.payload[0] & 0b01111111

    @dlsap.setter
    def dlsap(self, value: int) -> None:
        self.payload[0] = (self.payload[0] & 0b10000000) | value

    @property
    def slsap(self) -> int:
        return self.payload[1] & 0b01111111

    @slsap.setter
    def slsap(self, value: int) -> None:
        self.payload[1] = value


class DataPDU(LMPDU):
    def __init__(self, dlsap: int, slsap: int, data: bytes = b"") -> None:
        super().__init__(dlsap, slsap, control=False, body=data)

    def is_valid(self) -> bool:
        return super().is_valid() and len(self.payload) >= 2 and not self.control

    @property
    def data(self) -> bytes:
        return bytes(self.payload[2:])


class ControlPDU(LMPDU):
    def __init__(self, dlsap: int, slsap: int, opcode: int, confirm: bool, parameters: bytes = b"") -> None:
        super().__init__(dlsap, slsap, control=True, body=bytes(1) + parameters)
        self.opcode = opcode
        self.confirm = confirm

    def is_valid(self) -> bool:
        return super().is_valid() and len(self.payload) >= 3 and self.control

    @property
    def confirm(self) -> bool:
        return bool(self.payload[2] & 0b10000000)

    @confirm.setter
    def confirm(self, value: bool) -> None:
        self.payload[2] = (self.payload[2] & 0b01111111) | (0b10000000 if value else 0)

    @property
    def opcode(self) -> int:
        return self.payload[2] & 0b01111111

    @opcode.setter
    def opcode(self, value: int) -> None:
        self.payload[2] = (self.payload[2] & 0b10000000) | value

    @property
    def parameters(self) -> bytes:
        return bytes(self.payload[3:])


class ConnectPDU(ControlPDU):
    def __init__(self, dlsap: int, slsap: int, data: bytes = b"") -> None:
        super().__init__(dlsap, slsap, opcode=1, confirm=False, parameters=bytes(1) + data)

    def is_valid(self) -> bool:
        return super().is_valid() and self.opcode == 1 and not self.confirm

    @property
    def data(self) -> bytes:
        return bytes(self.payload[4:])


class ConnectConfirmPDU(ControlPDU):
    def __init__(self, dlsap: int, slsap: int, data: bytes = b"") -> None:
        super().__init__(dlsap, slsap, opcode=1, confirm=True, parameters=bytes(1) + data)

    def is_valid(self) -> bool:
        return super().is_valid() and self.opcode == 1 and self.confirm

    data = ConnectPDU.data


class DisconnectPDU(ControlPDU):
    def __init__(self, dlsap: int, slsap: int, reason: Reason, data: bytes = b"") -> None:
        super().__init__(dlsap, slsap, opcode=2, confirm=False, parameters=bytes([reason]) + data)

    def is_valid(self) -> bool:
        return super().is_valid() and self.opcode == 2 and not self.confirm and len(self.payload) >= 4

    @property
    def reason(self) -> Reason:
        try:
            return Reason(self.payload[3])
        except ValueError:
            return Reason.UNSPECIFIED

    data = ConnectPDU.data


class AccessModePDU(ControlPDU):
    def __init__(self, dlsap: int, slsap: int, mode: int) -> None:
        super().__init__(dlsap, slsap, opcode=3, confirm=False, parameters=bytes([0, mode]))

    def is_valid(self) -> bool:
        return super().is_valid() and self.opcode == 3 and not self.confirm


class AccessModeConfirmPDU(ControlPDU):
    def __init__(self, dlsap: int, slsap: int, status: int, mode: int) -> None:
        super().__init__(dlsap, slsap, opcode=3, confirm=True, parameters=bytes([status, mode]))

    def is_valid(self) -> bool:
        return super().is_valid() and self.opcode == 3 and self.confirm


@dataclass(frozen=True)
class DeviceInfo:
    hints: Hints
    nickname: str

    @classmethod
    def parse(cls, data: bytes) -> "DeviceInfo":
        hints, i = 0, 0
        while i < len(data):
            hints |= (data[i] & 0x7F) << (8 * i)
            i += 1
            if not data[i - 1] & 0x80:
                break

        nickname = data[i + 1 :].decode(CHARSETS.get(data[i], "latin-1"), errors="replace") if i < len(data) else ""

        return cls(Hints(hints), nickname)

    def build(self) -> bytes:
        return bytes([self.hints & 0x7F | 0x80, (self.hints >> 8) & 0x7F, 0x00]) + self.nickname.encode("ascii")[:20]
