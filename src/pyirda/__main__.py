import asyncio
import logging

import serial_asyncio

from .irlap import Frame, IrLAP

logging.basicConfig(
    level=logging.DEBUG,
)

logger = logging.getLogger(__name__)

class Sniffer(IrLAP):
    def _dispatch(self, frame: Frame) -> None:
        logging.info(frame)


async def main() -> None:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("port", help="Serial port, e.g. COM3 or /dev/ttyUSB0")
    parser.add_argument("--baud", type=int, default=9600)
    args = parser.parse_args()

    protocol: IrLAP
    transport, protocol = await serial_asyncio.create_serial_connection(
        asyncio.get_running_loop(),
        IrLAP,
        args.port,
        baudrate=args.baud,
    )

    await protocol.ready.wait()

    discovered = await protocol.discover()
    logger.info("Found devices: %s", discovered)

    if discovered:
        await protocol.connect(discovered[0])
        await protocol.send(b"\x00\x00")

    try:
        await asyncio.get_running_loop().create_future()  # run forever
    except KeyboardInterrupt:
        transport.close()


if __name__ == "__main__":
    asyncio.run(main())
