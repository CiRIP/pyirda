import asyncio
import logging

from loopback import Chatty, Wire

from pyirda.irlap import IrLAP
from pyirda.irlmp import Hints, IrLMP
from pyirda.irlmp.constants import LINGER_TIMEOUT

logging.basicConfig(level=logging.DEBUG, format="%(relativeCreated)6d %(name)-24s %(message)s")


def stack(name: str) -> tuple[IrLAP, IrLMP]:
    irlap = IrLAP()
    irlmp = IrLMP(irlap, nickname=name, hints=Hints.COMPUTER)

    return irlap, irlmp


async def main() -> None:
    a_sends = [b"a1", b"a2", b"a3", b"a4", b"a5"]
    b_sends = [b"b1", b"b2"]

    a_lap, a = stack("A")
    b_lap, b = stack("B")

    ab, ba = Wire(), Wire()
    ab.peer, ba.peer = b_lap, a_lap
    a_lap.connection_made(ab)
    b_lap.connection_made(ba)

    accepted: list[Chatty] = []

    def server() -> Chatty:
        accepted.append(Chatty("B", b_sends))
        return accepted[-1]

    b.listeners[0x05] = server
    b.ias.objects["Echo"] = {"IrDA:IrLMP:LsapSel": 0x05}
    b.ias.objects["Big"] = {"Blob": bytes(range(256)) * 3}

    devices = await a.discover()
    assert len(devices) == 1, devices
    assert devices[0].nickname == "B"
    assert devices[0].hints == Hints.COMPUTER

    # no listener there
    try:
        await a.connect(devices[0].address, 0x06, lambda: Chatty("A", []))
    except ConnectionRefusedError as exc:
        assert "NO_PEER_MUX_CLIENT" in str(exc), exc
    else:
        raise AssertionError

    endpoint, protocol = await a.connect(devices[0].address, 0x05, lambda: Chatty("A", a_sends), data=b"hello")
    assert endpoint.get_extra_info("data_size") == 254
    await asyncio.sleep(0.05)
    assert len(accepted) == 1
    assert accepted[0].transport.get_extra_info("connect_data") == b"hello"

    while len(protocol.received) < len(b_sends) or len(accepted[0].received) < len(a_sends):
        await asyncio.sleep(0.1)

    assert protocol.received == b_sends, protocol.received
    assert accepted[0].received == a_sends, accepted[0].received

    # second connection reuses the same IrLAP link
    second, second_protocol = await a.connect(devices[0].address, 0x05, lambda: Chatty("A", [b"again"]))
    assert second.get_extra_info("irlmp") is a
    assert len(accepted) == 2
    while not accepted[1].received:
        await asyncio.sleep(0.1)
    assert accepted[1].received == [b"again"]

    endpoint.close()
    assert await protocol.closed is None
    assert await accepted[0].closed is None
    assert a_lap.connected

    second.close()
    assert await second_protocol.closed is None
    assert await accepted[1].closed is None

    await asyncio.sleep(LINGER_TIMEOUT + 1)
    assert a_lap.state.name == "NDM", a_lap.state
    assert b_lap.state.name == "NDM", b_lap.state
    assert a.link is None
    assert b.link is None

    # IAS lookups, then a connection by service name over the same link
    assert await a.ias.get_value_by_class(devices[0].address, "Device", "DeviceName") == [(0, "B")]
    assert await a.ias.get_value_by_class(devices[0].address, "Big", "Blob") == [(2, bytes(range(256)) * 3)]
    assert await a.ias.get_value_by_class(devices[0].address, "Nope", "Blob") == []
    assert await a.ias.get_value_by_class(devices[0].address, "Big", "Nope") == []
    assert await b.ias.get_value_by_class(a_lap.src_device_address, "Device", "DeviceName") == [(0, "A")]

    try:
        await a.connect(devices[0].address, "Nope", lambda: Chatty("A", []))
    except LookupError:
        pass
    else:
        raise AssertionError

    endpoint, protocol = await a.connect(devices[0].address, "Echo", lambda: Chatty("A", [b"named"]))
    assert len(accepted) == 3
    while not accepted[2].received:
        await asyncio.sleep(0.1)
    assert accepted[2].received == [b"named"]
    endpoint.close()
    await protocol.closed

    # a lingering idle link is dropped for a fresh discovery
    assert a_lap.connected
    devices = await a.discover()
    assert len(devices) == 1

    logging.info("OK")


if __name__ == "__main__":
    asyncio.run(main())
