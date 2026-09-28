import { ascii, chunks, concat, EMPTY, equals } from "../bytes.ts"
import { Duplex } from "../connection.ts"
import { INITIAL_BAUD_RATE } from "../irlap/constants.ts"
import { sleep } from "../timer.ts"
import type { Dongle, Transmission } from "./dongle.ts"
import { bulk, claim, ok } from "./usb.ts"

const VENDOR_ID = 0x066f
const PRODUCT_IDS = [0x4210, 0x4220, 0x4116]

const REQ_GET_CLASS_DESCRIPTOR = 0x06
const PREPARE_PATCH = { requestType: "vendor", recipient: "device", request: 0x02, value: 0, index: 0 } as const
const CLASS_DESCRIPTOR_SIZE = 12
const CLASS_DESCRIPTOR_TYPE = 0x21

const PATCH_VERSION = /^Product Version: (\d{3})\.(\d{3})\.(\d+)/
const PATCH_END_OF_HEADER = 0x1a
const PATCH_TAG = ascii("STMP")
const PATCH_CODE_OFFSET = 512
const PATCH_BLOCK_SIZE = 1023
const PATCH_DELAY = 10

const SPEEDS = [2400, 9600, 19200, 38400, 57600, 115200, 576000, 1152000, 4000000]
const XBOFS = [48, 24, 12, 6, 3, 2, 1, 0]
const TURNAROUNDS = [0, 0.01, 0.05, 0.1, 0.5, 1, 5]
const DEFAULT_XBOFS = 12

const HEADER_SIZE = 3
const RX_BUFFER_SIZE = 4096

const speedCode = (baudRate: number) => SPEEDS.indexOf(baudRate) + 1

const xbofsCode = (xbofs: number) => {
  const fewestEnough = XBOFS.findLastIndex((count) => count >= xbofs)
  return (Math.max(fewestEnough, 0) + 1) << 4
}

const turnaroundCode = (turnaround: number) => {
  const code = TURNAROUNDS.findIndex((limit) => turnaround <= limit)
  return code === -1 ? TURNAROUNDS.length : code
}

const padded = (frame: Uint8Array) => frame.length % 128 === 0 && frame.length % 512 !== 0

export class STIR421X extends Duplex<Transmission> implements Dongle {
  static readonly filters = PRODUCT_IDS.map((productId) => ({ vendorId: VENDOR_ID, productId }))

  readonly baudRates: number[]

  #device: USBDevice;
  #in: USBEndpoint
  #out: USBEndpoint
  #baudRate = INITIAL_BAUD_RATE
  #xbofs = DEFAULT_XBOFS

  private constructor(device: USBDevice, usbInterface: USBInterface, baudRates: number[]) {
    super()
    this.#device = device
    this.#in = bulk(usbInterface, "in")
    this.#out = bulk(usbInterface, "out")
    this.baudRates = baudRates
  }

  static async open(device: USBDevice, patches: Uint8Array<ArrayBuffer>[]): Promise<STIR421X> {
    const usbInterface = await claim(device)

    await upload(device, bulk(usbInterface, "out"), image(patches, device))
    const dongle = new STIR421X(device, usbInterface, await supportedBaudRates(device, usbInterface.interfaceNumber))
    await dongle.setSpeed(INITIAL_BAUD_RATE)
    void dongle.#listen()

    return dongle
  }

  async setSpeed(baudRate: number) {
    if (!this.open) return

    await this.#send(Uint8Array.of(speedCode(baudRate) | xbofsCode(this.#xbofs), 0, 0))
    this.#baudRate = baudRate
  }

  async close() {
    this.end()
    await this.#device.close().catch(() => {})
  }

  protected async write({ frame, xbofs, turnaround }: Transmission) {
    const settings = xbofs === this.#xbofs ? 0 : speedCode(this.#baudRate) | xbofsCode(xbofs)
    const header = Uint8Array.of(settings, padded(frame) ? 1 : 0, turnaroundCode(turnaround))

    this.#xbofs = xbofs
    await this.#send(concat(header, frame, padded(frame) ? Uint8Array.of(0) : EMPTY))
  }

  protected disconnect() {
    void this.close()
  }

  async #send(packet: Uint8Array<ArrayBuffer>) {
    await ok(this.#device.transferOut(this.#out.endpointNumber, packet))
    if (packet.length % this.#out.packetSize === 0)
      await ok(this.#device.transferOut(this.#out.endpointNumber, new Uint8Array()))
  }

  async #listen() {
    try {
      while (this.open) {
        const { data } = await ok(this.#device.transferIn(this.#in.endpointNumber, RX_BUFFER_SIZE))
        if (data && data.byteLength > HEADER_SIZE) {
          this.push(new Uint8Array(data.buffer, data.byteOffset + HEADER_SIZE, data.byteLength - HEADER_SIZE))
        }
      }
    } catch (error) {
      this.end(error)
    }
  }
}

function patchVersion(patch: Uint8Array): number | undefined {
  const [, major, minor, build] =
    PATCH_VERSION.exec(new TextDecoder().decode(patch.subarray(0, PATCH_CODE_OFFSET))) ?? []
  if (!major) return

  return (Number(major) << 12) | (Number(minor) << 8) | (Math.floor(Number(build) / 10) << 4) | (Number(build) % 10)
}

const deviceVersion = (device: USBDevice) =>
  (device.deviceVersionMajor << 8) | (device.deviceVersionMinor << 4) | device.deviceVersionSubminor

function image(patches: Uint8Array<ArrayBuffer>[], device: USBDevice): Uint8Array<ArrayBuffer> {
  const patch = patches.find((patch) => patchVersion(patch) === deviceVersion(device))
  if (!patch) throw new Error(`No firmware patch for device version ${deviceVersion(device).toString(16)}`)

  const end = patch.indexOf(PATCH_END_OF_HEADER)
  const code = end + 1 + PATCH_TAG.length

  if (end === -1 || end >= PATCH_CODE_OFFSET || !equals(patch.subarray(end + 1, code), PATCH_TAG)) {
    throw new Error("Firmware patch has no STMP image")
  }

  return patch.subarray(code)
}

async function upload(device: USBDevice, out: USBEndpoint, image: Uint8Array<ArrayBuffer>) {
  await ok(device.controlTransferOut(PREPARE_PATCH))
  await sleep(PATCH_DELAY)

  for (const block of chunks(image, PATCH_BLOCK_SIZE)) {
    await ok(device.transferOut(out.endpointNumber, block))
    await sleep(PATCH_DELAY)
  }
}

async function supportedBaudRates(device: USBDevice, interfaceNumber: number): Promise<number[]> {
  const setup = {
    requestType: "class",
    recipient: "interface",
    request: REQ_GET_CLASS_DESCRIPTOR,
    value: 0,
    index: interfaceNumber,
  } as const
  const { data } = await ok(device.controlTransferIn(setup, CLASS_DESCRIPTOR_SIZE))

  if (data?.byteLength !== CLASS_DESCRIPTOR_SIZE || data.getUint8(1) !== CLASS_DESCRIPTOR_TYPE) {
    throw new Error("Device did not return an IrDA class descriptor")
  }

  const baudRatePv = data.getUint16(7, true)
  return SPEEDS.filter((_, bit) => baudRatePv & (1 << bit))
}
