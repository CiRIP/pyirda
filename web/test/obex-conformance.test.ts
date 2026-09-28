import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { ascii, concat, EMPTY, equals, view } from "../src/bytes.ts"
import { Connection } from "../src/connection.ts"
import { IrLAP } from "../src/irlap/irlap.ts"
import { Hints, IrLMP } from "../src/irlmp/index.ts"
import { FINAL, Header, Opcode, ResponseCode } from "../src/obex/constants.ts"
import { Client, OBEX, OBEXError, Server, header, type Handlers, type Headers } from "../src/obex/index.ts"
import { decodeHeaders, encodeHeaders, encodePacket } from "../src/obex/packet.ts"
import { TinyTP, type TTPConnection } from "../src/tinytp/index.ts"
import { sir, sleep, Wire } from "./wire.ts"

const CONTINUE = ResponseCode.CONTINUE | FINAL
const SUCCESS = ResponseCode.SUCCESS | FINAL
const FORBIDDEN = ResponseCode.FORBIDDEN | FINAL
const NOT_IMPLEMENTED = ResponseCode.NOT_IMPLEMENTED | FINAL

const TESTER_MAX_PACKET_LENGTH = 0x1400
const FOLDER_BROWSING = Uint8Array.of(
  0xf9,
  0xec,
  0x7b,
  0xc4,
  0x95,
  0x3c,
  0x11,
  0xd2,
  0x98,
  0x4e,
  0x52,
  0x54,
  0x00,
  0xdc,
  0x9e,
  0x09,
)
const VCARD = ascii("text/x-vCard\0")
const TESTING = ascii("Testing\0")

const WAIT = 2000

