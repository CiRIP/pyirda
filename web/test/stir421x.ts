import { concat, view } from "../src/bytes.ts"

const REQ_GET_CLASS_DESCRIPTOR = 0x06
const REQ_PREPARE_PATCH = 0x02
const PACKET_SIZE = 64

const SPEEDS = [2400, 9600, 19200, 38400, 57600, 115200, 576000, 1152000, 4000000]
const XBOFS = [48, 24, 12, 6, 3, 2, 1, 0]
const CLASS_DESCRIPTOR = Uint8Array.of(12, 0x21, 0x00, 0x01, 0x3f, 0x01, 0x07, 0x3f, 0x00, 0x80, 0x00, 0x00)

export class FakeSTIR421X implements Partial<USBDevice> {
  deviceVersionMajor = 0x10
  deviceVersionMinor = 0x0
  deviceVersionSubminor = 0x1
  configuration = {
    interfaces: [
      {
        interfaceNumber: 0,
        alternate: {
          endpoints: [
            { endpointNumber: 3, direction: "in", type: "interrupt", packetSize: 8 },
            { endpointNumber: 1, direction: "in", type: "bulk", packetSize: PACKET_SIZE },
            { endpointNumber: 2, direction: "out", type: "bulk", packetSize: PACKET_SIZE },
          ],
        },
      },
    ],
  } as USBConfiguration
  peer!: FakeSTIR421X
  baudRate = 0
  xbofs = 0
  turnaround = 0
  patch?: Uint8Array[]
  sent: Uint8Array[] = []

  #patched = false
  #received: Uint8Array[] = []
  #reading?: PromiseWithResolvers<Uint8Array>

  static pair(): [FakeSTIR421X, FakeSTIR421X] {
    const a = new FakeSTIR421X()
    const b = new FakeSTIR421X()
    a.peer = b
    b.peer = a

    return [a, b]
  }

  async open() {}

  async close() {
    this.#reading?.reject(new Error("device closed"))
  }

  async claimInterface() {}

  async controlTransferOut(setup: USBControlTransferParameters): Promise<USBOutTransferResult> {
    if (setup.requestType !== "vendor" || setup.request !== REQ_PREPARE_PATCH) throw new Error("unexpected request")

    this.patch = []
    return { bytesWritten: 0, status: "ok" }
  }

  async controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult> {
    if (setup.recipient !== "interface" || setup.request !== REQ_GET_CLASS_DESCRIPTOR)
      throw new Error("unexpected request")

    this.#patched = Boolean(this.patch?.length)
    return { data: view(CLASS_DESCRIPTOR.slice(0, length)), status: "ok" }
  }

  async transferOut(endpoint: number, source: BufferSource): Promise<USBOutTransferResult> {
    const data = (source as Uint8Array).slice()

    if (endpoint !== 2) throw new Error(`unexpected endpoint ${endpoint}`)
    if (!this.#patched) {
      this.patch!.push(data)
      return { bytesWritten: data.length, status: "ok" }
    }

    this.sent.push(data)
    if (data.length) this.#transmit(data)

    return { bytesWritten: data.length, status: "ok" }
  }

  async transferIn(endpoint: number, length: number): Promise<USBInTransferResult> {
    if (endpoint !== 1) throw new Error(`unexpected endpoint ${endpoint}`)
    if (length % PACKET_SIZE) throw new Error(`unaligned read of ${length} bytes`)

    const frame = this.#received.shift() ?? (await (this.#reading = Promise.withResolvers()).promise)
    return { data: view(concat(new Uint8Array(3), frame)), status: "ok" }
  }

  #transmit([settings, extra, turnaround, ...rest]: Uint8Array) {
    if (settings & 0x0f) this.baudRate = SPEEDS[(settings & 0x0f) - 1]
    if (settings & 0xf0) this.xbofs = XBOFS[(settings >> 4) - 1]
    this.turnaround = turnaround

    const frame = Uint8Array.from(extra ? rest.slice(0, -1) : rest)
    if (frame.length && this.peer.baudRate === this.baudRate) this.peer.#deliver(frame)
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
