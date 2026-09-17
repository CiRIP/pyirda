import asyncio
import logging

from pyirda.irlap import IrLAP
from pyirda.irlap.constants import BAUD_RATE

logging.basicConfig(level=logging.DEBUG, format="%(relativeCreated)6d %(name)-24s %(message)s")


class Wire(asyncio.Transport):
    """Delivers written bytes to the peer after the time they would occupy at 9600 baud."""

    def __init__(self) -> None:
        super().__init__()
        self.peer: IrLAP | None = None
        self._busy_until = 0.0

    def write(self, data: bytes) -> None:
        loop = asyncio.get_running_loop()
        self._busy_until = max(loop.time(), self._busy_until) + len(data) * 10 / BAUD_RATE
        loop.call_at(self._busy_until, self.peer.data_received, data)


class LossyWire(Wire):
    """Loses the first frame carrying the given marker."""

    def __init__(self, lose: bytes) -> None:
        super().__init__()
        self.lose = lose

    def write(self, data: bytes) -> None:
        if self.lose and self.lose in data:
            logging.info("*** losing frame carrying %s", self.lose)
            self.lose = b""
            return

        super().write(data)


class Chatty(asyncio.Protocol):
    def __init__(self, name: str, send: list[bytes]) -> None:
        self.name = name
        self.send = send
        self.received: list[bytes] = []
        self.closed = asyncio.get_running_loop().create_future()

    def connection_made(self, transport: asyncio.Transport) -> None:
        self.transport = transport
        for data in self.send:
            transport.write(data)

    def data_received(self, data: bytes) -> None:
        self.received.append(data)

    def connection_lost(self, exc: Exception | None) -> None:
        self.closed.set_result(exc)


async def main(lose: bytes = b"") -> None:
    a_sends = [b"a1", b"a2", b"a3", b"a4", b"a5", b"a6", b"a7", b"a8", b"a9"]
    b_sends = [b"b1", b"b2", b"b3"]

    a = IrLAP(lambda: Chatty("A", a_sends), discovery_info=b"\x80\x00A")
    b = IrLAP(lambda: Chatty("B", b_sends), discovery_info=b"\x80\x00B")

    ab, ba = LossyWire(lose), Wire()
    ab.peer, ba.peer = b, a
    a.connection_made(ab)
    b.connection_made(ba)

    devices = await a.discover()
    assert len(devices) == 1, devices
    assert devices[0].discovery_info == b"\x80\x00B"

    link, protocol = await a.connect(devices[0])
    await asyncio.sleep(0.05)
    assert b.protocol is not None

    while len(protocol.received) < len(b_sends) or len(b.protocol.received) < len(a_sends):
        await asyncio.sleep(0.1)

    assert protocol.received == b_sends, protocol.received
    assert b.protocol.received == a_sends, b.protocol.received

    await asyncio.sleep(1.2)

    peer = b.protocol
    link.close()
    assert await protocol.closed is None
    assert await peer.closed is None
    assert a.state.name == "NDM" and b.state.name == "NDM"

    logging.info("OK")


if __name__ == "__main__":
    asyncio.run(main())
    asyncio.run(main(lose=b"a1"))
    asyncio.run(main(lose=b"a9"))
