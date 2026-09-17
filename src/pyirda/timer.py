import asyncio
from typing import Callable


class Timer:
    def __init__(self, timeout: float, dispatch: Callable) -> None:
        self.timeout = timeout
        self._dispatch = dispatch
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self.stop()
        self._task = asyncio.get_event_loop().create_task(self._run())

    def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None

    async def _run(self) -> None:
        await asyncio.sleep(self.timeout)
        self._dispatch(self)
