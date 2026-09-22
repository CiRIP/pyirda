export abstract class Connection {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  abstract readonly address: number
  abstract readonly dataSize: number

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

  protected abstract write(data: Uint8Array): void | Promise<void>

  protected abstract disconnect(): void

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
