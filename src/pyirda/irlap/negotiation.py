from dataclasses import dataclass, field

from pyirda.exceptions import IrdaException

PI_BAUD_RATE = 0x01  # type 0
PI_MAX_TURN_AROUND = 0x82  # type 1
PI_DATA_SIZE = 0x83  # type 1
PI_WINDOW_SIZE = 0x84  # type 1
PI_ADDITIONAL_BOFS = 0x85  # type 1
PI_MIN_TURN_AROUND = 0x86  # type 1
PI_LINK_DISCONNECT = 0x08  # type 0


BAUD_RATES = {
    0b00000001: 2400,
    0b00000010: 9600,
    0b00000100: 19200,
    0b00001000: 38400,
    0b00010000: 57600,
    0b00100000: 115200,
    0b01000000: 576000,
    0b10000000: 1152000,
}

MAX_TURN_AROUND_MS = {
    0b00000001: 500,
    0b00000010: 250,
    0b00000100: 100,
    0b00001000: 50,
}

DATA_SIZES = {
    0b00000001: 64,
    0b00000010: 128,
    0b00000100: 256,
    0b00001000: 512,
    0b00010000: 1024,
    0b00100000: 2048,
}

WINDOW_SIZES = {
    0b00000001: 1,
    0b00000010: 2,
    0b00000100: 3,
    0b00001000: 4,
    0b00010000: 5,
    0b00100000: 6,
    0b01000000: 7,
}

LINK_DISCONNECT_SECS = {
    0b00000001: 3,
    0b00000010: 8,
    0b00000100: 12,
    0b00001000: 16,
    0b00010000: 20,
    0b00100000: 25,
    0b01000000: 30,
    0b10000000: 40,
}

MIN_TURN_AROUND_MS = {
    0b00000001: 10,
    0b00000010: 5,
    0b00000100: 1,
    0b00001000: 0.5,
    0b00010000: 0.1,
    0b00100000: 0.05,
    0b01000000: 0.01,
    0b10000000: 0,
}

ADDITIONAL_BOFS_AT_115200 = {
    0b00000001: 48,
    0b00000010: 24,
    0b00000100: 12,
    0b00001000: 6,
    0b00010000: 3,
    0b00100000: 2,
    0b01000000: 1,
    0b10000000: 0,
}


class NegotiationError(IrdaException):
    pass


@dataclass
class NegotiationParameters:
    baud_rate_pv: int = 0b00000010  # 9600 only by default
    max_turn_around_pv: int = 0b00000001  # 500ms
    data_size_pv: int = 0b00111111
    window_size_pv: int = 0b01111111
    additional_bofs_pv: int = 0b11111111
    min_turn_around_pv: int = 0b11111111
    link_disconnect_pv: int = 0b11111111

    @classmethod
    def parse(cls, data: bytes) -> "NegotiationParameters":
        params = cls()
        i = 0
        while i < len(data):
            if i + 2 > len(data):
                break
            pi = data[i]
            pl = data[i + 1]
            pv = data[i + 2 : i + 2 + pl]
            i += 2 + pl

            if not pv or len(pv) != pl:
                continue

            match pi:
                case 0x01:
                    params.baud_rate_pv = pv[0]
                case 0x82:
                    params.max_turn_around_pv = pv[0]
                case 0x83:
                    params.data_size_pv = pv[0]
                case 0x84:
                    params.window_size_pv = pv[0]
                case 0x85:
                    params.additional_bofs_pv = pv[0]
                case 0x86:
                    params.min_turn_around_pv = pv[0]
                case 0x08:
                    params.link_disconnect_pv = pv[0]
                case _:
                    pass  # unknown parameter, ignore per spec
        return params

    def build(self) -> bytes:
        out = bytearray()
        for pi, pv in [
            (0x01, self.baud_rate_pv),
            (0x82, self.max_turn_around_pv),
            (0x83, self.data_size_pv),
            (0x84, self.window_size_pv),
            (0x85, self.additional_bofs_pv),
            (0x86, self.min_turn_around_pv),
            (0x08, self.link_disconnect_pv),
        ]:
            out += bytes([pi, 1, pv])
        return bytes(out)

    def negotiate(self, remote: "NegotiationParameters") -> tuple["NegotiationParameters", "NegotiationParameters"]:
        """
        Produce agreed parameters from our capabilities and remote's proposal.
        Type 0 (baud rate, link disconnect): AND the PV fields, then pick MSB.
        Type 1 (everything else): pick MSB of our and their PV - independently negotiated.
        """
        ours = NegotiationParameters()
        theirs = NegotiationParameters()

        ours.baud_rate_pv = _pick_type0(self.baud_rate_pv, remote.baud_rate_pv)
        ours.link_disconnect_pv = _pick_type0(self.link_disconnect_pv, remote.link_disconnect_pv)
        theirs.baud_rate_pv = _pick_type0(self.baud_rate_pv, remote.baud_rate_pv)
        theirs.link_disconnect_pv = _pick_type0(self.link_disconnect_pv, remote.link_disconnect_pv)

        ours.max_turn_around_pv = _pick_type1(self.max_turn_around_pv)
        ours.data_size_pv = _pick_type1(self.data_size_pv)
        ours.window_size_pv = _pick_type1(self.window_size_pv)
        ours.additional_bofs_pv = _pick_type1(self.additional_bofs_pv)
        ours.min_turn_around_pv = _pick_type1(self.min_turn_around_pv)

        theirs.max_turn_around_pv = _pick_type1(remote.max_turn_around_pv)
        theirs.data_size_pv = _pick_type1(remote.data_size_pv)
        theirs.window_size_pv = _pick_type1(remote.window_size_pv)
        theirs.additional_bofs_pv = _pick_type1(remote.additional_bofs_pv)
        theirs.min_turn_around_pv = _pick_type1(remote.min_turn_around_pv)

        return ours, theirs

    # convenience accessors returning actual values rather than bitmasks
    @property
    def baud_rate(self) -> int:
        return _msb_lookup(self.baud_rate_pv, BAUD_RATES)

    @property
    def max_turn_around_ms(self) -> int:
        return _msb_lookup(self.max_turn_around_pv, MAX_TURN_AROUND_MS)

    @property
    def data_size(self) -> int:
        return _msb_lookup(self.data_size_pv, DATA_SIZES)

    @property
    def window_size(self) -> int:
        return _msb_lookup(self.window_size_pv, WINDOW_SIZES)

    @property
    def link_disconnect_secs(self) -> int:
        return _msb_lookup(self.link_disconnect_pv, LINK_DISCONNECT_SECS)

    @property
    def min_turn_around_ms(self) -> float:
        return _msb_lookup(self.min_turn_around_pv, MIN_TURN_AROUND_MS)

    @property
    def additional_bofs_at_115200(self) -> int:
        return _msb_lookup(self.additional_bofs_pv, ADDITIONAL_BOFS_AT_115200)


def _msb_lookup(pv: int, table: dict) -> int:
    for bit in range(7, -1, -1):
        mask = 1 << bit
        if pv & mask and mask in table:
            return table[mask]

    raise NegotiationError(f"No value for PV {pv:08b}")


def _pick_type0(ours: int, theirs: int) -> int:
    agreed = ours & theirs
    if agreed == 0:
        raise NegotiationError(f"No common capabilities. Ours: {ours:08b}, Theirs: {theirs:08b}")
    msb = 1 << (agreed.bit_length() - 1)
    return msb


def _pick_type1(ours: int) -> int:
    if ours == 0:
        raise NegotiationError("No capabilities set for type 1 parameter")
    msb = 1 << (ours.bit_length() - 1)
    return msb