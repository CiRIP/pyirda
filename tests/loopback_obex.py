import asyncio
import logging
from typing import ClassVar

from loopback import Wire

from pyirda.irlap import IrLAP
from pyirda.irlmp import Hints, IrLMP
from pyirda.irlmp.constants import LINGER_TIMEOUT
from pyirda.obex import OBEX, Header, OBEXError, Response, Server
from pyirda.obex.packet import Headers
from pyirda.tinytp import TinyTP

logging.basicConfig(level=logging.DEBUG, format="%(relativeCreated)6d %(name)-24s %(message)s")


class Inbox(Server):
    objects: ClassVar[dict[str, bytes]] = {}
    puts: ClassVar[list[tuple[Headers, bytes | None]]] = []

    def put(self, headers: Headers, body: bytes | None) -> int:
        self.puts.append((headers, body))
        name = next(value for hi, value in headers if hi == Header.NAME)

        if name == "secret":
            return Response.FORBIDDEN

        self.objects[name] = body
        return Response.SUCCESS

    def get(self, headers: Headers) -> tuple[Headers, bytes] | int:
        name = next(value for hi, value in headers if hi == Header.NAME)

        if name not in self.objects:
            return Response.NOT_FOUND

        return [(Header.NAME, name), (Header.LENGTH, len(self.objects[name]))], self.objects[name]


def stack(name: str) -> tuple[IrLAP, IrLMP, OBEX]:
    irlap = IrLAP()
    irlmp = IrLMP(irlap, nickname=name, hints=Hints.COMPUTER | Hints.OBEX)

    return irlap, irlmp, OBEX(TinyTP(irlmp))


async def main() -> None:
    a_lap, a, a_obex = stack("A")
    b_lap, b, b_obex = stack("B")

    ab, ba = Wire(), Wire()
    ab.peer, ba.peer = b_lap, a_lap
    a_lap.connection_made(ab)
    b_lap.connection_made(ba)

    b.listeners[0x05] = b_obex.tinytp.server(Inbox)
    b.ias.objects["OBEX"] = {"IrDA:TinyTP:LsapSel": 0x05}

    devices = await a.discover()
    assert devices[0].hints & Hints.OBEX
    address = devices[0].address

    client = await a_obex.connect(address, max_packet_length=600)
    assert client.peer_max_packet_length == 1024

    # multi-packet PUT, packets spanning several TTP SDUs
    jumar = bytes(range(256)) * 12
    await client.put("jumar.txt", jumar, b"text/plain\x00")
    assert Inbox.objects["jumar.txt"] == jumar
    headers, body = Inbox.puts[-1]
    assert (Header.NAME, "jumar.txt") in headers
    assert (Header.TYPE, b"text/plain\x00") in headers
    assert (Header.LENGTH, len(jumar)) in headers

    # create-empty and delete
    await client.put("empty", b"")
    assert Inbox.objects["empty"] == b""
    await client.put("gone", None)
    assert Inbox.puts[-1][1] is None

    # refused PUT
    try:
        await client.put("secret", b"x")
    except OBEXError as exc:
        assert exc.code == Response.FORBIDDEN
    else:
        raise AssertionError

    # multi-packet GET
    headers, body = await client.get("jumar.txt")
    assert body == jumar
    assert (Header.LENGTH, len(jumar)) in headers

    try:
        await client.get("missing")
    except OBEXError as exc:
        assert exc.code == Response.NOT_FOUND
    else:
        raise AssertionError

    # unsupported operations
    try:
        await client.setpath("dir")
    except OBEXError as exc:
        assert exc.code == Response.NOT_IMPLEMENTED
    else:
        raise AssertionError

    await client.abort()
    await client.disconnect()

    await asyncio.sleep(LINGER_TIMEOUT + 1)
    assert a_lap.state.name == "NDM", a_lap.state
    assert b_lap.state.name == "NDM", b_lap.state

    logging.info("OK")


if __name__ == "__main__":
    asyncio.run(main())
