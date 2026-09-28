import assert from "node:assert/strict"
import { test } from "node:test"

import { ascii } from "../src/bytes.ts"
import { sir, STIR4200 } from "../src/dongle/index.ts"
import { IrLAP, type Link } from "../src/irlap/irlap.ts"
import { FakeSTIR4200 } from "./stir4200.ts"

const open = (device: FakeSTIR4200) => STIR4200.open(device as unknown as USBDevice)

test("programs the transceiver for the requested speed", async () => {
  const [device] = FakeSTIR4200.pair()
  const dongle = await open(device)

  assert.equal(device.baudRate, 9600)
  assert.equal(device.registers[1], 0x2a)
  assert.equal(device.registers[3], 0x00)
  assert.equal(device.registers[4], 0x20)
  assert.equal(device.registers[8], 0x15)

  await dongle.setSpeed(115200)
  assert.equal(device.baudRate, 115200)
  assert.equal(device.registers[1], 0x2a)

  await dongle.setSpeed(2400)
  assert.equal(device.baudRate, 2400)
  assert.equal(device.registers[1], 0x2b)

  await dongle.close()
})

test("frames writes and reads back what the FIFO reports", async () => {
  const [device, peer] = FakeSTIR4200.pair()
  const dongle = await open(device)
  const other = await open(peer)

  const data = new Uint8Array(5000).map((_, i) => i & 0xff)
  const writer = dongle.writable.getWriter()
  await writer.write(data)

  const received: number[] = []
  const reader = other.readable.getReader()
  while (received.length < data.length) {
    const { value } = await reader.read()
    received.push(...value!)
  }

  assert.deepEqual(Uint8Array.from(received), data)

  reader.releaseLock()
  await dongle.close()
  await other.close()
})

test("carries a full IrLAP session", async () => {
  const [deviceA, deviceB] = FakeSTIR4200.pair()
  let bLink: Link | undefined
  const a = new IrLAP(sir(await open(deviceA)))
  const b = new IrLAP(sir(await open(deviceB)), { listener: (link) => (bLink = link) })

  assert.equal(a.capabilities.baudRate, 115200)

  const [device] = await a.discover()
  const link = await a.connect(device.srcDeviceAddress)
  assert.ok(bLink)

  const writer = link.writable.getWriter()
  await writer.write(ascii("over bulk"))
  const reader = bLink.readable.getReader()
  assert.deepEqual((await reader.read()).value, ascii("over bulk"))
  assert.equal(deviceA.baudRate, 115200)
  assert.equal(deviceB.baudRate, 115200)

  await a.close()
  await b.close()
})
