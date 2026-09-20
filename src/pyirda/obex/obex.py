import asyncio
import logging
from collections import deque
from enum import Enum, auto

from pyirda.exceptions import IrdaException
from pyirda.obex.constants import DEFAULT_MAX_PACKET_LENGTH, FINAL, MIN_PACKET_LENGTH, Header, Opcode, Response
from pyirda.obex.packet import ConnectPacket, Headers, OBEXPacket, SetPathPacket, encode_header, encode_headers
from pyirda.tinytp import TinyTP

logger = logging.getLogger(__name__)

PACKET_OVERHEAD = 3
BODY_HEADERS = (Header.BODY, Header.END_OF_BODY)


class OBEXError(IrdaException):
    def __init__(self, code: int, headers: Headers = ()) -> None:
        super().__init__(_name(code))
        self.code = code
        self.headers = headers


class Session(asyncio.Protocol):
    def __init__(self, max_packet_length: int = DEFAULT_MAX_PACKET_LENGTH) -> None:
        self.max_packet_length = max_packet_length
        self.peer_max_packet_length = MIN_PACKET_LENGTH
        self.transport: asyncio.Transport | None = None
        self._rx = bytearray()

    def connection_made(self, transport: asyncio.Transport) -> None:
        self.transport = transport

    def data_received(self, data: bytes) -> None:
        self._rx += data

        while len(self._rx) >= PACKET_OVERHEAD and (length := int.from_bytes(self._rx[1:3], "big")) <= len(self._rx):
            packet = OBEXPacket.parse(bytes(self._rx[:length]))
            del self._rx[:length]
            logger.debug("---> %s", packet)
            self.packet_received(packet)

    def packet_received(self, packet: OBEXPacket) -> None:
        raise NotImplementedError

    def send(self, packet: OBEXPacket) -> None:
        logger.debug("<--- %s", packet)
        raw = bytes(packet.payload)
        size = self.transport.get_extra_info("data_size")

        for i in range(0, len(raw), size):
            self.transport.write(raw[i : i + size])

    def _packets(self, head: Headers, body: bytes | None, opcode: int, last_opcode: int) -> list[OBEXPacket]:
        budget = self.peer_max_packet_length - PACKET_OVERHEAD
        encoded = encode_headers(head)

        if body is None:
            return [OBEXPacket(last_opcode, encoded)]

        packets, position = [], 0
        while True:
            room = budget - len(encoded) - PACKET_OVERHEAD
            if room <= 0 < len(body) - position:
                msg = f"Headers of {len(encoded)} bytes leave no room in a {self.peer_max_packet_length} byte packet"
                raise ValueError(msg)

            chunk = body[position : position + room]
            position += len(chunk)
            last = position >= len(body)
            packets.append(OBEXPacket(last_opcode if last else opcode, encoded + encode_header(_body(last), chunk)))
            encoded = b""

            if last:
                return packets


class Client(Session):
    def __init__(self, max_packet_length: int = DEFAULT_MAX_PACKET_LENGTH) -> None:
        super().__init__(max_packet_length)
        self.connection_id: int | None = None
        self._response: asyncio.Future[OBEXPacket] | None = None

    def connection_lost(self, exc: Exception | None) -> None:
        if self._response and not self._response.done():
            self._response.set_exception(exc or ConnectionResetError())

    def packet_received(self, packet: OBEXPacket) -> None:
        if self._response and not self._response.done():
            self._response.set_result(packet)

    async def request(self, packet: OBEXPacket, *also: int) -> OBEXPacket:
        if self._response:
            msg = "An operation is already in progress"
            raise RuntimeError(msg)

        self._response = asyncio.get_running_loop().create_future()
        self.send(packet)

        try:
            response = await self._response
        finally:
            self._response = None

        if not _success(response.code) and response.code not in also:
            raise OBEXError(response.code, response.headers)

        return response

    async def connect(self, target: bytes | None = None, headers: Headers = ()) -> Headers:
        head = ([(Header.TARGET, target)] if target else []) + list(headers)
        response = await self.request(ConnectPacket(Opcode.CONNECT | FINAL, self.max_packet_length, head))
        response = ConnectPacket.from_bytes(bytes(response.payload))

        self.peer_max_packet_length = max(response.max_packet_length, MIN_PACKET_LENGTH)
        self.connection_id = next((value for hi, value in response.headers if hi == Header.CONNECTION_ID), None)

        return response.headers

    async def disconnect(self, headers: Headers = ()) -> None:
        try:
            await self.request(OBEXPacket(Opcode.DISCONNECT | FINAL, encode_headers(self._headers(headers))))
        finally:
            self.transport.close()

    async def put(
        self, name: str | None = None, body: bytes | None = b"", mimetype: bytes | None = None, headers: Headers = ()
    ) -> Headers:
        head = self._headers(_describe(name, mimetype, body) + list(headers))
        packets = self._packets(head, body, Opcode.PUT, Opcode.PUT | FINAL)

        for packet in packets[:-1]:
            await self.request(packet, Response.CONTINUE)

        return (await self.request(packets[-1])).headers

    async def get(
        self, name: str | None = None, mimetype: bytes | None = None, headers: Headers = ()
    ) -> tuple[Headers, bytes]:
        head = self._headers(_describe(name, mimetype) + list(headers))
        packet = OBEXPacket(Opcode.GET | FINAL, encode_headers(head))
        collected, body = [], bytearray()

        while True:
            response = await self.request(packet, Response.CONTINUE)
            collected += [(hi, value) for hi, value in response.headers if hi not in BODY_HEADERS]
            body += response.body or b""

            if response.code != Response.CONTINUE:
                return collected, bytes(body)

            packet = OBEXPacket(Opcode.GET | FINAL, encode_headers(self._headers()))

    async def setpath(self, name: str | None = "", flags: int = 0, headers: Headers = ()) -> Headers:
        head = self._headers(([(Header.NAME, name)] if name is not None else []) + list(headers))

        return (await self.request(SetPathPacket(Opcode.SETPATH | FINAL, flags, head))).headers

    async def abort(self, headers: Headers = ()) -> None:
        await self.request(OBEXPacket(Opcode.ABORT | FINAL, encode_headers(self._headers(headers))))

    def _headers(self, headers: Headers = ()) -> Headers:
        return ([(Header.CONNECTION_ID, self.connection_id)] if self.connection_id is not None else []) + list(headers)


