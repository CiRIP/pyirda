import assert from "node:assert/strict"
import { test } from "node:test"

import { ascii } from "../src/bytes.ts"
import { IrLAP } from "../src/irlap/irlap.ts"
import { IrLMP } from "../src/irlmp/index.ts"
import { LINGER_TIMEOUT } from "../src/irlmp/constants.ts"
import { INITIAL_CREDIT } from "../src/tinytp/pdu.ts"
import { TinyTP, type TTPConnection } from "../src/tinytp/index.ts"
import { Chat } from "./chat.ts"
import { sir, sleep, Wire } from "./wire.ts"

const pattern = (length: number) => new Uint8Array(length).map((_, i) => i)

test("credit flow and segmentation", async () => {
  const [ab, ba] = Wire.pair()
  const aLap = new IrLAP(sir(ab))
  const a = new IrLMP(aLap, { nickname: "A" })
  const aTtp = new TinyTP(a)
  const bLap = new IrLAP(sir(ba))
  const b = new IrLMP(bLap, { nickname: "B" })
  const bTtp = new TinyTP(b)

  const accepted: Chat<TTPConnection>[] = []
  b.listeners.set(
    0x05,
    bTtp.server((connection) => accepted.push(new Chat(connection, [ascii("b1"), ascii("b2")]))),
  )
  b.listeners.set(
    0x06,
    bTtp.server((connection) => accepted.push(new Chat(connection, [pattern(1024)])), 1500),
  )
  b.ias.objects.Chat = { "IrDA:TinyTP:LsapSel": 0x05 }

  const [{ address }] = await a.discover()

  // SAR off: more SDUs than the initial credit, all delivered in order, credit recycled
  const aSends = Array.from({ length: 3 * INITIAL_CREDIT }, (_, i) => ascii(`a${String(i).padStart(2, "0")}`))
  const first = new Chat(await aTtp.connect(address, "Chat", { data: ascii("hello") }), aSends)
  assert.equal(first.connection.dataSize, 253)
  assert.equal(first.connection.maxSduSize, 0)
  await sleep(50)
  assert.deepEqual(accepted[0].connection.connectData, ascii("hello"))

  assert.deepEqual(await first.receive(2), [ascii("b1"), ascii("b2")])
  assert.deepEqual(await accepted[0].receive(aSends.length), aSends)

  await assert.rejects(first.writer.write(new Uint8Array(254)), RangeError)
  assert.equal(await first.closed, undefined)
  assert.equal(await accepted[0].closed, undefined)

  // SAR on: segmented SDUs both ways, an oversized one refused locally
  const big = pattern(768)
  const second = new Chat(await aTtp.connect(address, 0x06, { maxSduSize: 1024 }), [big, new Uint8Array(1500)])
  assert.equal(second.connection.maxSduSize, 1500)

  assert.deepEqual(await accepted[1].receive(2), [big, new Uint8Array(1500)])
  assert.deepEqual(await second.receive(1), [pattern(1024)])

  await assert.rejects(second.writer.write(new Uint8Array(1501)), RangeError)
  assert.equal(await second.closed, undefined)
  assert.equal(await accepted[1].closed, undefined)

  // peer-initiated close with data still queued on our side
  const third = new Chat(
    await aTtp.connect(address, 0x06, { maxSduSize: 1024 }),
    Array.from({ length: 20 }, () => ascii("x")),
  )
  await sleep(50)
  await accepted[2].close()
  assert.equal(await accepted[2].closed, undefined)
  assert.equal(await third.closed, undefined)

  await sleep(LINGER_TIMEOUT + 1000)
  assert.equal(aLap.state, "NDM")
  assert.equal(bLap.state, "NDM")

  await aLap.close()
  await bLap.close()
})
