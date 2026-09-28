import assert from "node:assert/strict"
import { test } from "node:test"

import { ascii } from "../src/bytes.ts"
import { KS959, sir } from "../src/dongle/index.ts"
import { IrLAP, type Link } from "../src/irlap/irlap.ts"
import { FakeKS959 } from "./ks959.ts"

async function roundtrip(from: KS959, to: KS959, data: Uint8Array): Promise<Uint8Array> {
  const reader = to.readable.getReader()
  const writer = from.writable.getWriter()

  await writer.write(data)
  writer.releaseLock()

  const received: number[] = []
  while (received.length < data.length) {
    const { value } = await reader.read()
    received.push(...value!)
  }
  reader.releaseLock()

  return Uint8Array.from(received)
}

test("obfuscates transmitted fragments as the dongle expects", async () => {
  const [device] = FakeKS959.pair()
  const dongle = await KS959.open(device as unknown as USBDevice)
  const sent: Uint8Array[] = []
  device.controlTransferOut = async (setup, data) => {
    if (setup.index === 0) sent.push((data as Uint8Array).slice())
    return { bytesWritten: 0, status: "ok" }
  }

  const writer = dongle.writable.getWriter()
  await writer.write(ascii("hello"))

  assert.equal(sent[0].length, 24)
  assert.deepEqual(sent[0].subarray(0, 5), Uint8Array.of(0x5a, 0x57, 0x5e, 0x5e, 0x5d))
  assert.deepEqual(sent[0].subarray(5), new Uint8Array(19))

  await writer.write(new Uint8Array(500))
  assert.equal(sent.length, 4)
  assert.equal(sent[1].length, 256)
  assert.equal(sent[3].length, ((20 + 7) & ~0x07) + 0x10)

  assert.equal(device.baudRate, 9600)
  await dongle.close()
})

test("recovers the byte stream through the dongle's obfuscation", async () => {
  const [device, peer] = FakeKS959.pair()
  const dongle = await KS959.open(device as unknown as USBDevice)
  const other = await KS959.open(peer as unknown as USBDevice)

  const data = new Uint8Array(1000).map((_, i) => i & 0xff)
  assert.deepEqual(await roundtrip(dongle, other, data), data)

  await dongle.close()
  await other.close()
})

test("carries a full IrLAP session", async () => {
  const [deviceA, deviceB] = FakeKS959.pair()
  let bLink: Link | undefined
  const a = new IrLAP(sir(await KS959.open(deviceA as unknown as USBDevice)))
  const b = new IrLAP(sir(await KS959.open(deviceB as unknown as USBDevice)), { listener: (link) => (bLink = link) })

  assert.equal(a.capabilities.baudRate, 57600)

  const [device] = await a.discover()
  const link = await a.connect(device.srcDeviceAddress)
  assert.ok(bLink)

  const writer = link.writable.getWriter()
  await writer.write(ascii("over usb"))
  const reader = bLink.readable.getReader()
  assert.deepEqual((await reader.read()).value, ascii("over usb"))
  assert.equal(deviceA.baudRate, 57600)
  assert.equal(deviceB.baudRate, 57600)

  await a.close()
  await b.close()
})