class State(Enum):
    IDLE = auto()
    PUT = auto()
    GET_REQUEST = auto()
    GET_RESPONSE = auto()


class Server(Session):
    def __init__(self, max_packet_length: int = DEFAULT_MAX_PACKET_LENGTH) -> None:
        super().__init__(max_packet_length)
        self.state = State.IDLE
        self._headers: Headers = []
        self._reply: deque[OBEXPacket] = deque()

    # --- hooks ---

    def put(self, headers: Headers, body: bytes | None) -> int:
        return Response.NOT_IMPLEMENTED

    def get(self, headers: Headers) -> tuple[Headers, bytes] | int:
        return Response.NOT_FOUND

    def setpath(self, name: str | None, flags: int, headers: Headers) -> int:
        return Response.NOT_IMPLEMENTED

    # --- state machine ---

    def connection_lost(self, exc: Exception | None) -> None:
        pass

    def packet_received(self, packet: OBEXPacket) -> None:
        state = self.state

        match (state, packet.code, packet.final):
            case (State.IDLE, Opcode.CONNECT, True):
                connect = ConnectPacket.from_bytes(bytes(packet.payload))
                self.peer_max_packet_length = max(connect.max_packet_length, MIN_PACKET_LENGTH)
                self.send(ConnectPacket(Response.SUCCESS | FINAL, self.max_packet_length))

                self.state = State.IDLE

            case (State.IDLE, Opcode.DISCONNECT, True):
                self._respond(Response.SUCCESS)

                self.state = State.IDLE

            case (State.IDLE | State.PUT, Opcode.PUT, False):
                self._headers += packet.headers
                self._respond(Response.CONTINUE)

                self.state = State.PUT

            case (State.IDLE | State.PUT, Opcode.PUT, True):
                self._headers += packet.headers
                chunks = [value for hi, value in self._headers if hi in BODY_HEADERS]
                headers = [(hi, value) for hi, value in self._headers if hi not in BODY_HEADERS]
                self._respond(self.put(headers, b"".join(chunks) if chunks else None))

                self.state = State.IDLE

            case (State.IDLE | State.GET_REQUEST, Opcode.GET, False):
                self._headers += packet.headers
                self._respond(Response.CONTINUE)

                self.state = State.GET_REQUEST

            case (State.IDLE | State.GET_REQUEST, Opcode.GET, True):
                self._headers += packet.headers
                result = self.get(self._headers)

                if isinstance(result, int):
                    self._respond(result)
                else:
                    self._reply.extend(self._packets(*result, Response.CONTINUE | FINAL, Response.SUCCESS | FINAL))

                self._reply_next()

                self.state = State.GET_RESPONSE if self._reply else State.IDLE

            case (State.GET_RESPONSE, Opcode.GET, True):
                self._reply_next()

                self.state = State.GET_RESPONSE if self._reply else State.IDLE

            case (_, Opcode.ABORT, True):
                self._respond(Response.SUCCESS)

                self.state = State.IDLE

            case (_, Opcode.SETPATH, True):
                setpath = SetPathPacket.from_bytes(bytes(packet.payload))
                name = next((value for hi, value in setpath.headers if hi == Header.NAME), None)
                self._respond(self.setpath(name, setpath.flags, setpath.headers))

                self.state = State.IDLE

            case (_, code, _) if code not in Opcode:
                self._respond(Response.NOT_IMPLEMENTED)

                self.state = State.IDLE

            case _:
                self._respond(Response.BAD_REQUEST)

                self.state = State.IDLE

        if self.state is State.IDLE:
            self._headers = []
            self._reply.clear()

        logger.debug("<--> %s", self.state)

    def _respond(self, code: int, headers: Headers = ()) -> None:
        self.send(OBEXPacket(code | FINAL, encode_headers(headers)))

    def _reply_next(self) -> None:
        if self._reply:
            self.send(self._reply.popleft())


class OBEX:
    def __init__(self, tinytp: TinyTP) -> None:
        self.tinytp = tinytp

    async def connect(
        self,
        address: int,
        service: int | str = "OBEX",
        target: bytes | None = None,
        headers: Headers = (),
        max_packet_length: int = DEFAULT_MAX_PACKET_LENGTH,
    ) -> Client:
        client: Client
        endpoint, client = await self.tinytp.connect(address, service, lambda: Client(max_packet_length))

        try:
            await client.connect(target, headers)
        except BaseException:
            endpoint.close()
            raise

        return client


def _describe(name: str | None, mimetype: bytes | None, body: bytes | None = None) -> Headers:
    headers = []

    if name is not None:
        headers.append((Header.NAME, name))
    if mimetype is not None:
        headers.append((Header.TYPE, mimetype))
    if body:
        headers.append((Header.LENGTH, len(body)))

    return headers


def _body(last: bool) -> Header:
    return Header.END_OF_BODY if last else Header.BODY


def _success(code: int) -> bool:
    return Response.SUCCESS <= code < Response.MULTIPLE_CHOICES


def _name(code: int) -> str:
    try:
        return Response(code).name
    except ValueError:
        return f"{code:#04x}"
