class Event:
    pass

class DiscoveryRequest(Event):
    pass

class ConnectRequest(Event):
    def __init__(self, address: int):
        self.address = address

class ConnectResponse(Event):
    pass

class DisconnectRequest(Event):
    pass

class DataRequest(Event):
    def __init__(self, data: bytes):
        self.data = data

class ResetRequest(Event):
    pass
