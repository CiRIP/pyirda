import argparse
import asyncio
import logging

import serial_asyncio

from .irlap import IrLAP
from .irlmp import IrLMP

logging.basicConfig(level=logging.DEBUG)

logger = logging.getLogger(__name__)


class Echo(asyncio.Protocol):
    def connection_made(self, transport: asyncio.Transport) -> None:
        logger.info("Connected, max %d bytes per write", transport.get_extra_info("data_size"))
        transport.write(b"hello")

    def data_received(self, data: bytes) -> None:
        logger.info("Received %s", data)

    def connection_lost(self, exc: Exception | None) -> None:
        logger.info("Disconnected: %s", exc)


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("port", help="Serial port, e.g. COM3 or /dev/ttyUSB0")
    parser.add_argument("service", nargs="?", default="Echo", help="IAS class name or LSAP selector to connect to")
    args = parser.parse_args()

    irlap = IrLAP()
    irlmp = IrLMP(irlap, nickname="pyirda")
    irlmp.listeners[0x05] = Echo
    irlmp.ias.objects["Echo"] = {"IrDA:IrLMP:LsapSel": 0x05}

    transport, _ = await serial_asyncio.create_serial_connection(
        asyncio.get_running_loop(), lambda: irlap, args.port, baudrate=9600
    )

    devices = await irlmp.discover()
    logger.info("Found devices: %s", devices)

    try:
        service = int(args.service, 0)
    except ValueError:
        service = args.service

    if devices:
        await irlmp.connect(devices[0].address, service, Echo)

    try:
        await asyncio.get_running_loop().create_future()
    finally:
        transport.close()


if __name__ == "__main__":
    asyncio.run(main())
