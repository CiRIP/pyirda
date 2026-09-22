import type { Port } from "../src/irlap/irlap.ts"
import { log } from "../src/log.ts"

log.enabled = Boolean(process.env.IRDA_DEBUG)

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class Wire implements Port {
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null
  peer!: Wire
  lose?: Uint8Array
  baudRate = 0

  #controller?: ReadableStreamDefaultController<Uint8Array>
  #busyUntil = 0

  static pair(): [Wire, Wire] {
    const a = new Wire()
    const b = new Wire()
    a.peer = b
    b.peer = a

    return [a, b]
  }

  async open({ baudRate }: { baudRate: number }) {
    this.baudRate = baudRate
    this.readable = new ReadableStream({
      start: (controller) => {
        this.#controller = controller
      },
      cancel: () => {
        this.readable = null
        this.#controller = undefined
      },
    })
    this.writable = new WritableStream({ write: (data) => this.#transmit(data) })
  }

  async close() {
    const controller = this.#controller
    this.readable = null
    this.writable = null
    controller?.close()
  }

  #transmit(data: Uint8Array) {
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

  #deliver(data: Uint8Array, baudRate: number) {
    if (this.readable && this.baudRate === baudRate) this.#controller!.enqueue(data)
  }
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  return haystack.some((_, start) => needle.every((byte, i) => haystack[start + i] === byte))
}
