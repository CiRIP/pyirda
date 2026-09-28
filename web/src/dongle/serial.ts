import { Duplex } from "../connection.ts"
import { INITIAL_BAUD_RATE } from "../irlap/constants.ts"
import { log } from "../log.ts"
import type { SirPort } from "./dongle.ts"

const BAUD_RATES = [2400, 9600]

export class SerialDongle extends Duplex implements SirPort {
  readonly baudRates: number[]

  #port: SerialPort
  #reader?: ReadableStreamDefaultReader<Uint8Array>
  #writer?: WritableStreamDefaultWriter<Uint8Array>
  #pump?: Promise<void>

  private constructor(port: SerialPort, baudRates: number[]) {
    super()
    this.#port = port
    this.baudRates = baudRates
  }

  static async open(port: SerialPort, baudRates = BAUD_RATES): Promise<SerialDongle> {
    const dongle = new SerialDongle(port, baudRates)
    await dongle.#start(INITIAL_BAUD_RATE)

    return dongle
  }

  async setSpeed(baudRate: number) {
    if (!this.open) return

    await this.#stop()
    await this.#start(baudRate)
  }

  async close() {
    await this.#stop()
    this.end()
  }

  protected async write(data: Uint8Array) {
    await this.#writer?.write(data)
  }

  protected disconnect() {
    void this.close()
  }

  async #start(baudRate: number) {
    await this.#port.open({ baudRate })
    this.#writer = this.#port.writable!.getWriter()
    this.#reader = this.#port.readable!.getReader()
    this.#pump = this.#read(this.#reader)
  }

  async #read(reader: ReadableStreamDefaultReader<Uint8Array>) {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return

        this.push(value)
      }
    } catch (error) {
      log.debug("Serial read failed", error)
    }
  }

  async #stop() {
    if (!this.#reader) return

    await this.#reader.cancel().catch(() => {})
    await this.#pump
    this.#reader.releaseLock()
    this.#reader = undefined

    await this.#writer!.close().catch(() => {})
    this.#writer!.releaseLock()
    this.#writer = undefined

    await this.#port.close()
  }
}
