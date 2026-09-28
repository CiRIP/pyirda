import { Duplex } from "../src/connection.ts"
import type { SirPort } from "../src/dongle/index.ts"
import { INITIAL_BAUD_RATE } from "../src/irlap/constants.ts"
import { log } from "../src/log.ts"

log.enabled = Boolean(process.env.IRDA_DEBUG)

export { sir } from "../src/dongle/sir.ts"
export { sleep } from "../src/timer.ts"

export class Wire extends Duplex implements SirPort {
  readonly baudRates = [2400, 9600, 19200, 38400, 57600, 115200]

  peer!: Wire
  lose?: Uint8Array
  baudRate = INITIAL_BAUD_RATE

  #busyUntil = 0

  static pair(): [Wire, Wire] {
    const a = new Wire()
    const b = new Wire()
    a.peer = b
    b.peer = a

    return [a, b]
  }

  async setSpeed(baudRate: number) {
    this.baudRate = baudRate
  }

  async close() {
    this.end()
  }

  protected write(data: Uint8Array) {
    if (this.lose && contains(data, this.lose)) {
      console.info("*** losing frame carrying", new TextDecoder().decode(this.lose))
      this.lose = undefined
      return
    }

    const now = performance.now()
    const baudRate = this.baudRate
    this.#busyUntil = Math.max(now, this.#busyUntil) + (data.length * 10_000) / baudRate
    setTimeout(() => this.peer.#deliver(data, baudRate), this.#busyUntil - now)
  }

  protected disconnect() {
    void this.close()
  }

  #deliver(data: Uint8Array, baudRate: number) {
    if (this.baudRate === baudRate) this.push(data)
  }
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  return haystack.some((_, start) => needle.every((byte, i) => haystack[start + i] === byte))
}
