import { concat, EMPTY, view } from "../src/bytes.ts"

const REQ_READ_REG = 0x01
const REQ_WRITE_SINGLE = 0x03

const REG_PDCLK = 2
const STATUS_TRANSMITTING = 0x10
const STATUS_EMPTY = 0x04
const PACKET_SIZE = 64

const PDCLK: Record<number, number> = { 0xdf: 2400, 0x77: 9600, 0x3b: 19200, 0x1d: 38400, 0x13: 57600, 0x09: 115200 }

export class FakeSTIR4200 implements Partial<USBDevice> {
  configuration = {
    interfaces: [
      {
        interfaceNumber: 0,
        alternate: {
          endpoints: [
            { endpointNumber: 1, direction: "out", type: "bulk", packetSize: PACKET_SIZE },
            { endpointNumber: 2, direction: "in", type: "bulk", packetSize: PACKET_SIZE },
          ],
        },
      },
    ],
  } as USBConfiguration
  peer!: FakeSTIR4200
  baudRate = 0
  registers = new Uint8Array(16)

  #rx = EMPTY

  static pair(): [FakeSTIR4200, FakeSTIR4200] {
    const a = new FakeSTIR4200()
    const b = new FakeSTIR4200()
    a.peer = b
    b.peer = a

    return [a, b]
  }

  async open() {}

  async close() {}

  async claimInterface() {}

  async clearHalt() {}

  async controlTransferOut(setup: USBControlTransferParameters): Promise<USBOutTransferResult> {
    if (setup.request !== REQ_WRITE_SINGLE) throw new Error(`unexpected request ${setup.request}`)

    this.registers[setup.index] = setup.value
    if (setup.index === REG_PDCLK) this.baudRate = PDCLK[setup.value]

    return { bytesWritten: 0, status: "ok" }
  }

  async controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult> {
    if (setup.request !== REQ_READ_REG) throw new Error(`unexpected request ${setup.request}`)

    const registers = this.registers.slice(setup.index, setup.index + length)
    registers[0] = this.#rx.length ? 0 : STATUS_TRANSMITTING | STATUS_EMPTY
    registers[1] = this.#rx.length & 0xff
    registers[2] = this.#rx.length >> 8

    return { data: view(registers), status: "ok" }
  }

  async transferOut(endpoint: number, source: BufferSource): Promise<USBOutTransferResult> {
    const data = source as Uint8Array

    if (endpoint !== 1) throw new Error(`unexpected endpoint ${endpoint}`)
    if (data[0] !== 0x55 || data[1] !== 0xaa) throw new Error("bad frame header")
    if (view(data).getUint16(2, true) !== data.length - 4) throw new Error("bad frame length")

    this.peer.#receive(data.subarray(4))

    return { bytesWritten: data.length, status: "ok" }
  }

  async transferIn(endpoint: number, length: number): Promise<USBInTransferResult> {
    if (endpoint !== 2) throw new Error(`unexpected endpoint ${endpoint}`)
    if (length % PACKET_SIZE) throw new Error(`unaligned read of ${length} bytes`)

    const sending = this.#rx.subarray(0, length)
    this.#rx = this.#rx.subarray(sending.length)

    return { data: view(sending), status: "ok" }
  }

  #receive(data: Uint8Array) {
    this.#rx = concat(this.#rx, data)
  }
}
