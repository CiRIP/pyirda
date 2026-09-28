import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import { ascii, concat } from "../src/bytes.ts"
import { STIR421X } from "../src/dongle/index.ts"
import { IrLAP, type Link } from "../src/irlap/irlap.ts"
import { FakeSTIR421X } from "./stir421x.ts"

const IMAGE = new Uint8Array(2500).map((_, i) => i & 0xff)

const patch = (version = "001.000.001") =>
  concat(ascii(`Product Version: ${version}\r\nSigmaTel STIr4210\r\n`), Uint8Array.of(0x1a), ascii("STMP"), IMAGE)

const open = (device: FakeSTIR421X, patches = [patch("001.000.002"), patch()]) =>
  STIR421X.open(device as unknown as USBDevice, patches)

test("uploads the patch image in blocks and reads the patched capabilities", async () => {
  const [device] = FakeSTIR421X.pair()
  const dongle = await open(device)

  assert.deepEqual(
    device.patch!.map((block) => block.length),
    [1023, 1023, 454],
  )
  assert.deepEqual(concat(...device.patch!), IMAGE)
  assert.deepEqual(dongle.baudRates, [2400, 9600, 19200, 38400, 57600, 115200])
  assert.equal(device.baudRate, 9600)

  await dongle.close()
})

test("refuses to open without a patch for the chip revision", async () => {
  const [device] = FakeSTIR421X.pair()

  await assert.rejects(open(device, [patch("001.000.002")]), /No firmware patch for device version 1001/)
  assert.equal(device.patch, undefined)
})

test("sends xbofs and turnaround in the frame header", async () => {
  const [device] = FakeSTIR421X.pair()
  const dongle = await open(device)
  const writer = dongle.writable.getWriter()

  await writer.write({ frame: ascii("hi"), xbofs: 5, turnaround: 1 })
  assert.deepEqual(device.sent.at(-1), Uint8Array.of(0x42, 0, 5, ...ascii("hi")))

  await writer.write({ frame: new Uint8Array(128), xbofs: 5, turnaround: 0 })
  assert.deepEqual(device.sent.at(-1)!.subarray(0, 3), Uint8Array.of(0, 1, 0))
  assert.equal(device.sent.at(-1)!.length, 132)

  await writer.write({ frame: new Uint8Array(61), xbofs: 5, turnaround: 0 })
  assert.deepEqual(
    device.sent.slice(-2).map((packet) => packet.length),
    [64, 0],
  )

  await dongle.close()
})

test("picks the shipped patch for the chip revision", async () => {
  const shipped = await Promise.all(
    ["42101001.sb", "42101002.sb"].map(async (name) => {
      return new Uint8Array(await readFile(new URL(`../src/dongle/firmware/${name}`, import.meta.url)))
    }),
  )
  const [device] = FakeSTIR421X.pair()
  device.deviceVersionSubminor = 2

  const dongle = await open(device, shipped)
  const tag = shipped[1].indexOf(0x1a)
  assert.deepEqual(concat(...device.patch!), shipped[1].subarray(tag + 5))

  await dongle.close()
})

test("carries a full IrLAP session", async () => {
  const [deviceA, deviceB] = FakeSTIR421X.pair()
  let bLink: Link | undefined
  const a = new IrLAP(await open(deviceA))
  const b = new IrLAP(await open(deviceB), { listener: (link) => (bLink = link) })

  const [device] = await a.discover()
  const link = await a.connect(device.srcDeviceAddress)
  assert.ok(bLink)

  await link.writable.getWriter().write(ascii("framed by the chip"))
  assert.deepEqual((await bLink.readable.getReader().read()).value, ascii("framed by the chip"))
  assert.equal(deviceA.baudRate, 115200)
  assert.equal(deviceB.baudRate, 115200)

  await a.close()
  await b.close()
})
