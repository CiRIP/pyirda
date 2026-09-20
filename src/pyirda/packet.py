import inspect
from typing import Self

from pyirda.utils import _all_subclasses


class Packet:
    payload: bytearray

    def __repr__(self) -> str:
        props = {
            name: getattr(self, name)
            for name, _ in inspect.getmembers(type(self), lambda v: isinstance(v, property))
            if name != "payload"
        }
        fields = ", ".join(f"{k}={v!r}" for k, v in props.items())
        return f"{type(self).__name__}({fields})"

    @classmethod
    def parse(cls, data: bytes) -> Self:
        packet = cls.from_bytes(data)
        for subclass in _all_subclasses(cls):
            packet.__class__ = subclass
            if subclass.is_valid(packet):
                return packet
        packet.__class__ = cls
        return packet

    def is_valid(self) -> bool:
        return True

    @classmethod
    def from_bytes(cls, data: bytes) -> Self:
        packet = cls.__new__(cls)
        packet.payload = bytearray(data)

        return packet
