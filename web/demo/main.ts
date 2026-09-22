import { IrLAP } from "../src/irlap/irlap.ts"
import { Parameters } from "../src/irlap/negotiation.ts"
import { Hints, IrLMP, type Device } from "../src/irlmp/index.ts"
import { formatAddress } from "../src/irlmp/irlmp.ts"
import { log } from "../src/log.ts"
import { Header, OBEX, ResponseCode, header, type Headers } from "../src/obex/index.ts"
import { TinyTP } from "../src/tinytp/index.ts"

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const print = (...parts: unknown[]) => {
  $("log").textContent += `${new Date().toLocaleTimeString()} ${parts.join(" ")}\n`
  $("log").scrollTop = $("log").scrollHeight
}

const guarded = (action: () => Promise<void>) => () => action().catch((error) => print("Error:", error))

let irlmp: IrLMP
let obex: OBEX

$("debug").onchange = () => (log.enabled = $<HTMLInputElement>("debug").checked)

$("connect").onclick = guarded(async () => {
  const port = await navigator.serial.requestPort()
  const capabilities = new Parameters({ baudRatePv: Number($<HTMLSelectElement>("baud").value) })
  const irlap = new IrLAP(port, { capabilities })
  irlmp = new IrLMP(irlap, { nickname: "web", hints: Hints.COMPUTER | Hints.OBEX })
  const tinytp = new TinyTP(irlmp)
  obex = new OBEX(tinytp)

  irlmp.listeners.set(0x05, tinytp.server(obex.server({ put: receive })))
  irlmp.ias.objects.OBEX = { "IrDA:TinyTP:LsapSel": 0x05 }

  await irlap.open()
  $<HTMLFieldSetElement>("port").disabled = true
  $<HTMLFieldSetElement>("link").disabled = false
  print("Port open, listening for incoming files")
})

$("discover").onclick = guarded(async () => {
  const devices = await irlmp.discover()
  const select = $<HTMLSelectElement>("device")
  select.replaceChildren(select.options[0], ...devices.map(option))
  print(`Found ${devices.length} device(s)`, ...devices.map(describe))
})

$("send").onclick = guarded(async () => {
  const file = $<HTMLInputElement>("file").files?.[0]
  if (!file) throw new Error("Choose a file first")

  const address = Number($<HTMLSelectElement>("device").value) || (await findObexDevice()).address
  print(`Sending ${file.name} (${file.size} bytes) to ${formatAddress(address)}`)

  const client = await obex.connect(address)
  await client.put(file.name, new Uint8Array(await file.arrayBuffer()))
  await client.disconnect()
  print("Sent")
})

async function findObexDevice(): Promise<Device> {
  const device = (await irlmp.discover()).find((device) => device.hints & Hints.OBEX)
  if (!device) throw new Error("No device advertising OBEX in range")

  return device
}

function receive(headers: Headers, content: Uint8Array | null): number {
  const name = String(header(headers, Header.NAME) ?? "unnamed")
  if (!content) return ResponseCode.FORBIDDEN

  const link = document.createElement("a")
  link.href = URL.createObjectURL(new Blob([content.slice()]))
  link.download = name
  link.textContent = `${name} (${content.length} bytes)`
  $("inbox").append(Object.assign(document.createElement("li"), { children: [link] }))
  print(`Received ${name} (${content.length} bytes)`)

  return ResponseCode.SUCCESS
}

const describe = (device: Device) =>
  `${device.nickname} ${formatAddress(device.address)} hints=0x${device.hints.toString(16)}`

const option = (device: Device) =>
  Object.assign(document.createElement("option"), { value: device.address, textContent: describe(device) })
