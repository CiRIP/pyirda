import { Duplex } from "../connection.ts"
import { INITIAL_BAUD_RATE } from "../irlap/constants.ts"
import { sleep } from "../timer.ts"
import type { SirPort } from "./dongle.ts"
import { bulk, claim, clearHalts, ok } from "./usb.ts"

// basically a 16550 with an ir transceiver glued on, init copied from mossir.sys (the uir-33 32 bit driver).
// vendor reg 4 bit 0x40 is the thing that actually turns irda on. mcr stays untouched as dtr/rts/irda_en
// made seemingly zero difference on the uir-33. if a board receives but never blinks, perhaps try mcr 0x0b first

const VENDOR_ID = 0x9710
const PRODUCT_IDS = [0x7784, 0x7703]

const REQ_WRITE = 0x0e
const REQ_READ = 0x0d

const UART = 0x0300
const VENDOR = 0x0000

const UART_DLL = 0
const UART_IER = 1
const UART_FCR = 2
const UART_LCR = 3
const UART_LSR = 5

const VENDOR_CONTROL = 1
const VENDOR_CLOCK_MULTIPLIER = 2
const VENDOR_CLOCK_START = 3
const VENDOR_DEVICE_CONTROL = 4

const CONTROL_READY = 0x08
const CONTROL_IRDA = 0x50
const DEVICE_CONTROL_IRDA = 0x40

const FCR_RESET = 0xcf
const LCR_8N1 = 0x03
const LCR_DLAB = 0x80
const LSR_TX_EMPTY = 0x40

const BAUD_RATES = [2400, 9600, 19200, 38400, 57600, 115200]
const BASE_BAUD_RATE = 115200
const DRAIN_DELAY = 50
const RX_BUFFER_SIZE = 4096

const SETUP = { requestType: "vendor", recipient: "device" } as const

export class MCS7784 extends Duplex implements SirPort {
  static readonly filters = PRODUCT_IDS.map((productId) => ({ vendorId: VENDOR_ID, productId }))

  readonly baudRates = BAUD_RATES

  #device: USBDevice;
  #in: USBEndpoint
  #out: USBEndpoint

  private constructor(device: USBDevice, usbInterface: USBInterface) {
    super()
    this.#device = device
    this.#in = bulk(usbInterface, "in")
    this.#out = bulk(usbInterface, "out")
  }

  static async open(device: USBDevice): Promise<MCS7784> {
    const dongle = new MCS7784(device, await claim(device))
    await clearHalts(device, dongle.#in, dongle.#out)
    await dongle.#update(VENDOR, VENDOR_CONTROL, CONTROL_READY)
    await dongle.setSpeed(INITIAL_BAUD_RATE)
    void dongle.#listen()

    return dongle
  }

  async setSpeed(baudRate: number) {
    if (!this.open || !BAUD_RATES.includes(baudRate)) return

    while (!((await this.#read(UART, UART_LSR)) & LSR_TX_EMPTY));
    await sleep(DRAIN_DELAY)

    await this.#write(UART, UART_IER, 0)
    await this.#update(VENDOR, VENDOR_DEVICE_CONTROL, DEVICE_CONTROL_IRDA)
    await this.#update(VENDOR, VENDOR_CONTROL, CONTROL_IRDA)
    await this.#write(UART, UART_FCR, 0)
    await this.#write(UART, UART_FCR, FCR_RESET)

    await this.#write(UART, UART_LCR, LCR_8N1 | LCR_DLAB)
    await this.#write(VENDOR, VENDOR_CLOCK_MULTIPLIER, baudRate === BASE_BAUD_RATE ? 1 : 0)
    await this.#write(VENDOR, VENDOR_CLOCK_START, 0)
    await this.#write(UART, UART_DLL, BASE_BAUD_RATE / baudRate)
    await this.#write(UART, UART_LCR, LCR_8N1)
  }

  async close() {
    this.end()
    await this.#device.close().catch(() => {})
  }

  protected async write(data: Uint8Array<ArrayBuffer>) {
    await ok(this.#device.transferOut(this.#out.endpointNumber, data))
  }

  protected disconnect() {
    void this.close()
  }

  async #listen() {
    try {
      while (this.open) {
        const { data } = await ok(this.#device.transferIn(this.#in.endpointNumber, RX_BUFFER_SIZE))
        if (data?.byteLength) this.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      }
    } catch (error) {
      this.end(error)
    }
  }

  async #update(space: number, register: number, set: number) {
    await this.#write(space, register, (await this.#read(space, register)) | set)
  }

  async #read(space: number, register: number): Promise<number> {
    const { data } = await ok(
      this.#device.controlTransferIn({ ...SETUP, request: REQ_READ, value: space, index: register }, 1),
    )
    return data!.getUint8(0)
  }

  async #write(space: number, register: number, value: number) {
    await ok(this.#device.controlTransferOut({ ...SETUP, request: REQ_WRITE, value: space | value, index: register }))
  }
}
