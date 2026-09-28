import { match, P } from "ts-pattern"

import { ascii, chunks, concat, EMPTY, equals, u16, view } from "../bytes.ts"
import { ConnectionClosed, IrdaError } from "../errors.ts"
import { log } from "../log.ts"
import type { Listener, TinyTP, TTPConnection } from "../tinytp/tinytp.ts"
import {
  DEFAULT_MAX_PACKET_LENGTH,
  FINAL,
  Header,
  MIN_PACKET_LENGTH,
  Opcode,
  ResponseCode,
  responseName,
  VERSION,
} from "./constants.ts"
import {
  body,
  decodeHeaders,
  encodeHeader,
  encodeHeaders,
  encodePacket,
  header,
  packets,
  type Headers,
  type Packet,
} from "./packet.ts"

const PACKET_OVERHEAD = 3
const CONNECTION_ID = 1
const OPCODES = new Set<number>(Object.values(Opcode))

export class OBEXError extends IrdaError {
  readonly code: number
  readonly headers: Headers

  constructor(code: number, headers: Headers = []) {
    super(responseName(code))
    this.code = code
    this.headers = headers
  }
}

class Session {
  readonly connection: TTPConnection
  readonly maxPacketLength: number
  peerMaxPacketLength = MIN_PACKET_LENGTH

  protected writer: WritableStreamDefaultWriter<Uint8Array>
  protected packets: AsyncGenerator<Packet>

  constructor(connection: TTPConnection, maxPacketLength = DEFAULT_MAX_PACKET_LENGTH) {
    this.connection = connection
    this.maxPacketLength = maxPacketLength
    this.writer = connection.writable.getWriter()
    this.packets = packets(connection.readable)
  }

  close() {
    return this.writer.close()
  }

  protected async send(packet: Uint8Array) {
    log.debug("<---", packet)

    for (const chunk of chunks(packet, this.connection.dataSize)) {
      await this.writer.write(chunk)
    }
  }

  protected async receive(): Promise<Packet> {
    const { value, done } = await this.packets.next()
    if (done) throw new ConnectionClosed()

    log.debug("--->", value)
    return value
  }

  protected packetsFor(head: Headers, content: Uint8Array | null, opcode: number, lastOpcode: number): Outgoing[] {
    const budget = this.peerMaxPacketLength - PACKET_OVERHEAD
    let encoded: Uint8Array = encodeHeaders(head)

    if (content === null) return [[encodePacket(lastOpcode, encoded), 0]]

    const result: Outgoing[] = []
    let position = 0

    for (;;) {
      const room = budget - encoded.length - PACKET_OVERHEAD

      if (room <= 0 && position < content.length) {
        throw new RangeError(
          `Headers of ${encoded.length} bytes leave no room in a ${this.peerMaxPacketLength} byte packet`,
        )
      }

      const chunk = content.subarray(position, position + Math.max(room, 0))
      position += chunk.length
      const last = position >= content.length

      const packet = encodePacket(
        last ? lastOpcode : opcode,
        encoded,
        encodeHeader(last ? Header.END_OF_BODY : Header.BODY, chunk),
      )
      result.push([packet, position])
      encoded = EMPTY

      if (last) return result
    }
  }
}

export type Progress = (transferred: number, total?: number) => void

type Outgoing = [packet: Uint8Array, transferred: number]

export interface ObjectOptions {
  type?: Uint8Array | string
  headers?: Headers
  progress?: Progress
  signal?: AbortSignal
}

export class Client extends Session {
  connectionId?: number
  #busy = false

  async connect(target?: Uint8Array, headers: Headers = []): Promise<Headers> {
    const head: Headers = [...(target ? [[Header.TARGET, target] as const] : []), ...headers]
    const packet = encodePacket(Opcode.CONNECT | FINAL, connectFields(this.maxPacketLength), encodeHeaders(head))
    const response = await this.#request(packet)

    this.peerMaxPacketLength = Math.max(view(response.payload).getUint16(2), MIN_PACKET_LENGTH)
    const responseHeaders = decodeHeaders(response.payload.subarray(4))
    const id = header(responseHeaders, Header.CONNECTION_ID)
    this.connectionId = typeof id === "number" ? id : undefined

    return responseHeaders
  }

  async disconnect(headers: Headers = []) {
    try {
      await this.#request(encodePacket(Opcode.DISCONNECT | FINAL, encodeHeaders(this.#headers(headers))))
    } finally {
      await this.close()
    }
  }

  async put(
    name?: string,
    content: Uint8Array | null = EMPTY,
    { type, headers = [], progress, signal }: ObjectOptions = {},
  ): Promise<Headers> {
    signal?.throwIfAborted()
    const head = this.#headers([...describe(name, type, content), ...headers])
    const packets = this.packetsFor(head, content, Opcode.PUT, Opcode.PUT | FINAL)
    const [last, lastTransferred] = packets.at(-1)!

    for (const [packet, transferred] of packets.slice(0, -1)) {
      await this.#request(packet, ResponseCode.CONTINUE)
      progress?.(transferred, content?.length)
      await this.#stopIfAborted(signal)
    }

    const response = await this.#request(last)
    progress?.(lastTransferred, content?.length)

    return decodeHeaders(response.payload)
  }

