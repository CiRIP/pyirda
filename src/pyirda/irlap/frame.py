from typing import Self

from pyirda.utils import _all_subclasses

from .constants import BROADCAST
from .negotiation import NegotiationParameters


class Frame:
    payload: bytearray

    def __init__(
        self, address: int, command: bool, control: int, information: bytes | None = None, pf: bool = True
    ) -> None:
        self.payload = bytearray(2)

        self.address = address
        self.command = command
        self.control = control
        if information:
            self.information = information
        self.pf = pf

    def __repr__(self) -> str:
        import inspect

        props = {
            name: getattr(self, name)
            for name, _ in inspect.getmembers(type(self), lambda v: isinstance(v, property))
            if name != "payload"
        }
        fields = ", ".join(f"{k}={v!r}" for k, v in props.items())
        return f"{type(self).__name__}({fields})"

    @classmethod
    def parse(cls, data: bytes) -> "Frame":
        frame = cls.from_bytes(data)
        for subclass in _all_subclasses(cls):
            frame.__class__ = subclass
            if subclass.is_valid(frame):
                return frame
        frame.__class__ = cls
        return frame

    def is_valid(self) -> bool:
        return True

    @classmethod
    def from_bytes(cls, data: bytes) -> Self:
        frame = cls.__new__(cls)
        frame.payload = bytearray(data)

        return frame

    @property
    def address(self) -> int:
        return self.payload[0] >> 1

    @address.setter
    def address(self, value: int) -> None:
        self.payload[0] = (value << 1) | (self.payload[0] & 1)

    @property
    def command(self) -> bool:
        return bool(self.payload[0] & 1)

    @command.setter
    def command(self, value: bool) -> None:
        self.payload[0] = (self.payload[0] & ~1) | (1 if value else 0)

    @property
    def control(self) -> int:
        return self.payload[1]

    @control.setter
    def control(self, value: int) -> None:
        self.payload[1] = value

    @property
    def information(self) -> bytes:
        return self.payload[2:]

    @information.setter
    def information(self, value: bytes) -> None:
        self.payload[2:] = value

    @property
    def pf(self) -> bool:
        return bool(self.control & 0b00010000)

    @pf.setter
    def pf(self, value: bool) -> None:
        self.control = (self.control & ~0b00010000) | (0b00010000 if value else 0)


class UFrame(Frame):
    def is_valid(self) -> bool:
        return super().is_valid() and self.control & 0b00000011 == 0b00000011


class SFrame(Frame):
    def is_valid(self) -> bool:
        return super().is_valid() and self.control & 0b00000011 == 0b00000001

    @property
    def nr(self) -> int:
        return self.control >> 5

    @nr.setter
    def nr(self, value: int) -> None:
        self.control = (self.control & ~0b11100000) | (value << 5)


class IFrame(Frame):
    def __init__(self, address: int, command: bool, ns: int, nr: int, information: bytes, pf: bool) -> None:
        super().__init__(address, command=command, control=0, information=information, pf=pf)
        self.ns = ns
        self.nr = nr

    def is_valid(self) -> bool:
        return super().is_valid() and self.control & 0b00000001 == 0b00000000

    @property
    def nr(self) -> int:
        return self.control >> 5

    @nr.setter
    def nr(self, value: int) -> None:
        self.control = (self.control & ~0b11100000) | (value << 5)

    @property
    def ns(self) -> int:
        return (self.control & 0b00001110) >> 1

    @ns.setter
    def ns(self, value: int) -> None:
        self.control = (self.control & ~0b00001110) | (value << 1)


class SNRMCommandFrame(UFrame):
    def __init__(
        self,
        address: int,
        src_device_address: int | None = None,
        dst_device_address: int | None = None,
        connection_address: int | None = None,
        negotiation_parameters: NegotiationParameters | None = None,
    ) -> None:
        if (
            src_device_address is not None
            and dst_device_address is not None
            and connection_address is not None
            and negotiation_parameters is not None
        ):
            information = bytes(9) + negotiation_parameters.build()
            super().__init__(address, command=True, control=0b10000011, information=information)
            self.src_device_address = src_device_address
            self.dst_device_address = dst_device_address
            self.connection_address = connection_address
        else:
            super().__init__(address, command=True, control=0b10000011)

    def is_valid(self) -> bool:
        return super().is_valid() and self.command and self.control & 0b11101111 == 0b10000011

    @property
    def src_device_address(self) -> int:
        return int.from_bytes(self.payload[2:6], "little")

    @src_device_address.setter
    def src_device_address(self, value: int) -> None:
        self.payload[2:6] = value.to_bytes(4, "little")

    @property
    def dst_device_address(self) -> int:
        return int.from_bytes(self.payload[6:10], "little")

    @dst_device_address.setter
    def dst_device_address(self, value: int) -> None:
        self.payload[6:10] = value.to_bytes(4, "little")

    @property
    def connection_address(self) -> int:
        return self.payload[10] >> 1

    @connection_address.setter
    def connection_address(self, value: int) -> None:
        self.payload[10] = (value << 1) & 0b11111110

    @property
    def negotiation_parameters(self) -> NegotiationParameters:
        return NegotiationParameters.parse(self.payload[11:])

    @negotiation_parameters.setter
    def negotiation_parameters(self, value: NegotiationParameters) -> None:
        self.payload[11:] = value.build()


