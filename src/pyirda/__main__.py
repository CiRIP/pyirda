import argparse
import asyncio
import logging
from pathlib import Path

import serial_asyncio

from .irlap import IrLAP
from .irlmp import Hints, IrLMP
from .obex import OBEX, Header, Response, Server
from .obex.packet import Headers
from .tinytp import TinyTP

logging.basicConfig(level=logging.INFO)

logger = logging.getLogger(__name__)


class Inbox(Server):
    def put(self, headers: Headers, body: bytes | None) -> int:
        name = next((value for hi, value in headers if hi == Header.NAME), "unnamed")

        if body is None:
            return Response.FORBIDDEN

        Path(Path(name).name).write_bytes(body)
        logger.info("Received %s (%d bytes)", name, len(body))

        return Response.SUCCESS


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("port", help="Serial port, e.g. COM3 or /dev/ttyUSB0")
    parser.add_argument(
        "file", nargs="?", type=Path, help="File to send; without it, receive into the current directory"
    )
    args = parser.parse_args()

    irlap = IrLAP()
    irlmp = IrLMP(irlap, nickname="pyirda", hints=Hints.COMPUTER | Hints.OBEX)
    tinytp = TinyTP(irlmp)
    irlmp.listeners[0x05] = tinytp.server(Inbox)
    irlmp.ias.objects["OBEX"] = {"IrDA:TinyTP:LsapSel": 0x05}

    transport, _ = await serial_asyncio.create_serial_connection(
        asyncio.get_running_loop(), lambda: irlap, args.port, baudrate=9600
    )

    try:
        if args.file:
            await send(irlmp, OBEX(tinytp), args.file)
        else:
            await asyncio.get_running_loop().create_future()
    finally:
        transport.close()


async def send(irlmp: IrLMP, obex: OBEX, file: Path) -> None:
    devices = await irlmp.discover()
    logger.info("Found devices: %s", devices)

    device = next(device for device in devices if device.hints & Hints.OBEX)
    client = await obex.connect(device.address)
    await client.put(file.name, file.read_bytes())
    await client.disconnect()
    logger.info("Sent %s to %s", file.name, device.nickname)


if __name__ == "__main__":
    asyncio.run(main())