  async get(
    name?: string,
    { type, headers = [], progress, signal }: ObjectOptions = {},
  ): Promise<{ headers: Headers; content: Uint8Array }> {
    signal?.throwIfAborted()
    let packet = encodePacket(Opcode.GET | FINAL, encodeHeaders(this.#headers([...describe(name, type), ...headers])))
    const collected: Headers = []
    let content = EMPTY

    for (;;) {
      const response = await this.#request(packet, ResponseCode.CONTINUE)
      const responseHeaders = decodeHeaders(response.payload)

      collected.push(...withoutBody(responseHeaders))
      content = concat(content, body(responseHeaders) ?? EMPTY)
      progress?.(content.length, declaredLength(collected))

      if (response.code !== ResponseCode.CONTINUE) return { headers: collected, content }
      await this.#stopIfAborted(signal)

      packet = encodePacket(Opcode.GET | FINAL, encodeHeaders(this.#headers()))
    }
  }

  async setpath(name: string | null = "", flags = 0, headers: Headers = []): Promise<Headers> {
    const head = this.#headers([...(name === null ? [] : [[Header.NAME, name] as const]), ...headers])
    const packet = encodePacket(Opcode.SETPATH | FINAL, Uint8Array.of(flags, 0), encodeHeaders(head))

    return decodeHeaders((await this.#request(packet)).payload.subarray(2))
  }

  async #stopIfAborted(signal?: AbortSignal) {
    if (!signal?.aborted) return

    await this.#request(encodePacket(Opcode.ABORT | FINAL, encodeHeaders(this.#headers())))
    signal.throwIfAborted()
  }

  async #request(packet: Uint8Array, ...also: number[]): Promise<Packet> {
    if (this.#busy) throw new IrdaError("An operation is already in progress")

    this.#busy = true

    try {
      await this.send(packet)
      const response = await this.receive()

      if (!success(response.code) && !also.includes(response.code)) {
        throw new OBEXError(response.code, decodeHeaders(response.payload))
      }

      return response
    } finally {
      this.#busy = false
    }
  }

  #headers(headers: Headers = []): Headers {
    return [
      ...(this.connectionId === undefined ? [] : [[Header.CONNECTION_ID, this.connectionId] as const]),
      ...headers,
    ]
  }
}

export type OBEXObject = { headers: Headers; content: Uint8Array }

export interface Handlers {
  put?(headers: Headers, content: Uint8Array | null): number | Promise<number>
  get?(headers: Headers): OBEXObject | number | Promise<OBEXObject | number>
  setpath?(name: string | undefined, flags: number, headers: Headers): number | Promise<number>
  progress?(opcode: number, headers: Headers, transferred: number, total?: number): void
  target?: Uint8Array
}

type State = "IDLE" | "PUT" | "GET_REQUEST" | "GET_RESPONSE"

export class Server extends Session {
  readonly handlers: Handlers
  state: State = "IDLE"

  #headers: Headers = []
  #reply: Outgoing[] = []
  #replyLength = 0

  constructor(connection: TTPConnection, handlers: Handlers, maxPacketLength = DEFAULT_MAX_PACKET_LENGTH) {
    super(connection, maxPacketLength)
    this.handlers = handlers
  }

  async run() {
    try {
      for (;;) await this.#packetReceived(await this.receive())
    } catch (error) {
      log.debug("OBEX server connection lost", error)
    }
  }

  // --- state machine ---

  async #packetReceived(packet: Packet) {
    const state = this.state
    const headers = () => decodeHeaders(packet.payload)

    await match<[State, number, boolean]>([state, packet.code, packet.final])
      .with(["IDLE", Opcode.CONNECT, true], async () => {
        this.peerMaxPacketLength = Math.max(view(packet.payload).getUint16(2), MIN_PACKET_LENGTH)
        const target = header(decodeHeaders(packet.payload.subarray(4)), Header.TARGET)
        const directed = target instanceof Uint8Array && this.handlers.target && equals(target, this.handlers.target)
        const reply: Headers = directed
          ? [
              [Header.CONNECTION_ID, CONNECTION_ID],
              [Header.WHO, target],
            ]
          : []
        await this.send(
          encodePacket(ResponseCode.SUCCESS | FINAL, connectFields(this.maxPacketLength), encodeHeaders(reply)),
        )

        this.state = "IDLE"
      })

      .with(["IDLE", Opcode.DISCONNECT, true], async () => {
        await this.#respond(ResponseCode.SUCCESS)

        this.state = "IDLE"
      })

      .with([P.union("IDLE", "PUT"), Opcode.PUT, false], async () => {
        this.#headers.push(...headers())
        this.#progress(Opcode.PUT, bodyLength(this.#headers), declaredLength(this.#headers))
        await this.#respond(ResponseCode.CONTINUE)

        this.state = "PUT"
      })

      .with([P.union("IDLE", "PUT"), Opcode.PUT, true], async () => {
        this.#headers.push(...headers())
        this.#progress(Opcode.PUT, bodyLength(this.#headers), declaredLength(this.#headers))
        const put = this.handlers.put?.(withoutBody(this.#headers), body(this.#headers))
        await this.#respond(await (put ?? ResponseCode.NOT_IMPLEMENTED))

        this.state = "IDLE"
      })

      .with([P.union("IDLE", "GET_REQUEST"), Opcode.GET, false], async () => {
        this.#headers.push(...headers())
        await this.#respond(ResponseCode.CONTINUE)

        this.state = "GET_REQUEST"
      })

      .with([P.union("IDLE", "GET_REQUEST"), Opcode.GET, true], async () => {
        this.#headers.push(...headers())
        const result = await (this.handlers.get?.(this.#headers) ?? ResponseCode.NOT_FOUND)

        if (typeof result === "number") await this.#respond(result)
        else {
          this.#reply = this.packetsFor(
            result.headers,
            result.content,
            ResponseCode.CONTINUE | FINAL,
            ResponseCode.SUCCESS | FINAL,
          )
          this.#replyLength = result.content.length
        }

        await this.#replyNext()

        this.state = this.#reply.length ? "GET_RESPONSE" : "IDLE"
      })

      .with(["GET_RESPONSE", Opcode.GET, true], async () => {
        await this.#replyNext()

        this.state = this.#reply.length ? "GET_RESPONSE" : "IDLE"
      })

      .with([P._, Opcode.ABORT, true], async () => {
        await this.#respond(ResponseCode.SUCCESS)

        this.state = "IDLE"
      })

      .with([P._, Opcode.SETPATH, true], async () => {
        const setpathHeaders = decodeHeaders(packet.payload.subarray(2))
        const name = header(setpathHeaders, Header.NAME)
        const handler = this.handlers.setpath?.(
          typeof name === "string" ? name : undefined,
          packet.payload[0],
          setpathHeaders,
        )
        await this.#respond(await (handler ?? ResponseCode.NOT_IMPLEMENTED))

        this.state = "IDLE"
      })

      .with([P._, P.when((code) => !OPCODES.has(code)), P._], async () => {
        await this.#respond(ResponseCode.NOT_IMPLEMENTED)

        this.state = "IDLE"
      })

      .otherwise(async () => {
        await this.#respond(ResponseCode.BAD_REQUEST)

        this.state = "IDLE"
      })

    if (this.state === "IDLE") {
      this.#headers = []
      this.#reply = []
    }

    log.debug("<-->", this.state)
  }

  #respond(code: number, headers: Headers = []) {
    return this.send(encodePacket(code | FINAL, encodeHeaders(headers)))
  }

  async #replyNext() {
    const next = this.#reply.shift()
    if (!next) return

    const [packet, transferred] = next
    await this.send(packet)
    this.#progress(Opcode.GET, transferred, this.#replyLength)
  }

  #progress(opcode: number, transferred: number, total?: number) {
    this.handlers.progress?.(opcode, withoutBody(this.#headers), transferred, total)
  }
}

export interface ConnectOptions {
  service?: number | string
  target?: Uint8Array
  headers?: Headers
  maxPacketLength?: number
}

export class OBEX {
  readonly tinytp: TinyTP

  constructor(tinytp: TinyTP) {
    this.tinytp = tinytp
  }

  async connect(
    address: number,
    { service = "OBEX", target, headers, maxPacketLength }: ConnectOptions = {},
  ): Promise<Client> {
    const client = new Client(await this.tinytp.connect(address, service), maxPacketLength)

    try {
      await client.connect(target, headers)
    } catch (error) {
      await client.close().catch(() => {})
      throw error
    }

    return client
  }

  server(handlers: Handlers, maxPacketLength?: number): Listener {
    return (connection) => void new Server(connection, handlers, maxPacketLength).run()
  }
}

const connectFields = (maxPacketLength: number) => concat(Uint8Array.of(VERSION, 0), u16(maxPacketLength))

function describe(name?: string, type?: Uint8Array | string, content?: Uint8Array | null): Headers {
  const headers: Headers = []

  if (name !== undefined) headers.push([Header.NAME, name])
  if (type !== undefined)
    headers.push([Header.TYPE, typeof type === "string" ? concat(ascii(type), Uint8Array.of(0)) : type])
  if (content?.length) headers.push([Header.LENGTH, content.length])

  return headers
}

const isBody = ([id]: Headers[number]) => id === Header.BODY || id === Header.END_OF_BODY

const withoutBody = (headers: Headers) => headers.filter((entry) => !isBody(entry))

const bodyLength = (headers: Headers) =>
  headers.filter(isBody).reduce((length, [, value]) => length + (value as Uint8Array).length, 0)

function declaredLength(headers: Headers): number | undefined {
  const length = header(headers, Header.LENGTH)
  return typeof length === "number" ? length : undefined
}

const success = (code: number) => code >= ResponseCode.SUCCESS && code < ResponseCode.MULTIPLE_CHOICES
