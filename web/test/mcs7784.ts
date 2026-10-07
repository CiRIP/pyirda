import { concat, EMPTY } from "../src/bytes.ts"

const REQ_WRITE = 0x0e
const REQ_READ = 0x0d

const UART = 0x0300
const UART_DLL = 0
const UART_LCR = 3
const UART_LSR = 5
const LCR_DLAB = 0x80
const LSR_TX_EMPTY = 0x40
const PACKET_SIZE = 64

export class FakeMCS7784 implements Partial<USBDevice> {
  configuration = {
    interfaces: [
      {
        interfaceNumber: 0,
        alternate: {
          endpoints: [
            { endpointNumber: 5, direction: "in", type: "bulk", packetSize: PACKET_SIZE },
            { endpointNumber: 6, direction: "out", type: "bulk", packetSize: 32 },
            { endpointNumber: 7, direction: "in", type: "interrupt", packetSize: 16 },
          ],
        },
      },
    ],
  } as USBConfiguration
  peer!: FakeMCS7784
  uart = Uint8Array.of(0, 0, 0, 0, 0, LSR_TX_EMPTY, 0, 0)
  vendor = new Uint8Array(8)
  divisor = 0

  #rx = EMPTY
  #reading?: PromiseWithResolvers<void>

  static pair(): [FakeMCS7784, FakeMCS7784] {
    const a = new FakeMCS7784()
    const b = new FakeMCS7784()
    a.peer = b
    b.peer = a

    return [a, b]
  }

  get baudRate() {
    return 115200 / this.divisor
  }

  async open() {}

  async close() {
    this.#reading?.reject(new Error("device closed"))
  }

  async claimInterface() {}

  async clearHalt() {}

  async controlTransferOut(setup: USBControlTransferParameters): Promise<USBOutTransferResult> {
    if (setup.requestType !== "vendor" || setup.request !== REQ_WRITE) throw new Error("unexpected request")

    const value = setup.value & 0xff
    const latched = setup.index === UART_DLL && this.uart[UART_LCR] & LCR_DLAB

    if (latched && setup.value & UART) this.divisor = value
    else if (setup.value & UART) this.uart[setup.index] = value
    else this.vendor[setup.index] = value

    return { bytesWritten: 0, status: "ok" }
  }

  async controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult> {
    if (setup.requestType !== "vendor" || setup.request !== REQ_READ || length !== 1)
      throw new Error("unexpected request")

    const registers = setup.value === UART ? this.uart : this.vendor
    return { data: new DataView(Uint8Array.of(registers[setup.index]).buffer), status: "ok" }
  }

  async transferOut(endpoint: number, source: BufferSource): Promise<USBOutTransferResult> {
    const data = source as Uint8Array

    if (endpoint !== 6) throw new Error(`unexpected endpoint ${endpoint}`)
    if (this.uart[UART_LCR] & LCR_DLAB) throw new Error("divisor latch left open")
    if (this.peer.baudRate === this.baudRate) this.peer.#receive(data)

    return { bytesWritten: data.length, status: "ok" }
  }

  async transferIn(endpoint: number, length: number): Promise<USBInTransferResult> {
    if (endpoint !== 5) throw new Error(`unexpected endpoint ${endpoint}`)
    if (length % PACKET_SIZE) throw new Error(`unaligned read of ${length} bytes`)

    if (!this.#rx.length) await (this.#reading = Promise.withResolvers()).promise

    const sending = this.#rx.slice(0, length)
    this.#rx = this.#rx.subarray(sending.length)

    return { data: new DataView(sending.buffer), status: "ok" }
  }

  #receive(data: Uint8Array) {
    this.#rx = concat(this.#rx, data)
    this.#reading?.resolve()
    this.#reading = undefined
  }
}