class DISCCommandFrame(UFrame):
    def __init__(self, address: int) -> None:
        super().__init__(address, command=True, control=0b01000011)

    def is_valid(self) -> bool:
        return (
            super().is_valid()
            and self.command
            and self.control & 0b11101111 == 0b01000011
            and len(self.information) == 0
        )


class UICommandFrame(UFrame):
    def __init__(self, address: int, information: bytes = b"") -> None:
        super().__init__(address, command=True, control=0b00000011, information=information)

    def is_valid(self) -> bool:
        return super().is_valid() and self.command and self.control & 0b11101111 == 0b00000011


class UIResponseFrame(UFrame):
    def __init__(self, address: int, information: bytes = b"") -> None:
        super().__init__(address, command=False, control=0b00000011, information=information)

    def is_valid(self) -> bool:
        return super().is_valid() and not self.command and self.control & 0b11101111 == 0b00000011


class TESTCommandFrame(UFrame):
    def __init__(
        self,
        address: int,
        data: bytes = b"",
        src_device_address: int | None = None,
        dst_device_address: int | None = None,
    ) -> None:
        super().__init__(
            address, command=True, control=0b11100011, information=bytes(8) + data if address == BROADCAST else data
        )

        if self.address == BROADCAST:
            self.src_device_address = src_device_address
            self.dst_device_address = dst_device_address

    def is_valid(self) -> bool:
        return super().is_valid() and self.command and self.control & 0b11101111 == 0b11100011

    @property
    def src_device_address(self) -> int | None:
        if self.address != BROADCAST:
            return None
        return int.from_bytes(self.payload[2:6], "little")

    @src_device_address.setter
    def src_device_address(self, value: int) -> None:
        self.payload[2:6] = value.to_bytes(4, "little")

    @property
    def dst_device_address(self) -> int | None:
        if self.address != BROADCAST:
            return None
        return int.from_bytes(self.payload[6:10], "little")

    @dst_device_address.setter
    def dst_device_address(self, value: int) -> None:
        self.payload[6:10] = value.to_bytes(4, "little")

    @property
    def data(self) -> bytes:
        offset = 10 if self.address == BROADCAST else 2
        return bytes(self.payload[offset:])

    @data.setter
    def data(self, value: bytes) -> None:
        offset = 10 if self.address == BROADCAST else 2
        self.payload[offset:] = value


class TESTResponseFrame(UFrame):
    def __init__(
        self,
        address: int,
        data: bytes = b"",
        src_device_address: int | None = None,
        dst_device_address: int | None = None,
    ) -> None:
        super().__init__(
            address, command=False, control=0b11100011, information=bytes(8) + data if address == BROADCAST else data
        )

        if self.address == BROADCAST:
            self.src_device_address = src_device_address
            self.dst_device_address = dst_device_address

    def is_valid(self) -> bool:
        return super().is_valid() and not self.command and self.control & 0b11101111 == 0b11100011

    src_device_address = TESTCommandFrame.src_device_address
    dst_device_address = TESTCommandFrame.dst_device_address
    data = TESTCommandFrame.data


class RNRMResponseFrame(UFrame):
    def __init__(self, address: int) -> None:
        super().__init__(address, command=False, control=0b10000011)

    def is_valid(self) -> bool:
        return super().is_valid() and not self.command and self.control & 0b11101111 == 0b10000011


class UAResponseFrame(UFrame):
    def __init__(
        self,
        address: int,
        src_device_address: int | None = None,
        dst_device_address: int | None = None,
        negotiation_parameters: NegotiationParameters | None = None,
    ) -> None:
        if src_device_address is not None and dst_device_address is not None and negotiation_parameters is not None:
            information = bytes(8) + negotiation_parameters.build()
            super().__init__(address, command=False, control=0b01100011, information=information)
            self.src_device_address = src_device_address
            self.dst_device_address = dst_device_address
        else:
            super().__init__(address, command=False, control=0b01100011)

    def is_valid(self) -> bool:
        return super().is_valid() and not self.command and self.control & 0b11101111 == 0b01100011

    @property
    def src_device_address(self) -> int | None:
        return int.from_bytes(self.payload[2:6], "little") if len(self.payload) >= 6 else None

    @src_device_address.setter
    def src_device_address(self, value: int) -> None:
        self.payload[2:6] = value.to_bytes(4, "little")

    @property
    def dst_device_address(self) -> int | None:
        return int.from_bytes(self.payload[6:10], "little") if len(self.payload) >= 10 else None

    @dst_device_address.setter
    def dst_device_address(self, value: int) -> None:
        self.payload[6:10] = value.to_bytes(4, "little")

    @property
    def negotiation_parameters(self) -> NegotiationParameters:
        return NegotiationParameters.parse(self.payload[10:])

    @negotiation_parameters.setter
    def negotiation_parameters(self, value: NegotiationParameters) -> None:
        self.payload[10:] = value.build()


