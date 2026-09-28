import { concat, EMPTY, hex, u16, view } from "../bytes.ts"
import { Duplex } from "../connection.ts"
import { INITIAL_BAUD_RATE } from "../irlap/constants.ts"
import { crc16 } from "../irlap/crc.ts"
import { log } from "../log.ts"
import { sleep } from "../timer.ts"
import type { Dongle, SirPort, Transmission } from "./dongle.ts"

const XBOF = 0xc0
const BOF = 0xc0
const EOF = 0xc1
const CE = 0x7d

export const sir = (port: SirPort): Dongle => new Sir(port)

class Sir extends Duplex<Transmission> implements Dongle {
  readonly baudRates: number[]

  #port: SirPort
  #writer: WritableStreamDefaultWriter<Uint8Array>
  #baudRate = INITIAL_BAUD_RATE
  #txEnd = 0
  #rx = EMPTY

  constructor(port: SirPort) {
    super()
    this.#port = port
    this.#writer = port.writable.getWriter()
    this.baudRates = port.baudRates

    void this.#listen()
  }

  async setSpeed(baudRate: number) {
    await sleep(this.#txEnd - performance.now())
    await this.#port.setSpeed(baudRate)
    this.#baudRate = baudRate
  }

  async close() {
    this.end()
    await this.#port.close()
  }

  protected async write({ frame, xbofs, turnaround }: Transmission) {
    const bofs = new Uint8Array(xbofs + Math.ceil((turnaround * this.#baudRate) / 10_000)).fill(XBOF)
    const raw = concat(bofs, Uint8Array.of(BOF), stuff(concat(frame, u16(crc16(frame), true))), Uint8Array.of(EOF))

    this.#txEnd = Math.max(performance.now(), this.#txEnd) + (raw.length * 10_000) / this.#baudRate
    await this.#writer.write(raw)
  }

  protected disconnect() {
    void this.close()
  }

  async #listen() {
    try {
      for await (const data of this.#port.readable) this.#receive(data)
      this.end()
    } catch (error) {
      this.end(error)
    }
  }

  #receive(data: Uint8Array) {
    this.#rx = concat(this.#rx, data)

    for (;;) {
      const start = this.#rx.indexOf(BOF)
      if (start === -1) {
        this.#rx = EMPTY
        return
      }

      this.#rx = this.#rx.subarray(start)

      const end = this.#rx.indexOf(EOF, 1)
      if (end === -1) return

      const raw = this.#rx.subarray(1, end)
      this.#rx = this.#rx.subarray(end + 1)

      const payload = unstuff(trimBofs(raw))
      if (checked(payload)) this.push(payload.subarray(0, -2))
      else log.debug("Dropping malformed frame", hex(raw))
    }
  }
}

const checked = (payload: Uint8Array) =>
  payload.length >= 2 && view(payload).getUint16(payload.length - 2, true) === crc16(payload.subarray(0, -2))

function trimBofs(data: Uint8Array): Uint8Array {
  let start = 0
  let end = data.length

  while (start < end && data[start] === XBOF) start++
  while (end > start && data[end - 1] === XBOF) end--

  return data.subarray(start, end)
}

function stuff(data: Uint8Array): Uint8Array {
  const out: number[] = []

  for (const byte of data) {
    if (byte === BOF || byte === EOF || byte === CE) out.push(CE, byte ^ 0x20)
    else out.push(byte)
  }

  return Uint8Array.from(out)
}

function unstuff(data: Uint8Array): Uint8Array {
  const out: number[] = []

  for (let i = 0; i < data.length; i++) {
    out.push(data[i] === CE ? data[++i] ^ 0x20 : data[i])
  }

  return Uint8Array.from(out)
}
