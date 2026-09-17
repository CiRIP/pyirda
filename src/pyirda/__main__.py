import argparse
import asyncio
import logging

import serial_asyncio

from .irlap import IrLAP

logging.basicConfig(level=logging.DEBUG)

logger = logging.getLogger(__name__)


class Echo(asyncio.Protocol):
    def connection_made(self, transport: asyncio.Transport) -> None:
        logger.info("Link up, max frame %d bytes", transport.get_extra_info("data_size"))
        transport.write(b"hello")

    def data_received(self, data: bytes) -> None:
        logger.info("Received %s", data)

    def connection_lost(self, exc: Exception | None) -> None:
        logger.info("Link down: %s", exc)


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("port", help="Serial port, e.g. COM3 or /dev/ttyUSB0")
    args = parser.parse_args()

    irlap: IrLAP
    transport, irlap = await serial_asyncio.create_serial_connection(
        asyncio.get_running_loop(),
        lambda: IrLAP(Echo),
        args.port,
        baudrate=9600,
    )

    devices = await irlap.discover()
    logger.info("Found devices: %s", devices)

    if devices:
        await irlap.connect(devices[0])

    try:
        await asyncio.get_running_loop().create_future()
    finally:
        transport.close()


if __name__ == "__main__":
    asyncio.run(main())