class FRMRResponseFrame(UFrame):
    def __init__(
        self,
        address: int,
        rejected_control: int,
        ns: int,
        cr: bool,
        nr: int,
        w: bool = False,
        x: bool = False,
        y: bool = False,
        z: bool = False,
    ) -> None:
        super().__init__(address, command=False, control=0b10000111, information=bytes(3))
        self.rejected_control = rejected_control
        self.ns = ns
        self.cr = cr
        self.nr = nr
        self.w = w
        self.x = x
        self.y = y
        self.z = z

    def is_valid(self) -> bool:
        return (
            super().is_valid()
            and not self.command
            and self.control & 0b11101111 == 0b10000111
            and len(self.information) == 3
        )

    @property
    def rejected_control(self) -> int:
        return self.payload[2]

    @rejected_control.setter
    def rejected_control(self, value: int) -> None:
        self.payload[2] = value

    @property
    def ns(self) -> int:
        return (self.payload[3] & 0b00001110) >> 1

    @ns.setter
    def ns(self, value: int) -> None:
        self.payload[3] = (self.payload[3] & ~0b00001110) | ((value << 1) & 0b00001110)

    @property
    def cr(self) -> bool:
        return bool(self.payload[3] & 0b00010000)

    @cr.setter
    def cr(self, value: bool) -> None:
        self.payload[3] = (self.payload[3] & ~0b00010000) | (0b00010000 if value else 0)

    @property
    def nr(self) -> int:
        return (self.payload[3] & 0b11100000) >> 5

    @nr.setter
    def nr(self, value: int) -> None:
        self.payload[3] = (self.payload[3] & ~0b11100000) | ((value << 5) & 0b11100000)

    @property
    def w(self) -> bool:
        return bool(self.payload[4] & 0b00000001)

    @w.setter
    def w(self, value: bool) -> None:
        self.payload[4] = (self.payload[4] & ~0b00000001) | (0b00000001 if value else 0)

    @property
    def x(self) -> bool:
        return bool(self.payload[4] & 0b00000010)

    @x.setter
    def x(self, value: bool) -> None:
        self.payload[4] = (self.payload[4] & ~0b00000010) | (0b00000010 if value else 0)

    @property
    def y(self) -> bool:
        return bool(self.payload[4] & 0b00000100)

    @y.setter
    def y(self, value: bool) -> None:
        self.payload[4] = (self.payload[4] & ~0b00000100) | (0b00000100 if value else 0)

    @property
    def z(self) -> bool:
        return bool(self.payload[4] & 0b00001000)

    @z.setter
    def z(self, value: bool) -> None:
        self.payload[4] = (self.payload[4] & ~0b00001000) | (0b00001000 if value else 0)


class DMResponseFrame(UFrame):
    def __init__(self, address: int) -> None:
        super().__init__(address, command=False, control=0b00001111)

    def is_valid(self) -> bool:
        return super().is_valid() and not self.command and self.control & 0b11101111 == 0b00001111


class RDResponseFrame(UFrame):
    def __init__(self, address: int) -> None:
        super().__init__(address, command=False, control=0b01000011)

    def is_valid(self) -> bool:
        return super().is_valid() and not self.command and self.control & 0b11101111 == 0b01000011


