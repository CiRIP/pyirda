import assert from "node:assert/strict"
import { test } from "node:test"

import { ascii, concat } from "../src/bytes.ts"
import { MCS7784, sir } from "../src/dongle/index.ts"
import { IrLAP, type Link } from "../src/irlap/irlap.ts"
import { FakeMCS7784 } from "./mcs7784.ts"

const open = (device: FakeMCS7784) => MCS7784.open(device as unknown as USBDevice)
const escaped = concat(ascii("over bulk"), Uint8Array.of(0xc0, 0xc1, 0x7d))

test("programs the UART divisor and clock for the requested speed", async () => {
  const [device] = FakeMCS7784.pair()
  const dongle = await open(device)

  assert.equal(device.baudRate, 9600)
  assert.equal(device.uart[3], 0x03)
  assert.equal(device.uart[2], 0xcf)
  assert.equal(device.vendor[1], 0x58)
  assert.equal(device.vendor[4], 0x40)
  assert.equal(device.vendor[2], 0)

  await dongle.setSpeed(115200)
  assert.equal(device.baudRate, 115200)
  assert.equal(device.vendor[2], 1)

  await dongle.setSpeed(2400)
  assert.equal(device.baudRate, 2400)
  assert.equal(device.vendor[2], 0)

  await dongle.close()
})

test("carries a full IrLAP session", async () => {
  const [deviceA, deviceB] = FakeMCS7784.pair()
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
