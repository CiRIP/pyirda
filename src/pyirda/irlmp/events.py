from dataclasses import dataclass

from pyirda.events import Event, Request


@dataclass(frozen=True)
class ConnectRequest(Request):
    data: bytes


@dataclass(frozen=True)
class ConnectResponse(Request):
    data: bytes


@dataclass(frozen=True)
class DisconnectRequest(Request):
    pass


@dataclass(frozen=True)
class DataRequest(Request):
    pass


@dataclass(frozen=True)
class LSConnectConfirm(Event):
    pass


@dataclass(frozen=True)
class LSDisconnectIndication(Event):
    exc: Exception | None


@dataclass(frozen=True)
class WatchdogExpired(Event):
    pass