class XIDCommandFrame(UFrame):
    VALID_SLOT_COUNTS = {1, 6, 8, 16}

    def __init__(
        self,
        src_device_address: int,
        dst_device_address: int,
        generate_new_address: bool,
        slot_count: int,
        slot_number: int,
        version: int = 0x00,
        discovery_info: bytes = b"",
    ) -> None:
        super().__init__(BROADCAST, command=True, control=0b00101111, information=bytes(12) + discovery_info)
        self.payload[2] = 0x01
        self.src_device_address = src_device_address
        self.dst_device_address = dst_device_address
        self.generate_new_address = generate_new_address
        self.slot_count = slot_count
        self.slot_number = slot_number
        self.version = version

    def is_valid(self) -> bool:
        return (
            super().is_valid()
            and self.command
            and self.control & 0b11101111 == 0b00101111
            and self.address == BROADCAST
            and len(self.information) >= 12
            and self.payload[2] == 0x01
        )

    @property
    def format_identifier(self) -> int:
        return self.payload[2]

    @property
    def src_device_address(self) -> int:
        return int.from_bytes(self.payload[3:7], "little")

    @src_device_address.setter
    def src_device_address(self, value: int) -> None:
        self.payload[3:7] = value.to_bytes(4, "little")

    @property
    def dst_device_address(self) -> int:
        return int.from_bytes(self.payload[7:11], "little")

    @dst_device_address.setter
    def dst_device_address(self, value: int) -> None:
        self.payload[7:11] = value.to_bytes(4, "little")

    @property
    def slot_count(self) -> int:
        return {0b00: 1, 0b01: 6, 0b10: 8, 0b11: 16}[self.payload[11] & 0b00000011]

    @slot_count.setter
    def slot_count(self, value: int) -> None:
        if value not in self.VALID_SLOT_COUNTS:
            raise ValueError(f"slot_count must be one of {self.VALID_SLOT_COUNTS}, got {value}")
        encoded = {1: 0b00, 6: 0b01, 8: 0b10, 16: 0b11}[value]
        self.payload[11] = (self.payload[11] & ~0b00000011) | encoded

    @property
    def generate_new_address(self) -> bool:
        return bool(self.payload[11] & 0b00000100)

    @generate_new_address.setter
    def generate_new_address(self, value: bool) -> None:
        self.payload[11] = (self.payload[11] & ~0b00000100) | (0b00000100 if value else 0)

    @property
    def slot_number(self) -> int:
        return self.payload[12]

    @slot_number.setter
    def slot_number(self, value: int) -> None:
        self.payload[12] = value

    @property
    def version(self) -> int:
        return self.payload[13]

    @version.setter
    def version(self, value: int) -> None:
        self.payload[13] = value

    @property
    def discovery_info(self) -> bytes:
        return bytes(self.payload[14:])

    @discovery_info.setter
    def discovery_info(self, value: bytes) -> None:
        self.payload[14:] = value


class XIDResponseFrame(UFrame):
    VALID_SLOT_COUNTS = XIDCommandFrame.VALID_SLOT_COUNTS

    def __init__(
        self,
        src_device_address: int,
        dst_device_address: int,
        generate_new_address: bool,
        slot_count: int,
        slot_number: int,
        version: int = 0x00,
        discovery_info: bytes = b"",
    ) -> None:
        super().__init__(BROADCAST, command=False, control=0b10101111, information=bytes(12) + discovery_info)
        self.payload[2] = 0x01
        self.src_device_address = src_device_address
        self.dst_device_address = dst_device_address
        self.generate_new_address = generate_new_address
        self.slot_count = slot_count
        self.slot_number = slot_number
        self.version = version

    def is_valid(self) -> bool:
        return (
            super().is_valid()
            and not self.command
            and self.control & 0b11101111 == 0b10101111
            and self.address == BROADCAST
            and len(self.information) >= 12
            and self.payload[2] == 0x01
        )

    format_identifier = XIDCommandFrame.format_identifier
    src_device_address = XIDCommandFrame.src_device_address
    dst_device_address = XIDCommandFrame.dst_device_address
    generate_new_address = XIDCommandFrame.generate_new_address
    slot_count = XIDCommandFrame.slot_count
    slot_number = XIDCommandFrame.slot_number
    version = XIDCommandFrame.version
    discovery_info = XIDCommandFrame.discovery_info


class RRFrame(SFrame):
    def __init__(self, address: int, command: bool, nr: int) -> None:
        super().__init__(address, command=command, control=0b00000001)
        self.nr = nr

    def is_valid(self) -> bool:
        return super().is_valid() and self.control & 0b00001100 == 0b00000000


class RNRFrame(SFrame):
    def __init__(self, address: int, command: bool, nr: int) -> None:
        super().__init__(address, command=command, control=0b00000101)
        self.nr = nr

    def is_valid(self) -> bool:
        return super().is_valid() and self.control & 0b00001100 == 0b00000100


class REJFrame(SFrame):
    def __init__(self, address: int, command: bool, nr: int) -> None:
        super().__init__(address, command=command, control=0b00001001)
        self.nr = nr

    def is_valid(self) -> bool:
        return super().is_valid() and self.control & 0b00001100 == 0b00001000


class SREJFrame(SFrame):
    def __init__(self, address: int, command: bool, nr: int) -> None:
        super().__init__(address, command=command, control=0b00001101)
        self.nr = nr

    def is_valid(self) -> bool:
        return super().is_valid() and self.control & 0b00001100 == 0b00001100
