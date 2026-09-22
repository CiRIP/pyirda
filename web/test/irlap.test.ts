import assert from "node:assert/strict"
import { test } from "node:test"

import { ascii } from "../src/bytes.ts"
import { IrLAP, type Link } from "../src/irlap/irlap.ts"
import { Parameters } from "../src/irlap/negotiation.ts"
import { sleep, Wire } from "./wire.ts"

async function exchange(link: Link, send: Uint8Array[], expect: number): Promise<Uint8Array[]> {
  const writer = link.writable.getWriter()
  for (const data of send) await writer.write(data)
  writer.releaseLock()

  const received: Uint8Array[] = []
  const reader = link.readable.getReader()
  while (received.length < expect) {
    const { value, done } = await reader.read()
    if (done) break
    received.push(value)
  }
  reader.releaseLock()

  return received
}

async function drain(link: Link): Promise<unknown> {
  try {
    for await (const _ of link.readable) void _
    return undefined
  } catch (error) {
    return error
  }
}

async function scenario(lose?: string) {
  const aSends = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"].map(ascii)
  const bSends = ["b1", "b2", "b3"].map(ascii)

  const [ab, ba] = Wire.pair()
  if (lose) ab.lose = ascii(lose)

  let bLink: Link | undefined
  const a = new IrLAP(ab, { discoveryInfo: Uint8Array.of(0x80, 0x00, 0x41) })
  const b = new IrLAP(ba, { discoveryInfo: Uint8Array.of(0x80, 0x00, 0x42), listener: (link) => (bLink = link) })
  await a.open()
  await b.open()

  const devices = await a.discover()
  assert.equal(devices.length, 1)
  assert.deepEqual(devices[0].discoveryInfo, Uint8Array.of(0x80, 0x00, 0x42))

  const link = await a.connect(devices[0].srcDeviceAddress)
  assert.ok(bLink)

  const [aReceived, bReceived] = await Promise.all([
    exchange(link, aSends, bSends.length),
    exchange(bLink, bSends, aSends.length),
  ])
  assert.deepEqual(aReceived, bSends)
  assert.deepEqual(bReceived, aSends)

  await sleep(1200)

  const closed = Promise.all([drain(link), drain(bLink)])
  await link.writable.close()
  assert.deepEqual(await closed, [undefined, undefined])
  assert.equal(a.state, "NDM")
  assert.equal(b.state, "NDM")

  await a.close()
  await b.close()
}

test("discovery, connection and data exchange", () => scenario())

test("switches to the negotiated baud rate and back", async () => {
  const [ab, ba] = Wire.pair()
  const capabilities = new Parameters({ baudRatePv: 0b00100010 })
  let bLink: Link | undefined
  const a = new IrLAP(ab, { capabilities })
  const b = new IrLAP(ba, { capabilities, listener: (link) => (bLink = link) })
  await a.open()
  await b.open()

  const [device] = await a.discover()
  const link = await a.connect(device.srcDeviceAddress)
  assert.ok(bLink)
  const exchanged = await Promise.all([exchange(link, [ascii("fast")], 1), exchange(bLink, [ascii("faster")], 1)])
  assert.deepEqual(exchanged, [[ascii("faster")], [ascii("fast")]])
  assert.equal(ab.baudRate, 115200)
  assert.equal(ba.baudRate, 115200)

  const closed = Promise.all([drain(link), drain(bLink)])
  await link.writable.close()
  assert.deepEqual(await closed, [undefined, undefined])
  await sleep(100)
  assert.equal(ab.baudRate, 9600)
  assert.equal(ba.baudRate, 9600)

  await a.close()
  await b.close()
})
test("recovers from a lost first frame", () => scenario("a1"))
test("recovers from a lost last frame", () => scenario("a9"))
