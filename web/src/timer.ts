export class Timer {
  readonly timeout: number
  #expire: () => void
  #delay: () => number
  #handle?: ReturnType<typeof setTimeout>

  constructor(timeout: number, expire: () => void, delay: () => number = () => 0) {
    this.timeout = timeout
    this.#expire = expire
    this.#delay = delay
  }

  start() {
    this.stop()
    this.#handle = setTimeout(this.#expire, this.#delay() + this.timeout)
  }

  stop() {
    clearTimeout(this.#handle)
    this.#handle = undefined
  }
}
