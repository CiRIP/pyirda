import { STIR421X_PATCHES } from "../src/dongle/firmware/index.ts"
import { KS959, MCS7780, SerialDongle, sir, STIR4200, STIR421X, type Dongle } from "../src/dongle/index.ts"
import { IrLAP } from "../src/irlap/irlap.ts"
import { IrLMP, type Device } from "../src/irlmp/index.ts"
import { OBEX } from "../src/obex/index.ts"
import { sleep } from "../src/timer.ts"
import { TinyTP } from "../src/tinytp/index.ts"

const DISCOVERY_INTERVAL = 1000

const USB_DRIVERS = [
  { filters: KS959.filters, open: async (device: USBDevice) => sir(await KS959.open(device)) },
  { filters: MCS7780.filters, open: async (device: USBDevice) => sir(await MCS7780.open(device)) },
  { filters: STIR4200.filters, open: async (device: USBDevice) => sir(await STIR4200.open(device)) },
  { filters: STIR421X.filters, open: (device: USBDevice) => STIR421X.open(device, STIR421X_PATCHES) },
]

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const wizard = $<HTMLDialogElement>("wizard")
const picker = $<HTMLInputElement>("picker")
const progress = $<HTMLProgressElement>("progress")

let file: File
let session = new AbortController()

window.ondragover = (event) => {
  event.preventDefault()
  document.body.classList.add("dragging")
}

window.ondragleave = (event) => {
  if (!event.relatedTarget) document.body.classList.remove("dragging")
}

window.ondrop = (event) => {
  event.preventDefault()
  document.body.classList.remove("dragging")

  const [dropped] = event.dataTransfer!.files
  if (dropped && !wizard.open) start(dropped)
}

picker.onchange = () => {
  start(picker.files![0])
  picker.value = ""
}

wizard.onclose = () => session.abort()

$("retry").onclick = restart

$("serial").onclick = () => run(async () => sir(await SerialDongle.open(await navigator.serial.requestPort())))

$("usb").onclick = () => run(openUsb)

function start(chosen: File) {
  file = chosen
  $("name").textContent = file.name
  restart()
  wizard.showModal()
}

function restart() {
  session.abort()
  session = new AbortController()
  show("dongle-step")
}

async function run(openDongle: () => Promise<Dongle>) {
  const { signal } = session

  try {
    await send(await openDongle(), signal)
    show("done-step")
  } catch (error) {
    if (signal.aborted) return

    $("error").textContent = error instanceof Error ? error.message : String(error)
    show("failed-step")
  }
}

async function openUsb(): Promise<Dongle> {
  const device = await navigator.usb.requestDevice({ filters: USB_DRIVERS.flatMap(({ filters }) => filters) })

  const driver = USB_DRIVERS.find(({ filters }) =>
    filters.some(({ vendorId, productId }) => vendorId === device.vendorId && productId === device.productId),
  )

  return driver!.open(device)
}

async function send(dongle: Dongle, signal: AbortSignal) {
  const irlap = new IrLAP(dongle, { slots: 1 })
  const irlmp = new IrLMP(irlap)
  const obex = new OBEX(new TinyTP(irlmp))

  signal.addEventListener("abort", () => void irlap.close())

  show("searching-step")
  const device = await firstToAnswer(irlmp, signal)

  show("sending-step")
  progress.max = file.size
  progress.value = 0

  const client = await obex.connect(device.address)
  await client.put(file.name, new Uint8Array(await file.arrayBuffer()), {
    progress: (transferred) => (progress.value = transferred),
    signal,
  })
  await client.disconnect()
}

async function firstToAnswer(irlmp: IrLMP, signal: AbortSignal): Promise<Device> {
  for (;;) {
    signal.throwIfAborted()

    const [device] = await irlmp.discover()
    if (device) return device

    await sleep(DISCOVERY_INTERVAL)
  }
}

function show(step: string) {
  for (const section of wizard.querySelectorAll("section")) section.hidden = section.id !== step
  for (const item of wizard.querySelectorAll("li")) item.classList.toggle("active", item.dataset.step === step)
}
