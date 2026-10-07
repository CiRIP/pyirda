import { chunks, concat, u16 } from "../bytes.ts"
import { Duplex } from "../connection.ts"
import { INITIAL_BAUD_RATE } from "../irlap/constants.ts"
import { log } from "../log.ts"
import { sleep } from "../timer.ts"
import type { SirPort } from "./dongle.ts"
import { bulk, claim, clearHalts, ok } from "./usb.ts"

const VENDOR_ID = 0x066f
const PRODUCT_ID = 0x4200

const REQ_READ_REG = 0x01
const REQ_WRITE_SINGLE = 0x03

const REG_MODE = 1
const REG_PDCLK = 2
const REG_CTRL = 3
const REG_SENSITIVITY = 4
const REG_STATUS = 5
const REG_DPLL = 8

const MODE_SIR = 0x20
const MODE_FASTRX = 0x08
const MODE_NRESET = 0x02
const MODE_PDCLK8 = 0x01

const CTRL_SDMODE = 0x80
const CTRL_SRESET = 0x01

const STATUS_TRANSMITTING = 0x10
const STATUS_CLEAR = 0x08
const STATUS_EMPTY = 0x04

const FIFO_SIZE = 4096
const HEADER = Uint8Array.of(0x55, 0xaa)
const DPLL_TUNE = 0x15
const TX_POWER = 0
const RX_SENSITIVITY = 1
const POLL_INTERVAL = 5

const PDCLK: Record<number, number> = {
  2400: 0xdf,
  9600: 0x77,
  19200: 0x3b,
  38400: 0x1d,
  57600: 0x13,
  115200: 0x09,
}

const SETUP = { requestType: "vendor", recipient: "device" } as const

const transmitting = (status: number) => Boolean(status & STATUS_TRANSMITTING) && !(status & STATUS_EMPTY)

export class STIR4200 extends Duplex implements SirPort {
  static readonly filters = [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }]

  readonly baudRates = Object.keys(PDCLK).map(Number)

  #device: USBDevice;
  #in: USBEndpoint
  #out: USBEndpoint
  #baudRate = INITIAL_BAUD_RATE
  #busy = Promise.resolve()

  private constructor(device: USBDevice, usbInterface: USBInterface) {
    super()
    this.#device = device
    this.#in = bulk(usbInterface, "in")
    this.#out = bulk(usbInterface, "out")
  }

  static async open(device: USBDevice): Promise<STIR4200> {
    const dongle = new STIR4200(device, await claim(device))
    await clearHalts(device, dongle.#in, dongle.#out)
    await dongle.setSpeed(INITIAL_BAUD_RATE)
    void dongle.#poll()

    return dongle
  }

  setSpeed(baudRate: number): Promise<void> {
    if (!this.open || !PDCLK[baudRate]) return Promise.resolve()

    return this.#exclusive(async () => {
      await this.#waitForRoom(FIFO_SIZE)
      await this.#writeRegister(REG_CTRL, CTRL_SRESET)
      await this.#writeRegister(REG_DPLL, DPLL_TUNE)
      await this.#writeRegister(REG_PDCLK, PDCLK[baudRate])
      await this.#writeRegister(REG_MODE, MODE_NRESET | MODE_FASTRX | MODE_SIR | (baudRate === 2400 ? MODE_PDCLK8 : 0))
      await this.#writeRegister(REG_CTRL, CTRL_SDMODE | (TX_POWER << 1))
      await this.#writeRegister(REG_CTRL, TX_POWER << 1)
      await this.#writeRegister(REG_SENSITIVITY, RX_SENSITIVITY << 5)

      this.#baudRate = baudRate
    })
  }

  async close() {
    this.end()
    await this.#device.close().catch(() => {})
  }

  protected write(data: Uint8Array): Promise<void> {
    return this.#exclusive(async () => {
      for (const frame of chunks(data, FIFO_SIZE - HEADER.length - 2)) {
        const packet = concat(HEADER, u16(frame.length, true), frame)
        await this.#waitForRoom(packet.length)
        await ok(this.#device.transferOut(this.#out.endpointNumber, packet))
      }
    })
  }

  protected disconnect() {
    void this.close()
  }

  // --- dongle side ---

  async #poll() {
    while (this.open) {
      try {
        if (!(await this.#exclusive(() => this.#receive()))) await sleep(POLL_INTERVAL)
      } catch (error) {
        log.debug("STIr4200 poll failed", error)
        this.end(error)
        return
      }
    }
  }

  async #receive(): Promise<boolean> {
    const [status] = await this.#fifo()
    if (transmitting(status)) return false

    // don't trust the fifo count here, the datasheet says it can be off by up to 3 bytes.
    // reading an empty fifo just returns nothing, so it's fine to always read
    const { data } = await ok(this.#device.transferIn(this.#in.endpointNumber, FIFO_SIZE))
    if (!data?.byteLength) return false

    this.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    return true
  }

  async #waitForRoom(length: number) {
    for (let previous = Infinity; ;) {
      const [status, count] = await this.#fifo()

      if (!transmitting(status) || count + length < FIFO_SIZE) return
      if (count >= previous) break

      previous = count
      await sleep((count * 8000) / this.#baudRate)
    }

    await this.#writeRegister(REG_STATUS, STATUS_CLEAR)
    await this.#writeRegister(REG_STATUS, 0)
  }

  async #fifo(): Promise<[status: number, count: number]> {
    const { data } = await ok(
      this.#device.controlTransferIn({ ...SETUP, request: REQ_READ_REG, value: 0, index: REG_STATUS }, 3),
    )

    return [data!.getUint8(0), ((data!.getUint8(2) & 0x1f) << 8) | data!.getUint8(1)]
  }

  async #writeRegister(register: number, value: number) {
    await ok(this.#device.controlTransferOut({ ...SETUP, request: REQ_WRITE_SINGLE, value, index: register }))
  }

  #exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#busy.then(action)
    this.#busy = result.then(
      () => {},
      () => {},
    )

    return result
  }
}
