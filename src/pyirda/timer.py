import asyncio
from collections.abc import Callable


class Timer:
    def __init__(self, timeout: float, expire: Callable[[], None], delay: Callable[[], float] = lambda: 0.0) -> None:
        self.timeout = timeout
        self._expire = expire
        self._delay = delay
        self._handle: asyncio.TimerHandle | None = None

    def start(self) -> None:
        self.stop()
        self._handle = asyncio.get_running_loop().call_later(self._delay() + self.timeout, self._fire)

    def stop(self) -> None:
        if self._handle:
            self._handle.cancel()
            self._handle = None

    def _fire(self) -> None:
        self._handle = None
        self._expire()
