import assert from "node:assert/strict"
import { test } from "node:test"

import { ascii } from "../src/bytes.ts"
import { IrLAP } from "../src/irlap/irlap.ts"
import { Hints, IrLMP, type LSAPConnection } from "../src/irlmp/index.ts"
import { LINGER_TIMEOUT } from "../src/irlmp/constants.ts"
import { Chat } from "./chat.ts"
import { sir, sleep, Wire } from "./wire.ts"

test("LSAP connections, IAS lookups and link lifecycle", async () => {
  const aSends = ["a1", "a2", "a3", "a4", "a5"].map(ascii)
  const bSends = ["b1", "b2"].map(ascii)
  const blob = new Uint8Array(768).map((_, i) => i)

  const [ab, ba] = Wire.pair()
  const aLap = new IrLAP(sir(ab))
  const a = new IrLMP(aLap, { nickname: "A" })
  const bLap = new IrLAP(sir(ba))
  const b = new IrLMP(bLap, { nickname: "B" })

  const accepted: Chat<LSAPConnection>[] = []
  b.listeners.set(0x05, (connection) => accepted.push(new Chat(connection, bSends)))
  b.ias.objects.Echo = { "IrDA:IrLMP:LsapSel": 0x05 }
  b.ias.objects.Big = { Blob: blob }

  const devices = await a.discover()
  assert.equal(devices.length, 1)
  assert.equal(devices[0].nickname, "B")
  assert.equal(devices[0].hints, Hints.COMPUTER)
  const address = devices[0].address

  await assert.rejects(a.connect(address, 0x06), /NO_PEER_MUX_CLIENT/)

  const first = new Chat(await a.connect(address, 0x05, ascii("hello")), aSends)
  assert.equal(first.connection.dataSize, 254)
  await sleep(50)
  assert.equal(accepted.length, 1)
  assert.deepEqual(accepted[0].connection.connectData, ascii("hello"))

  assert.deepEqual(await first.receive(bSends.length), bSends)
  assert.deepEqual(await accepted[0].receive(aSends.length), aSends)

  const second = new Chat(await a.connect(address, 0x05), [ascii("again")])
  assert.equal(second.connection.irlmp, a)
  assert.equal(accepted.length, 2)
  assert.deepEqual(await accepted[1].receive(1), [ascii("again")])

  await first.close()
  assert.equal(await first.closed, undefined)
  assert.equal(await accepted[0].closed, undefined)
  assert.ok(aLap.connected)

  await second.close()
  assert.equal(await second.closed, undefined)
  assert.equal(await accepted[1].closed, undefined)

  await sleep(LINGER_TIMEOUT + 1000)
  assert.equal(aLap.state, "NDM")
  assert.equal(bLap.state, "NDM")
  assert.equal(a.link, undefined)
  assert.equal(b.link, undefined)

  assert.deepEqual(await a.ias.getValueByClass(address, "Device", "DeviceName"), [[0, "B"]])
  assert.deepEqual(await a.ias.getValueByClass(address, "Big", "Blob"), [[2, blob]])
  assert.deepEqual(await a.ias.getValueByClass(address, "Nope", "Blob"), [])
  assert.deepEqual(await a.ias.getValueByClass(address, "Big", "Nope"), [])
  assert.deepEqual(await b.ias.getValueByClass(aLap.srcDeviceAddress, "Device", "DeviceName"), [[0, "A"]])

  await assert.rejects(a.connect(address, "Nope"), /No Nope service/)

  const third = new Chat(await a.connect(address, "Echo"), [ascii("named")])
  assert.equal(accepted.length, 3)
  assert.deepEqual(await accepted[2].receive(1), [ascii("named")])
  await third.close()
  await third.closed

  assert.ok(aLap.connected)
  assert.equal((await a.discover()).length, 1)

  await aLap.close()
  await bLap.close()
})
