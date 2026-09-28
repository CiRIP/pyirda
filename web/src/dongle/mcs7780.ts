import { concat, u16 } from "../bytes.ts"
import { Duplex } from "../connection.ts"
import { INITIAL_BAUD_RATE } from "../irlap/constants.ts"
import { sleep } from "../timer.ts"
import type { SirPort } from "./dongle.ts"
import { bulk, claim, ok } from "./usb.ts"

const VENDOR_ID = 0x9710
const PRODUCT_ID = 0x7780

const REQ_WRITE = 0x0e
const REQ_READ = 0x0f

const REG_MODE = 0
const REG_XCVR = 2
const REG_MINRXPW = 4
const REG_RESV = 7

const MODE_FIR = 0x0001
const MODE_SIR16US = 0x0002
const MODE_BBTG = 0x0004
const MODE_ASK = 0x0008
const MODE_SPEED = 0x00e0
const MODE_PLLPWDN = 0x0100
const MODE_DRIVER = 0x0200
const MODE_DTD = 0x0400
const MODE_SIPEN = 0x1000
const MODE_RESET = 0x8000

const XCVR_MODE0 = 0x0001
const XCVR_STFIR = 0x0002
const XCVR_CONF = 0x0004
const XCVR_RXFAST = 0x0008
const XCVR_MODE1 = 0x0080

const RESV_IRINTX = 0x0001

const BAUD_RATES = [2400, 9600, 19200, 38400, 57600, 115200]
const BOF = Uint8Array.of(0xc0)
const EOF = Uint8Array.of(0xc1)
const RX_BUFFER_SIZE = 4096
const POLL_INTERVAL = 5

const SETUP = { requestType: "vendor", recipient: "device" } as const

export class MCS7780 extends Duplex implements SirPort {
  static readonly filters = [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }]

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

  static async open(device: USBDevice): Promise<MCS7780> {
    const dongle = new MCS7780(device, await claim(device))
    await dongle.#setup()
    await dongle.setSpeed(INITIAL_BAUD_RATE)
    void dongle.#listen()

    return dongle
  }

  async setSpeed(baudRate: number) {
    if (!this.open || !BAUD_RATES.includes(baudRate)) return

    while ((await this.#read(REG_RESV)) & RESV_IRINTX) await sleep(POLL_INTERVAL)

    await this.#update(REG_MODE, BAUD_RATES.indexOf(baudRate) << 5, MODE_SPEED)
    await this.#update(REG_MODE, 0, MODE_RESET)
  }

  async close() {
    this.end()
    await this.#device.close().catch(() => {})
  }

  protected async write(data: Uint8Array) {
    await ok(this.#device.transferOut(this.#out.endpointNumber, concat(u16(data.length + 2, true), data)))
  }

  protected disconnect() {
    void this.close()
  }

  async #setup() {
    await this.#update(REG_MODE, MODE_DRIVER)
    await this.#write(REG_MINRXPW, 0)
    await this.#update(REG_MODE, MODE_SIR16US | MODE_DTD | MODE_SIPEN, MODE_FIR | MODE_BBTG | MODE_ASK | MODE_PLLPWDN)

    await this.#update(REG_XCVR, XCVR_MODE0 | XCVR_CONF, XCVR_STFIR | XCVR_MODE1)
    await this.#update(REG_XCVR, 0, XCVR_MODE0)
    await this.#update(REG_XCVR, XCVR_RXFAST, XCVR_CONF)
  }

  async #listen() {
    try {
      while (this.open) {
        const { data } = await ok(this.#device.transferIn(this.#in.endpointNumber, RX_BUFFER_SIZE))
        if (data?.byteLength) this.push(concat(BOF, new Uint8Array(data.buffer, data.byteOffset, data.byteLength), EOF))
      }
    } catch (error) {
      this.end(error)
    }
  }

  async #update(register: number, set: number, clear = 0) {
    await this.#write(register, ((await this.#read(register)) & ~clear) | set)
  }

  async #read(register: number): Promise<number> {
    const { data } = await ok(
      this.#device.controlTransferIn({ ...SETUP, request: REQ_READ, value: 0, index: register }, 2),
    )
    return data!.getUint16(0, true)
  }

  async #write(register: number, value: number) {
    await ok(this.#device.controlTransferOut({ ...SETUP, request: REQ_WRITE, value, index: register }))
  }
}
