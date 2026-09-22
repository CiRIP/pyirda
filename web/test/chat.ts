import type { Connection } from "../src/connection.ts"
import { sleep } from "./wire.ts"

export class Chat<C extends Connection = Connection> {
  readonly connection: C
  readonly received: Uint8Array[] = []
  readonly closed: Promise<unknown>
  readonly writer: WritableStreamDefaultWriter<Uint8Array>

  constructor(connection: C, sends: Uint8Array[] = []) {
    this.connection = connection
    this.writer = connection.writable.getWriter()
    for (const data of sends) this.writer.write(data).catch(() => {})

    this.closed = (async () => {
      try {
        for await (const chunk of connection.readable) this.received.push(chunk)
      } catch (error) {
        return error
      }
    })()
  }

  async receive(count: number): Promise<Uint8Array[]> {
    while (this.received.length < count) await sleep(50)

    return this.received
  }

  close() {
    return this.writer.close()
  }
}
