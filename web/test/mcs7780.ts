import { view } from "../src/bytes.ts"

const REQ_WRITE = 0x0e
const REQ_READ = 0x0f

const MODE_DRIVER = 0x0200
const MODE_RESET = 0x8000
const DEFAULT_MODE = 0xd524
const PACKET_SIZE = 64

const BAUD_RATES = [2400, 9600, 19200, 38400, 57600, 115200]

export class FakeMCS7780 implements Partial<USBDevice> {
  configuration = {
    interfaces: [
      {
        interfaceNumber: 0,
        alternate: {
          endpoints: [
            { endpointNumber: 1, direction: "in", type: "bulk", packetSize: PACKET_SIZE },
            { endpointNumber: 2, direction: "out", type: "bulk", packetSize: PACKET_SIZE },
          ],
        },
      },
    ],
  } as USBConfiguration
  peer!: FakeMCS7780
  registers = Uint16Array.of(DEFAULT_MODE, 0, 0x0100, 0, 0, 0, 0x400a, 0x0028)
  resets = 0

  #received: Uint8Array[] = []
  #reading?: PromiseWithResolvers<Uint8Array>

  static pair(): [FakeMCS7780, FakeMCS7780] {
    const a = new FakeMCS7780()
    const b = new FakeMCS7780()
    a.peer = b
    b.peer = a

    return [a, b]
  }

  get baudRate() {
    return BAUD_RATES[(this.registers[0] >> 5) & 0x07]
  }

  async open() {}

  async close() {
    this.#reading?.reject(new Error("device closed"))
  }

  async claimInterface() {}

  async controlTransferOut(setup: USBControlTransferParameters): Promise<USBOutTransferResult> {
    if (setup.requestType !== "vendor" || setup.request !== REQ_WRITE) throw new Error("unexpected request")
    if (setup.index && !(this.registers[0] & MODE_DRIVER)) throw new Error("registers locked")

    this.registers[setup.index] = setup.value
    if (setup.index === 0 && !(setup.value & MODE_RESET)) {
      this.registers[0] |= MODE_RESET
      this.resets++
    }

    return { bytesWritten: 0, status: "ok" }
  }

  async controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult> {
    if (setup.requestType !== "vendor" || setup.request !== REQ_READ || length !== 2)
      throw new Error("unexpected request")

    return { data: new DataView(Uint16Array.of(this.registers[setup.index]).buffer), status: "ok" }
  }

  async transferOut(endpoint: number, source: BufferSource): Promise<USBOutTransferResult> {
    const data = source as Uint8Array

    if (endpoint !== 2) throw new Error(`unexpected endpoint ${endpoint}`)
    if (view(data).getUint16(0, true) !== data.length) throw new Error("bad frame length")

    const start = data.lastIndexOf(0xc0) + 1
    if (this.peer.baudRate === this.baudRate) this.peer.#deliver(data.slice(start, data.indexOf(0xc1, start)))

    return { bytesWritten: data.length, status: "ok" }
  }

  async transferIn(endpoint: number, length: number): Promise<USBInTransferResult> {
    if (endpoint !== 1) throw new Error(`unexpected endpoint ${endpoint}`)
    if (length % PACKET_SIZE) throw new Error(`unaligned read of ${length} bytes`)

    const frame = this.#received.shift() ?? (await (this.#reading = Promise.withResolvers()).promise)
    return { data: view(frame), status: "ok" }
  }

  #deliver(frame: Uint8Array) {
    if (this.#reading) {
      this.#reading.resolve(frame)
      this.#reading = undefined
    } else {
      this.#received.push(frame)
    }
  }
}
