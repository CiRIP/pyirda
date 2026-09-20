import asyncio
import logging

from loopback import Chatty, Wire

from pyirda.irlap import IrLAP
from pyirda.irlmp import IrLMP
from pyirda.irlmp.constants import LINGER_TIMEOUT
from pyirda.tinytp import TinyTP
from pyirda.tinytp.constants import INITIAL_CREDIT

logging.basicConfig(level=logging.DEBUG, format="%(relativeCreated)6d %(name)-24s %(message)s")


def stack(name: str) -> tuple[IrLAP, IrLMP, TinyTP]:
    irlap = IrLAP()
    irlmp = IrLMP(irlap, nickname=name)

    return irlap, irlmp, TinyTP(irlmp)


async def received(protocol: Chatty, count: int) -> list[bytes]:
    while len(protocol.received) < count:
        await asyncio.sleep(0.1)

    return protocol.received


async def main() -> None:
    a_lap, a, a_ttp = stack("A")
    b_lap, b, b_ttp = stack("B")

    ab, ba = Wire(), Wire()
    ab.peer, ba.peer = b_lap, a_lap
    a_lap.connection_made(ab)
    b_lap.connection_made(ba)

    accepted: list[Chatty] = []

    def server(sends: list[bytes]) -> Chatty:
        accepted.append(Chatty("B", sends))
        return accepted[-1]

    b.listeners[0x05] = b_ttp.server(lambda: server([b"b1", b"b2"]))
    b.listeners[0x06] = b_ttp.server(lambda: server([bytes(range(256)) * 4]), max_sdu_size=1500)
    b.ias.objects["Chat"] = {"IrDA:TinyTP:LsapSel": 0x05}

    devices = await a.discover()
    address = devices[0].address

    # SAR off: more SDUs than the initial credit, all delivered in order, credit recycled
    a_sends = [f"a{i:02}".encode() for i in range(3 * INITIAL_CREDIT)]
    endpoint, protocol = await a_ttp.connect(address, "Chat", lambda: Chatty("A", a_sends), data=b"hello")
    assert endpoint.get_extra_info("data_size") == 253
    assert endpoint.get_extra_info("max_sdu_size") == 0
    await asyncio.sleep(0.05)
    assert accepted[0].transport.get_extra_info("connect_data") == b"hello"

    assert await received(protocol, 2) == [b"b1", b"b2"]
    assert await received(accepted[0], len(a_sends)) == a_sends

    try:
        endpoint.write(bytes(254))
    except ValueError:
        pass
    else:
        raise AssertionError

    endpoint.close()
    assert await protocol.closed is None
    assert await accepted[0].closed is None

    # SAR on: segmented SDUs both ways, an oversized one refused locally
    big = bytes(range(256)) * 3
    endpoint, protocol = await a_ttp.connect(address, 0x06, lambda: Chatty("A", [big, bytes(1500)]), max_sdu_size=1024)
    assert endpoint.get_extra_info("max_sdu_size") == 1500

    assert await received(accepted[1], 2) == [big, bytes(1500)]
    assert await received(protocol, 1) == [bytes(range(256)) * 4]

    try:
        endpoint.write(bytes(1501))
    except ValueError:
        pass
    else:
        raise AssertionError

    # peer-initiated close with data still queued on our side
    for _ in range(20):
        endpoint.write(b"x")
    accepted[1].transport.close()
    assert await accepted[1].closed is None
    assert await protocol.closed is None

    await asyncio.sleep(LINGER_TIMEOUT + 1)
    assert a_lap.state.name == "NDM", a_lap.state
    assert b_lap.state.name == "NDM", b_lap.state

    logging.info("OK")


if __name__ == "__main__":
    asyncio.run(main())
