export abstract class Duplex<W = Uint8Array> {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<W>

  #controller!: ReadableStreamDefaultController<Uint8Array>
  #open = true

  constructor() {
    this.readable = new ReadableStream({
      start: (controller) => {
        this.#controller = controller
      },
      cancel: () => {
        this.#open = false
        this.disconnect()
      },
    })

    this.writable = new WritableStream({
      write: async (data) => {
        try {
          await this.write(data)
        } catch (error) {
          this.disconnect()
          throw error
        }
      },
      close: () => this.disconnect(),
      abort: () => this.disconnect(),
    })
  }

  protected abstract write(data: W): void | Promise<void>

  protected abstract disconnect(): void | Promise<void>

  protected get open() {
    return this.#open
  }

  push(data: Uint8Array) {
    if (this.#open) this.#controller.enqueue(data)
  }

  end(error?: unknown) {
    if (!this.#open) return

    this.#open = false
    if (error) this.#controller.error(error)
    else this.#controller.close()
  }
}

export abstract class Connection extends Duplex {
  abstract readonly address: number
  abstract readonly dataSize: number
}
