import type { Dongle } from "../src/dongle/index.ts"
import { STIR421X_PATCHES } from "../src/dongle/firmware/index.ts"
import { KS959, MCS7780, SerialDongle, sir, STIR4200, STIR421X } from "../src/dongle/index.ts"
import { IrLAP } from "../src/irlap/irlap.ts"
import { baudRatePv, Parameters } from "../src/irlap/negotiation.ts"
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

$("serial").onclick = guarded(async () => start(sir(await SerialDongle.open(await navigator.serial.requestPort()))))

$("ks959").onclick = guarded(async () =>
  start(sir(await KS959.open(await navigator.usb.requestDevice({ filters: KS959.filters })))),
)

$("stir4200").onclick = guarded(async () =>
  start(sir(await STIR4200.open(await navigator.usb.requestDevice({ filters: STIR4200.filters })))),
)

$("mcs7780").onclick = guarded(async () =>
  start(sir(await MCS7780.open(await navigator.usb.requestDevice({ filters: MCS7780.filters })))),
)

$("stir421x").onclick = guarded(async () =>
  start(await STIR421X.open(await navigator.usb.requestDevice({ filters: STIR421X.filters }), STIR421X_PATCHES)),
)

const offered = (baudRates: number[]) =>
  baudRates.filter((baudRate) => baudRate <= Number($<HTMLSelectElement>("baud").value))

function start(dongle: Dongle) {
  const baudRates = offered(dongle.baudRates)
  const irlap = new IrLAP(dongle, { capabilities: new Parameters({ baudRatePv: baudRatePv(baudRates) }) })
  irlmp = new IrLMP(irlap, { nickname: "web", hints: Hints.COMPUTER | Hints.OBEX })
  const tinytp = new TinyTP(irlmp)
  obex = new OBEX(tinytp)

  const inbox = obex.server({
    put: receive,
    progress: (opcode, headers, transferred, total) => showProgress("receiving", transferred, total),
  })
  irlmp.listeners.set(0x05, tinytp.server(inbox))
  irlmp.ias.objects.OBEX = { "IrDA:TinyTP:LsapSel": 0x05 }

  $<HTMLFieldSetElement>("port").disabled = true
  $<HTMLFieldSetElement>("link").disabled = false
  print(`Dongle ready, offering ${baudRates.join(", ")} baud, listening for incoming files`)
}

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
  await client.put(file.name, new Uint8Array(await file.arrayBuffer()), {
    progress: (transferred, total) => showProgress("sending", transferred, total),
  })
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

function showProgress(id: string, transferred: number, total?: number) {
  const bar = $<HTMLProgressElement>(id)

  if (total) bar.value = transferred / total
  else bar.removeAttribute("value")
}

const describe = (device: Device) =>
  `${device.nickname} ${formatAddress(device.address)} hints=0x${device.hints.toString(16)}`

const option = (device: Device) =>
  Object.assign(document.createElement("option"), { value: device.address, textContent: describe(device) })
