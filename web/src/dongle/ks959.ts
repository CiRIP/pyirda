import { ascii, chunks, view } from "../bytes.ts"
import { Duplex } from "../connection.ts"
import { INITIAL_BAUD_RATE } from "../irlap/constants.ts"
import { log } from "../log.ts"
import { sleep } from "../timer.ts"
import type { SirPort } from "./dongle.ts"
import { claim, ok } from "./usb.ts"

const VENDOR_ID = 0x07d0
const PRODUCT_ID = 0x4959

const REQ_RECV = 0x01
const REQ_SEND = 0x09

const RX_BUFFER_SIZE = 0x0800
const TX_PACKET_SIZE = 0x100
const FRAGMENT_SIZE = (TX_PACKET_SIZE & ~0x07) - 0x10

const DATA_8_BITS = 0x03
const POLL_INTERVAL = 5

const KEY = ascii("wangshuofei19710")
const BAUD_RATES = [2400, 9600, 19200, 38400, 57600]

const SETUP = { requestType: "class", recipient: "interface" } as const

export class KS959 extends Duplex implements SirPort {
  static readonly filters = [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }]

  readonly baudRates = BAUD_RATES

  #device: USBDevice
  #mask = 0

  private constructor(device: USBDevice) {
    super()
    this.#device = device
  }

  static async open(device: USBDevice): Promise<KS959> {
    await claim(device)

    const dongle = new KS959(device)
    await dongle.setSpeed(INITIAL_BAUD_RATE)
    void dongle.#poll()

    return dongle
  }

  async setSpeed(baudRate: number) {
    if (!this.open) return

    const parameters = new Uint8Array(8)
    view(parameters).setUint32(0, baudRate, true)
    parameters[4] = DATA_8_BITS

    // wIndex carries the protocol's speed selector, so this cannot use the interface recipient
    const setup = {
      requestType: "class",
      recipient: "device",
      request: REQ_SEND,
      value: 0x0200,
      index: 0x0001,
    } as const

    await ok(this.#device.controlTransferOut(setup, parameters))
  }

  async close() {
    this.end()
    await this.#device.close().catch(() => {})
  }

  protected async write(data: Uint8Array) {
    for (const fragment of chunks(data, FRAGMENT_SIZE)) {
      const setup = { ...SETUP, request: REQ_SEND, value: fragment.length, index: 0 }
      await ok(this.#device.controlTransferOut(setup, obfuscate(fragment)))
    }
  }

  protected disconnect() {
    void this.close()
  }

  async #poll() {
    while (this.open) {
      try {
        const setup = { ...SETUP, request: REQ_RECV, value: 0x0200, index: 0 }
        const { data } = await ok(this.#device.controlTransferIn(setup, RX_BUFFER_SIZE))

        if (!data?.byteLength) {
          await sleep(POLL_INTERVAL)
          continue
        }

        this.push(this.#deobfuscate(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)))
      } catch (error) {
        log.debug("KS-959 poll failed", error)
        this.end(error)
        return
      }
    }
  }

  #deobfuscate(data: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.length)
    let length = 0

    for (const byte of data) {
      this.#mask = (this.#mask + 1) & 0xff
      if (this.#mask) out[length++] = byte ^ this.#mask ^ 0x55
    }

    return out.subarray(0, length)
  }
}

function obfuscate(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const padded = new Uint8Array(((data.length + 7) & ~0x07) + 0x10)
  const mask = KEY[(data.length & 0x0f) ^ 0x06] ^ 0x55

  for (const [i, byte] of data.entries()) {
    padded[i] = byte ^ mask
  }

  return padded
}
