import assert from "node:assert/strict"
import { test } from "node:test"

import { ascii, concat } from "../src/bytes.ts"
import { MCS7780, sir } from "../src/dongle/index.ts"
import { IrLAP, type Link } from "../src/irlap/irlap.ts"
import { FakeMCS7780 } from "./mcs7780.ts"

const open = (device: FakeMCS7780) => MCS7780.open(device as unknown as USBDevice)
const escaped = concat(ascii("over bulk"), Uint8Array.of(0xc0, 0xc1, 0x7d))

test("configures the transceiver and resets it on speed changes", async () => {
  const [device] = FakeMCS7780.pair()
  const dongle = await open(device)

  assert.equal(device.baudRate, 9600)
  assert.equal(device.registers[0], 0xd622)
  assert.equal(device.registers[2], 0x0108)
  assert.equal(device.resets, 1)

  await dongle.setSpeed(115200)
  assert.equal(device.baudRate, 115200)
  assert.equal(device.resets, 2)

  await dongle.setSpeed(2400)
  assert.equal(device.baudRate, 2400)

  await dongle.close()
})

test("carries a full IrLAP session", async () => {
  const [deviceA, deviceB] = FakeMCS7780.pair()
  let bLink: Link | undefined
  const a = new IrLAP(sir(await open(deviceA)))
  const b = new IrLAP(sir(await open(deviceB)), { listener: (link) => (bLink = link) })

  assert.equal(a.capabilities.baudRate, 115200)

  const [device] = await a.discover()
  const link = await a.connect(device.srcDeviceAddress)
  assert.ok(bLink)

  const writer = link.writable.getWriter()
  await writer.write(escaped)
  const reader = bLink.readable.getReader()
  assert.deepEqual((await reader.read()).value, escaped)
  assert.equal(deviceA.baudRate, 115200)
  assert.equal(deviceB.baudRate, 115200)

  await a.close()
  await b.close()
})
