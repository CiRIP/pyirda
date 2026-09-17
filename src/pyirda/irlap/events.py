from dataclasses import dataclass


@dataclass(frozen=True)
class Event:
    pass


class Request(Event):
    pass


@dataclass(frozen=True)
class DiscoveryRequest(Request):
    pass


@dataclass(frozen=True)
class ConnectRequest(Request):
    address: int


@dataclass(frozen=True)
class ConnectResponse(Request):
    pass


@dataclass(frozen=True)
class DisconnectRequest(Request):
    pass


@dataclass(frozen=True)
class DataRequest(Request):
    pass


@dataclass(frozen=True)
class SlotTimerExpired(Event):
    pass


@dataclass(frozen=True)
class QueryTimerExpired(Event):
    pass


@dataclass(frozen=True)
class PTimerExpired(Event):
    pass


@dataclass(frozen=True)
class FTimerExpired(Event):
    pass


@dataclass(frozen=True)
class WDTimerExpired(Event):
    pass