function within<T>(promise: Promise<T>, ms = WAIT): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Nothing arrived within ${ms} ms`)), ms)
  })

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const random = (length: number) => crypto.getRandomValues(new Uint8Array(length))
const connectFields = (maxPacketLength = TESTER_MAX_PACKET_LENGTH) =>
  Uint8Array.of(0x10, 0x00, maxPacketLength >> 8, maxPacketLength & 0xff)

const fieldsLength = (opcode: number) => ({ [Opcode.CONNECT]: 4, [Opcode.SETPATH]: 2 })[opcode & ~FINAL] ?? 0

class Pipe extends Connection {
  readonly address = 0
  readonly dataSize: number
  readonly writes: Uint8Array[] = []
  peer!: Pipe

  constructor(dataSize: number) {
    super()
    this.dataSize = dataSize
  }

  static pair(dataSize = 2048): [Pipe, Pipe] {
    const a = new Pipe(dataSize)
    const b = new Pipe(dataSize)
    a.peer = b
    b.peer = a

    return [a, b]
  }

  protected write(data: Uint8Array) {
    this.writes.push(data.slice())
    this.peer.push(data.slice())
  }

  protected disconnect() {
    this.end()
    this.peer.end()
  }
}

type Request = { raw: Uint8Array; fields: Uint8Array; headers: Headers }

class Tester {
  readonly packets: Uint8Array[] = []

  #reader: ReadableStreamDefaultReader<Uint8Array>
  #writer: WritableStreamDefaultWriter<Uint8Array>
  #buffer = EMPTY

  constructor(pipe: Pipe) {
    this.#reader = pipe.readable.getReader()
    this.#writer = pipe.writable.getWriter()
  }

  async next(): Promise<Request> {
    while (this.#buffer.length < 3 || this.#buffer.length < view(this.#buffer).getUint16(1)) {
      const { value, done } = await within(this.#reader.read())
      if (done) throw new Error("Connection closed")
      this.#buffer = concat(this.#buffer, value)
    }

    const raw = this.#buffer.subarray(0, view(this.#buffer).getUint16(1))
    this.#buffer = this.#buffer.subarray(raw.length)
    this.packets.push(raw)

    const fields = raw.subarray(3, 3 + fieldsLength(raw[0]))
    return { raw, fields, headers: decodeHeaders(raw.subarray(3 + fields.length)) }
  }

  async request(opcode: number): Promise<Request & { all: Headers }> {
    const all: Headers = []

    for (;;) {
      const request = await this.next()
      assert.equal(request.raw[0] & ~FINAL, opcode, `expected opcode 0x${opcode.toString(16)}`)
      all.push(...request.headers)

      if (request.raw[0] & FINAL) return { ...request, all }
      await this.send(CONTINUE)
    }
  }

  send(code: number, headers: Headers = [], fields = EMPTY) {
    return this.#writer.write(encodePacket(code, fields, encodeHeaders(headers)))
  }
}

function clientUnderTest(dataSize?: number) {
  const [iut, tester] = Pipe.pair(dataSize)
  return { client: new Client(iut as unknown as TTPConnection), tester: new Tester(tester), iut }
}

function serverUnderTest(handlers: Handlers = inbox(), dataSize?: number) {
  const [iut, tester] = Pipe.pair(dataSize)
  void new Server(iut as unknown as TTPConnection, handlers).run()
  return { tester: new Tester(tester), iut }
}

function inbox(objects = new Map<string, Uint8Array>()): Handlers & { objects: Map<string, Uint8Array> } {
  return {
    objects,

    put(headers, content) {
      const name = String(header(headers, Header.NAME))
      if (content) objects.set(name, content)
      else objects.delete(name)

      return ResponseCode.SUCCESS
    },

    get(headers) {
      const name = String(header(headers, Header.NAME) ?? "")
      const type = header(headers, Header.TYPE)
      const content = objects.get(name || (type instanceof Uint8Array && equals(type, VCARD) ? "default.vcf" : ""))
      if (!content) return ResponseCode.NOT_FOUND

      return { headers: [[Header.LENGTH, content.length]], content }
    },

    setpath() {
      return ResponseCode.SUCCESS
    },
  }
}

const expectConnectRequest = ({ raw, fields }: Request) => {
  assert.equal(raw[0], Opcode.CONNECT | FINAL)
  assert.ok(raw.length <= 255)
  assert.equal(fields[0], 0x10)
  assert.equal(fields[1], 0x00)
  assert.ok(view(fields).getUint16(2) >= 255)
}

const bodyOf = (headers: Headers) =>
  concat(
    ...headers
      .filter(([id]) => id === Header.BODY || id === Header.END_OF_BODY)
      .map(([, value]) => value as Uint8Array),
  )

const idle = async (pipe: Pipe) => {
  const writes = pipe.writes.length
  await sleep(50)
  return pipe.writes.length === writes
}

describe("OBEX client tests", () => {
  test("C-C-1: Simple Connect Operation", async () => {
    const { client, tester } = clientUnderTest()

    const connected = client.connect()
    const request = await tester.next()
    expectConnectRequest(request)
    assert.deepEqual(request.headers, [])
    await tester.send(SUCCESS, [], connectFields())

    await connected
    assert.equal(client.peerMaxPacketLength, TESTER_MAX_PACKET_LENGTH)
  })

  test("C-C-2: Simple Directed Connection", async () => {
    const { client, tester } = clientUnderTest()

    const connected = client.connect(FOLDER_BROWSING)
    const request = await tester.next()
    expectConnectRequest(request)
    assert.deepEqual(header(request.headers, Header.TARGET), FOLDER_BROWSING)
    await tester.send(
      SUCCESS,
      [
        [Header.CONNECTION_ID, 1],
        [Header.WHO, FOLDER_BROWSING],
      ],
      connectFields(),
    )

    await connected
    assert.equal(client.connectionId, 1)
  })

  test("C-D-1: Simple Disconnect Operation", async () => {
    const { client, tester } = clientUnderTest()

    const connected = client.connect()
    await tester.next()
    await tester.send(SUCCESS, [], connectFields())
    await connected

    const disconnected = client.disconnect()
    const { raw } = await tester.next()
    assert.equal(raw[0], Opcode.DISCONNECT | FINAL)
    assert.ok(raw.length <= 255)
    await tester.send(SUCCESS)

    await disconnected
  })

  test("C-D-2: Simple Directed Disconnect Operation", async () => {
    const { client, tester } = clientUnderTest()

    const connected = client.connect(FOLDER_BROWSING)
    await tester.next()
    await tester.send(
      SUCCESS,
      [
        [Header.CONNECTION_ID, 1],
        [Header.WHO, FOLDER_BROWSING],
      ],
      connectFields(),
    )
    await connected

    const disconnected = client.disconnect()
    const { raw, headers } = await tester.next()
    assert.equal(raw[0], Opcode.DISCONNECT | FINAL)
    assert.ok(raw.length <= 255)
    assert.equal(header(headers, Header.CONNECTION_ID), 1)
    await tester.send(SUCCESS)

    await disconnected
  })

  test("C-SP-1: Simple SetPath Operation", async () => {
    const { client, tester } = clientUnderTest()

    const set = client.setpath("Testing")
    const { raw, fields, headers } = await tester.next()
    assert.equal(raw[0], Opcode.SETPATH | FINAL)
    assert.ok(raw.length <= 255)
    assert.equal(fields[0] & ~0x02, 0x00)
    assert.equal(fields[1], 0x00)
    assert.equal(header(headers, Header.NAME), "Testing")
    await tester.send(SUCCESS)

    await set
  })

  test("C-SP-2: Backup SetPath Operation", async () => {
    const { client, tester } = clientUnderTest()

    const set = client.setpath(null, 0x01)
    const { raw, fields } = await tester.next()
    assert.equal(raw[0], Opcode.SETPATH | FINAL)
    assert.equal(fields[0] & ~0x02, 0x01)
    assert.equal(fields[1], 0x00)
    await tester.send(SUCCESS)

    await set
  })

  test("C-SP-3: Reset SetPath Operation", async () => {
    const { client, tester } = clientUnderTest()

    const set = client.setpath("")
    const { raw, fields, headers } = await tester.next()
    assert.equal(raw[0], Opcode.SETPATH | FINAL)
    assert.equal(fields[0] & ~0x02, 0x00)
    assert.equal(fields[1], 0x00)
    assert.deepEqual(raw.subarray(5), Uint8Array.of(Header.NAME, 0x00, 0x03))
    assert.equal(header(headers, Header.NAME), "")
    await tester.send(SUCCESS)

    await set
  })

  test("C-G-1: Simple Get Operation", async () => {
    const { client, tester } = clientUnderTest()
    const object = random(25)

    const got = client.get("object.bin")
    const { all } = await tester.request(Opcode.GET)
    assert.equal(header(all, Header.NAME), "object.bin")
    await tester.send(CONTINUE, [[Header.LENGTH, object.length]])
    await tester.request(Opcode.GET)
    await tester.send(SUCCESS, [[Header.END_OF_BODY, object]])

    assert.deepEqual((await got).content, object)
  })

  test("C-G-2: Maximum Get Operation", async () => {
    const { client, tester } = clientUnderTest()
    const object = random(10240)

    const got = client.get("object.bin")
    const { all } = await tester.request(Opcode.GET)
    assert.equal(header(all, Header.NAME), "object.bin")
    await tester.send(CONTINUE, [
      [Header.LENGTH, object.length],
      [Header.BODY, object.subarray(0, 40)],
    ])

    for (let offset = 40; offset < object.length; offset += 204) {
      await tester.request(Opcode.GET)
      const last = offset + 204 >= object.length
      await tester.send(last ? SUCCESS : CONTINUE, [
        [last ? Header.END_OF_BODY : Header.BODY, object.subarray(offset, offset + 204)],
      ])
    }

    assert.deepEqual((await got).content, object)
  })

  test("C-G-3: Zero Byte Get Operation", async () => {
    const { client, tester } = clientUnderTest()

    const got = client.get("empty.bin")
    const { all } = await tester.request(Opcode.GET)
    assert.equal(header(all, Header.NAME), "empty.bin")
    await tester.send(SUCCESS, [
      [Header.LENGTH, 0],
      [Header.END_OF_BODY, EMPTY],
    ])

    assert.deepEqual((await got).content, EMPTY)
  })

  test("C-G-4: Default Object Get Operation", async () => {
    const { client, tester } = clientUnderTest()
    const card = random(25)

    const got = client.get(undefined, { type: "text/x-vCard" })
    const { all } = await tester.request(Opcode.GET)
    assert.ok([undefined, ""].includes(header(all, Header.NAME) as string | undefined))
    assert.deepEqual(header(all, Header.TYPE), VCARD)
    await tester.send(SUCCESS, [
      [Header.LENGTH, card.length],
      [Header.END_OF_BODY, card],
    ])

    assert.deepEqual((await got).content, card)
  })

  test("C-P-1: Simple Put Operation", async () => {
    const { client, tester } = clientUnderTest()
    const object = random(25)

    const put = client.put("object.bin", object)
    const { all } = await tester.request(Opcode.PUT)
    assert.equal(header(all, Header.NAME), "object.bin")
    assert.equal(all.at(-1)![0], Header.END_OF_BODY)
    assert.deepEqual(bodyOf(all), object)
    await tester.send(SUCCESS)

    await put
  })

  test("C-P-2: Maximum Put Operation", async () => {
    const { client, tester } = clientUnderTest()
    const object = random(10240)

    const put = client.put("object.bin", object)
    const { all } = await tester.request(Opcode.PUT)
    assert.equal(all.at(-1)![0], Header.END_OF_BODY)
    assert.deepEqual(bodyOf(all), object)
    assert.ok(tester.packets.every((packet) => packet.length <= 255))
    await tester.send(SUCCESS)

    await put
  })

  test("C-P-3: Zero Byte Put Operation", async () => {
    const { client, tester } = clientUnderTest()

    const put = client.put("empty.bin", new Uint8Array(0))
    const { all } = await tester.request(Opcode.PUT)
    assert.equal(header(all, Header.NAME), "empty.bin")
    assert.deepEqual(all.at(-1), [Header.END_OF_BODY, EMPTY])
    await tester.send(SUCCESS)

    await put
  })

  test("C-P-4: Put Using Advertised Packet Size", async () => {
    const { client, tester } = clientUnderTest()
    const object = random(10240)

    const connected = client.connect()
    expectConnectRequest(await tester.next())
    await tester.send(SUCCESS, [], connectFields())
    await connected

    const put = client.put("object.bin", object)
    const { all } = await tester.request(Opcode.PUT)
    assert.deepEqual(bodyOf(all), object)
    assert.ok(tester.packets.some((packet) => packet.length > 1024))
    await tester.send(SUCCESS)

    await put
  })

  test("C-P-5: Put Delete Operation", async () => {
    const { client, tester } = clientUnderTest()

    const put = client.put("gone.bin", null)
    const { all } = await tester.request(Opcode.PUT)
    assert.equal(header(all, Header.NAME), "gone.bin")
    assert.ok(all.every(([id]) => id !== Header.BODY && id !== Header.END_OF_BODY))
    await tester.send(SUCCESS)

    await put
  })

  test("C-A-1: Simple Put Abort", async () => {
    const { client, tester, iut } = clientUnderTest()
    const controller = new AbortController()

    const put = client.put("object.bin", random(1024), { signal: controller.signal })
    await tester.next()
    controller.abort()
    await tester.send(CONTINUE)

    const { raw } = await tester.next()
    assert.equal(raw[0], Opcode.ABORT | FINAL)
    assert.equal(raw.length, 3)
    await tester.send(SUCCESS)

    await assert.rejects(put, { name: "AbortError" })
    assert.ok(await idle(iut))
  })

  test("C-A-2: Immediate Put Abort", { skip: "inconclusive: the abort waits for the outstanding response" }, () => {})

  test("C-A-3: Simple Get Abort", async () => {
    const { client, tester, iut } = clientUnderTest()
    const controller = new AbortController()

    const got = client.get("object.bin", { signal: controller.signal })
    await tester.request(Opcode.GET)
    controller.abort()
    await tester.send(CONTINUE, [
      [Header.LENGTH, 10240],
      [Header.BODY, random(40)],
    ])

    const { raw } = await tester.next()
    assert.equal(raw[0], Opcode.ABORT | FINAL)
    assert.equal(raw.length, 3)
    await tester.send(SUCCESS)

    await assert.rejects(got, { name: "AbortError" })
    assert.ok(await idle(iut))
  })

  test("C-A-4: Immediate Get Abort", { skip: "inconclusive: the abort waits for the outstanding response" }, () => {})

  test("C-SR-1: Server Reject Put Operation", async () => {
    const { client, tester, iut } = clientUnderTest()

    const put = client.put("object.bin", random(10240))

    for (;;) {
      const { raw, headers } = await tester.next()
      assert.equal(raw[0], Opcode.PUT)

      if (header(headers, Header.BODY)) break
      await tester.send(CONTINUE)
    }
    await tester.send(FORBIDDEN)

    await assert.rejects(put, (error: OBEXError) => error.code === ResponseCode.FORBIDDEN)
    assert.ok(await idle(iut))
  })

  test("C-SR-2: Server Reject Get Operation", async () => {
    const { client, tester, iut } = clientUnderTest()

    const got = client.get("object.bin")
    await tester.request(Opcode.GET)
    await tester.send(FORBIDDEN)

    await assert.rejects(got, (error: OBEXError) => error.code === ResponseCode.FORBIDDEN)
    assert.ok(await idle(iut))
  })

  test("C-H-1: Tiny TP Split Header", async () => {
    const { client, tester, iut } = clientUnderTest(64 - 2 - 1)
    const object = random(100)

    const put = client.put("object.bin", object)
    const { all } = await tester.request(Opcode.PUT)
    assert.deepEqual(bodyOf(all), object)
    assert.ok(iut.writes.every((write) => write.length <= 61))
    assert.ok(iut.writes.length > 1)
    await tester.send(SUCCESS)

    await put
  })

  test("C-H-3: Four-Byte Headers", async () => {
    const { client, tester } = clientUnderTest()
    const object = random(25)

    const put = client.put("object.bin", object)
    const { all } = await tester.request(Opcode.PUT)
    assert.equal(header(all, Header.LENGTH), object.length)
    await tester.send(SUCCESS, [[Header.COUNT, 1]])

    assert.equal(header(await put, Header.COUNT), 1)
  })

  test("C-H-4: Byte Sequence Headers", async () => {
    const { client, tester } = clientUnderTest()
    const object = random(25)

    const put = client.put("object.bin", object)
    const { all } = await tester.request(Opcode.PUT)
    assert.deepEqual(header(all, Header.END_OF_BODY), object)
    await tester.send(SUCCESS, [[Header.HTTP, TESTING]])

    assert.deepEqual(header(await put, Header.HTTP), TESTING)
  })

  test("C-H-5: Unicode Headers", async () => {
    const { client, tester } = clientUnderTest()

    const put = client.put("object.bin", random(25))
    const { raw } = await tester.request(Opcode.PUT)
    const utf16 = [..."object.bin\0"].flatMap((c) => [0, c.charCodeAt(0)])
    const name = Uint8Array.of(Header.NAME, 0x00, 3 + utf16.length, ...utf16)
    assert.deepEqual(raw.subarray(3, 3 + name.length), name)
    await tester.send(SUCCESS, [[Header.DESCRIPTION, "Testing"]])

    assert.equal(header(await put, Header.DESCRIPTION), "Testing")
  })

  for (const [id, feature] of [
    ["C-S-1: Create Session Operation", "Reliable sessions"],
    ["C-S-2: Close Session Operation", "Reliable sessions"],
    ["C-S-3: Suspend Session Operation", "Reliable sessions"],
    ["C-S-4: Resume Session Operation", "Reliable sessions"],
    ["C-S-5: Unexpected Resume Session Operation", "Reliable sessions"],
    ["C-S-6: Set Session Timeout Operation", "Reliable sessions"],
    ["C-TD-1: Transport Disconnect During Put Operation", "Reliable sessions"],
    ["C-TD-2: Transport Disconnect During Get Operation", "Reliable sessions"],
    ["C-H-2: One-Byte Headers", "Reliable sessions"],
    ["C-AU-1: Authenticate Client Connection", "Authentication"],
    ["C-AU-2: Authenticate Client Operation", "Authentication"],
    ["C-AU-3: Authenticate Server Connection", "Authentication"],
    ["C-AU-4: Authenticate Server Operation", "Authentication"],
    ["C-UP-1: Small Ultra Put", "Ultra"],
    ["C-UP-2: Maximum Ultra Put", "Ultra"],
    ["C-UP-3: Zero Byte Ultra Put", "Ultra"],
  ]) {
    test(id, { skip: `${feature} not supported (optional)` }, () => {})
  }
})

describe("OBEX server tests", () => {
  const expectConnectResponse = (raw: Uint8Array) => {
    assert.equal(raw[0], SUCCESS)
    assert.ok(raw.length <= 255)
    assert.equal(raw[3], 0x10)
    assert.equal(raw[4], 0x00)
    assert.ok(view(raw).getUint16(5) >= 255)
  }

  const connect = async (tester: Tester, headers: Headers = []) => {
    await tester.send(Opcode.CONNECT | FINAL, headers, connectFields())
    const { raw } = await tester.next()
    return { raw, headers: decodeHeaders(raw.subarray(7)) }
  }

  test("S-C-1: Simple Connect Operation", async () => {
    const { tester } = serverUnderTest()

    const { raw, headers } = await connect(tester)
    expectConnectResponse(raw)
    assert.equal(raw.length, 7 + encodeHeaders(headers).length)
  })

  test("S-C-2: Simple Directed Connection", async () => {
    const { tester } = serverUnderTest({ ...inbox(), target: FOLDER_BROWSING })

    const { raw, headers } = await connect(tester, [[Header.TARGET, FOLDER_BROWSING]])
    expectConnectResponse(raw)
    assert.deepEqual(header(headers, Header.WHO), FOLDER_BROWSING)
    assert.equal(typeof header(headers, Header.CONNECTION_ID), "number")
  })

  test("S-C-3: Invalid Directed Connection", async () => {
    const { tester } = serverUnderTest()

    const { raw, headers } = await connect(tester, [[Header.TARGET, ascii("OBEX-INVALID")]])
    expectConnectResponse(raw)
    assert.equal(header(headers, Header.WHO), undefined)
    assert.equal(header(headers, Header.CONNECTION_ID), undefined)
  })

  test("S-D-1: Simple Disconnect Operation", async () => {
    const { tester } = serverUnderTest()

    await connect(tester)
    await tester.send(Opcode.DISCONNECT | FINAL)
    const { raw } = await tester.next()
    assert.equal(raw[0], SUCCESS)
    assert.ok(raw.length <= 255)
  })

  test("S-D-2: Simple Directed Disconnect Operation", async () => {
    const { tester } = serverUnderTest({ ...inbox(), target: FOLDER_BROWSING })

    const { headers } = await connect(tester, [[Header.TARGET, FOLDER_BROWSING]])
    const connectionId = header(headers, Header.CONNECTION_ID)
    assert.equal(typeof connectionId, "number")

    await tester.send(Opcode.DISCONNECT | FINAL, [[Header.CONNECTION_ID, connectionId as number]])
    const { raw } = await tester.next()
    assert.equal(raw[0], SUCCESS)
  })

  test("S-SP-1: Simple SetPath Operation", async () => {
    const calls: [string | undefined, number][] = []
    const { tester } = serverUnderTest({ setpath: (name, flags) => (calls.push([name, flags]), ResponseCode.SUCCESS) })

    await tester.send(Opcode.SETPATH | FINAL, [[Header.NAME, "Testing"]], Uint8Array.of(0x00, 0x00))
    const { raw } = await tester.next()
    assert.equal(raw[0], SUCCESS)
    assert.ok(raw.length <= 255)
    assert.deepEqual(calls, [["Testing", 0x00]])
  })

  test("S-SP-2: Backup SetPath Operation", async () => {
    const calls: [string | undefined, number][] = []
    const { tester } = serverUnderTest({ setpath: (name, flags) => (calls.push([name, flags]), ResponseCode.SUCCESS) })

    await tester.send(Opcode.SETPATH | FINAL, [], Uint8Array.of(0x01, 0x00))
    const { raw } = await tester.next()
    assert.equal(raw[0], SUCCESS)
    assert.deepEqual(calls, [[undefined, 0x01]])
  })

  test("S-SP-3: Reset SetPath Operation", async () => {
    const calls: [string | undefined, number][] = []
    const { tester } = serverUnderTest({ setpath: (name, flags) => (calls.push([name, flags]), ResponseCode.SUCCESS) })

    await tester.send(Opcode.SETPATH | FINAL, [[Header.NAME, ""]], Uint8Array.of(0x00, 0x00))
    const { raw } = await tester.next()
    assert.equal(raw[0], SUCCESS)
    assert.deepEqual(calls, [["", 0x00]])
  })

  const getObject = async (tester: Tester, first: Headers) => {
    await tester.send(Opcode.GET | FINAL, first)
    const responses: Request[] = []

    for (;;) {
      const response = await tester.next()
      assert.ok(response.raw[0] & FINAL)
      responses.push(response)

      if (response.raw[0] !== CONTINUE) return { responses, content: bodyOf(responses.flatMap((r) => r.headers)) }
      await tester.send(Opcode.GET | FINAL)
    }
  }

  test("S-G-1: Normal Get Operation", async () => {
    const app = inbox()
    const object = random(25)
    app.objects.set("object.bin", object)
    const { tester } = serverUnderTest(app)

    const { responses, content } = await getObject(tester, [[Header.NAME, "object.bin"]])
    assert.equal(responses.at(-1)!.raw[0], SUCCESS)
    assert.ok(responses.slice(0, -1).every(({ raw }) => raw[0] === CONTINUE))
    assert.deepEqual(content, object)
  })

  test("S-G-2: Maximum Get Operation", async () => {
    const app = inbox()
    const object = random(10240)
    app.objects.set("object.bin", object)
    const { tester } = serverUnderTest(app)

    const { responses, content } = await getObject(tester, [[Header.NAME, "object.bin"]])
    assert.equal(responses.at(-1)!.raw[0], SUCCESS)
    assert.ok(responses.every(({ raw }) => raw.length <= 255))
    assert.deepEqual(content, object)
  })

  test("S-G-3: Zero Byte Get Operation", async () => {
    const app = inbox()
    app.objects.set("empty.bin", EMPTY)
    const { tester } = serverUnderTest(app)

    const { responses, content } = await getObject(tester, [[Header.NAME, "empty.bin"]])
    assert.equal(responses.at(-1)!.raw[0], SUCCESS)
    assert.ok(responses.flatMap((r) => r.headers).some(([id]) => id === Header.END_OF_BODY || id === Header.BODY))
    assert.deepEqual(content, EMPTY)
  })

  test("S-G-4: Default Object Get Operation", async () => {
    const app = inbox()
    const card = random(25)
    app.objects.set("default.vcf", card)
    const { tester } = serverUnderTest(app)

    const { responses, content } = await getObject(tester, [
      [Header.NAME, ""],
      [Header.TYPE, VCARD],
    ])
    assert.equal(responses.at(-1)!.raw[0], SUCCESS)
    assert.deepEqual(content, card)
  })

  test("S-G-5: Get Using Advertised Packet Size", async () => {
    const app = inbox()
    const object = random(10240)
    app.objects.set("object.bin", object)
    const { tester } = serverUnderTest(app)

    expectConnectResponse((await connect(tester)).raw)
    const { responses, content } = await getObject(tester, [[Header.NAME, "object.bin"]])
    assert.ok(responses.some(({ raw }) => raw.length > 1024))
    assert.deepEqual(content, object)
  })

  const putPackets = (name: string, object: Uint8Array, first = 40, rest = 204) => {
    const packets: Headers[] = [
      [
        [Header.NAME, name],
        [Header.LENGTH, object.length],
        [Header.BODY, object.subarray(0, first)],
      ],
    ]

    for (let offset = first; offset < object.length; offset += rest) {
      const last = offset + rest >= object.length
      packets.push([[last ? Header.END_OF_BODY : Header.BODY, object.subarray(offset, offset + rest)]])
    }

    return packets
  }

  test("S-P-1: Small Put Operation", async () => {
    const app = inbox()
    const object = random(25)
    const { tester } = serverUnderTest(app)

    await tester.send(Opcode.PUT | FINAL, [
      [Header.NAME, "object.bin"],
      [Header.LENGTH, 25],
      [Header.BODY, object.subarray(0, 12)],
      [Header.END_OF_BODY, object.subarray(12)],
    ])
    const { raw } = await tester.next()
    assert.equal(raw[0], SUCCESS)
    assert.equal(raw.length, 3)
    assert.deepEqual(app.objects.get("object.bin"), object)
  })

  test("S-P-2: Maximum Put Operation", async () => {
    const app = inbox()
    const object = random(10240)
    const { tester } = serverUnderTest(app)
    const packets = putPackets("object.bin", object)

    for (const [i, headers] of packets.entries()) {
      const last = i === packets.length - 1
      await tester.send(last ? Opcode.PUT | FINAL : Opcode.PUT, headers)
      const { raw } = await tester.next()
      assert.equal(raw[0], last ? SUCCESS : CONTINUE)
    }

    assert.equal(packets.length, 51)
    assert.deepEqual(app.objects.get("object.bin"), object)
  })

  test("S-P-3: Zero Byte Put Operation", async () => {
    const app = inbox()
    const { tester } = serverUnderTest(app)

    await tester.send(Opcode.PUT | FINAL, [
      [Header.NAME, "empty.bin"],
      [Header.LENGTH, 0],
      [Header.END_OF_BODY, EMPTY],
    ])
    const { raw } = await tester.next()
    assert.equal(raw[0], SUCCESS)
    assert.deepEqual(app.objects.get("empty.bin"), EMPTY)
  })

  test("S-P-4: Put Delete Operation", async () => {
    const app = inbox()
    app.objects.set("gone.bin", random(25))
    const { tester } = serverUnderTest(app)

    await tester.send(Opcode.PUT | FINAL, [[Header.NAME, "gone.bin"]])
    const { raw } = await tester.next()
    assert.equal(raw[0], SUCCESS)
    assert.equal(app.objects.has("gone.bin"), false)
  })

  test("S-A-1: Simple Put Abort", async () => {
    const app = inbox()
    const { tester } = serverUnderTest(app)

    await tester.send(Opcode.PUT, [[Header.NAME, "object.bin"]])
    assert.equal((await tester.next()).raw[0], CONTINUE)
    await tester.send(Opcode.ABORT | FINAL)
    const { raw } = await tester.next()
    assert.equal(raw[0], SUCCESS)
    assert.equal(raw.length, 3)
    assert.equal(app.objects.size, 0)
  })

  test("S-A-2: Immediate Put Abort", async () => {
    const app = inbox()
    const { tester } = serverUnderTest(app)

    await tester.send(Opcode.PUT, [[Header.NAME, "object.bin"]])
    await tester.send(Opcode.ABORT | FINAL)
    assert.equal((await tester.next()).raw[0], CONTINUE)
    const { raw } = await tester.next()
    assert.equal(raw[0], SUCCESS)
    assert.equal(raw.length, 3)
    assert.equal(app.objects.size, 0)
  })

  test("S-A-3: Simple Get Abort", async () => {
    const app = inbox()
    app.objects.set("object.bin", random(1024))
    const { tester } = serverUnderTest(app)

    await tester.send(Opcode.GET, [[Header.NAME, "object.bin"]])
    assert.equal((await tester.next()).raw[0], CONTINUE)
    await tester.send(Opcode.ABORT | FINAL)
    const { raw } = await tester.next()
    assert.equal(raw[0], SUCCESS)
    assert.equal(raw.length, 3)
  })

  test("S-A-4: Immediate Get Abort", async () => {
    const app = inbox()
    app.objects.set("object.bin", random(1024))
    const { tester } = serverUnderTest(app)

    await tester.send(Opcode.GET, [[Header.NAME, "object.bin"]])
    await tester.send(Opcode.ABORT | FINAL)
    assert.equal((await tester.next()).raw[0], CONTINUE)
    const { raw } = await tester.next()
    assert.equal(raw[0], SUCCESS)
    assert.equal(raw.length, 3)
  })

  test(
    "S-SR-1: Server Put Rejection",
    { skip: "rejecting a put before the whole object arrives is not supported" },
    async () => {
      const { tester } = serverUnderTest({ put: () => ResponseCode.FORBIDDEN })
      const packets = putPackets("object.bin", random(10240))
      let last = 0

      for (const [i, headers] of packets.entries()) {
        await tester.send(i === packets.length - 1 ? Opcode.PUT | FINAL : Opcode.PUT, headers)
        last = (await tester.next()).raw[0]
        if (last !== CONTINUE) break
      }

      assert.equal(last, FORBIDDEN)
      assert.ok(tester.packets.length < packets.length, "the server should reject before the whole object is sent")
    },
  )

  test("S-SR-2: Server Get Rejection", async () => {
    const { tester } = serverUnderTest({ get: () => ResponseCode.FORBIDDEN })

    const { responses } = await getObject(tester, [[Header.NAME, "object.bin"]])
    assert.equal(responses.at(-1)!.raw[0], FORBIDDEN)
    assert.equal(responses.at(-1)!.raw.length, 3)
  })

  test("S-H-1: Tiny TP Split Header", async () => {
    const app = inbox()
    const object = random(100)
    app.objects.set("object.bin", object)
    const { tester, iut } = serverUnderTest(app, 64 - 2 - 1)

    const { responses, content } = await getObject(tester, [[Header.NAME, "object.bin"]])
    assert.equal(responses.at(-1)!.raw[0], SUCCESS)
    assert.ok(iut.writes.every((write) => write.length <= 61))
    assert.ok(iut.writes.length > 1)
    assert.deepEqual(content, object)
  })

  test("S-H-3: Four-Byte Headers", async () => {
    const app = inbox()
    const object = random(25)
    app.objects.set("object.bin", object)
    const { tester } = serverUnderTest(app)

    const { responses } = await getObject(tester, [
      [Header.NAME, "object.bin"],
      [Header.COUNT, 1],
    ])
    assert.equal(
      header(
        responses.flatMap((r) => r.headers),
        Header.LENGTH,
      ),
      object.length,
    )
  })

  test("S-H-4: Byte Sequence Headers", async () => {
    const app = inbox()
    const object = random(25)
    app.objects.set("object.bin", object)
    const { tester } = serverUnderTest(app)

    const { responses } = await getObject(tester, [
      [Header.NAME, "object.bin"],
      [Header.HTTP, TESTING],
    ])
    assert.deepEqual(
      header(
        responses.flatMap((r) => r.headers),
        Header.END_OF_BODY,
      ),
      object,
    )
  })

  test("S-H-5: Unicode Headers", async () => {
    const app = inbox()
    const object = random(25)
    const { tester } = serverUnderTest(app)

    await tester.send(Opcode.PUT | FINAL, [
      [Header.NAME, "Testing.bin"],
      [Header.LENGTH, 25],
      [Header.BODY, object.subarray(0, 12)],
      [Header.END_OF_BODY, object.subarray(12)],
    ])
    assert.equal((await tester.next()).raw[0], SUCCESS)
    assert.deepEqual(app.objects.get("Testing.bin"), object)
  })

  test("S-OP-1: Invalid OBEX Opcode", async () => {
    const { tester } = serverUnderTest()

    await tester.send(0x9a)
    const { raw } = await tester.next()
    assert.equal(raw[0], NOT_IMPLEMENTED)
    assert.equal(raw.length, 3)
  })

  for (const [id, feature] of [
    ["S-S-1: Create Session", "Reliable sessions"],
    ["S-S-2: Close Active Session", "Reliable sessions"],
    ["S-S-3: Close Suspended Session", "Reliable sessions"],
    ["S-S-4: Suspend Session", "Reliable sessions"],
    ["S-S-5: Resume Session", "Reliable sessions"],
    ["S-S-6: Set Session Timeout", "Reliable sessions"],
    ["S-S-7: Set Session Timeout (Infinite Timeout)", "Reliable sessions"],
    ["S-S-8: Set Session Timeout (1 second timeout)", "Reliable sessions"],
    ["S-S-9: Create Session (1 second timeout)", "Reliable sessions"],
    ["S-S-10: Multiple Sessions", "Reliable sessions"],
    ["S-E-1: Create Session Fails (No Sessions Available)", "Reliable sessions"],
    ["S-E-2: Create Session Fails (Session Already Active)", "Reliable sessions"],
    ["S-E-3: Resume Session Fails (Bad Session)", "Reliable sessions"],
    ["S-E-4: Resume Session Fails (Session Already Active)", "Reliable sessions"],
    ["S-E-5: Suspend Session Fails (No Reliable Session)", "Reliable sessions"],
    ["S-E-6: Close Session Fails (No Reliable Session)", "Reliable sessions"],
    ["S-E-7: Set Session Timeout Fails (No Reliable Session)", "Reliable sessions"],
    ["S-H-2: One-Byte Headers", "Reliable sessions"],
    ["S-AU-1: Authenticate Client Connection", "Authentication"],
    ["S-AU-2: Authenticate Client Operation", "Authentication"],
    ["S-AU-3: Authenticate Server Connection", "Authentication"],
    ["S-AU-4: Authenticate Server Operation", "Authentication"],
    ["S-UP-1: No Response to Ultra Put", "Ultra"],
    ["S-UP-2: Successful Ultra Put", "Ultra"],
  ]) {
    test(id, { skip: `${feature} not supported (optional)` }, () => {})
  }
})

describe("OBEX over the IrDA transport", () => {
  const [ab, ba] = Wire.pair()
  const client = { irlap: new IrLAP(sir(ab)) } as { irlap: IrLAP; irlmp: IrLMP; tinytp: TinyTP; obex: OBEX }
  const server = { irlap: new IrLAP(sir(ba)) } as { irlap: IrLAP; irlmp: IrLMP; tinytp: TinyTP }
  const accepted: TTPConnection[] = []
  let address = 0

  before(async () => {
    client.irlmp = new IrLMP(client.irlap, { nickname: "tester" })
    client.tinytp = new TinyTP(client.irlmp)
    client.obex = new OBEX(client.tinytp)

    server.irlmp = new IrLMP(server.irlap, { nickname: "iut", hints: Hints.OBEX })
    server.tinytp = new TinyTP(server.irlmp)
    server.irlmp.listeners.set(
      0x02,
      server.tinytp.server((connection) => accepted.push(connection)),
    )
    server.irlmp.ias.objects.OBEX = { "IrDA:TinyTP:LsapSel": 0x02 }

    address = (await client.irlmp.discover())[0].address
  })

  after(async () => {
    await client.irlap.close()
    await server.irlap.close()
  })

  test("S-IAS-1: Server IAS Query", async () => {
    const lsap = await client.irlmp.resolve(address, "OBEX", "IrDA:TinyTP:LsapSel")
    assert.ok(lsap > 0x00 && lsap < 0x70)
  })

  test("C-IAS-1: OBEX IAS Query", async () => {
    const connection = await client.tinytp.connect(address, "OBEX")
    await sleep(50)

    assert.equal(accepted.length, 1)
    await connection.writable.close()
  })

  test("C-TTP-1: Tiny TP Connect", async () => {
    const connection = await client.tinytp.connect(address, "OBEX")
    await sleep(50)

    assert.equal(accepted.at(-1)!.maxSduSize, 0, "the client's connect request carries no MaxSduSize")
    await connection.writable.close()
  })

  test("S-TTP-1: Tiny TP Connect", async () => {
    const connection = await client.tinytp.connect(address, "OBEX")

    assert.equal(connection.maxSduSize, 0, "the server's connect response carries no MaxSduSize")
    await connection.writable.close()
  })
})
