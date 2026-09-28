import { ascii, concat, EMPTY, view } from "../src/bytes.ts"

const KEY = ascii("wangshuofei19710")
const FILLER = 0x95

export class FakeKS959 implements Partial<USBDevice> {
  configuration = { interfaces: [{ interfaceNumber: 0 }] } as USBConfiguration
  peer!: FakeKS959
  baudRate = 0
  claimed = false

  #rx = EMPTY
  #mask = 0

  static pair(): [FakeKS959, FakeKS959] {
    const a = new FakeKS959()
    const b = new FakeKS959()
    a.peer = b
    b.peer = a

    return [a, b]
  }

  async open() {}

  async close() {}

  async claimInterface(interfaceNumber: number) {
    this.claimed = interfaceNumber === 0
  }

  async controlTransferOut(setup: USBControlTransferParameters, source?: BufferSource): Promise<USBOutTransferResult> {
    const data = source as Uint8Array

    if (setup.index === 0x0001) this.baudRate = view(data).getUint32(0, true)
    else this.peer.#receive(unobfuscate(data, setup.value))

    return { bytesWritten: data.length, status: "ok" }
  }

  async controlTransferIn(_setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult> {
    const sending = this.#rx.subarray(0, length)
    this.#rx = this.#rx.subarray(sending.length)

    return { data: new DataView(this.#obfuscate(sending).buffer), status: "ok" }
  }

  #receive(data: Uint8Array) {
    this.#rx = concat(this.#rx, data)
  }

  #obfuscate(data: Uint8Array): Uint8Array<ArrayBuffer> {
    const out: number[] = []

    for (const byte of data) {
      this.#mask = (this.#mask + 1) & 0xff
      if (!this.#mask) {
        out.push(FILLER ^ 0x55)
        this.#mask = 1
      }

      out.push(byte ^ this.#mask ^ 0x55)
    }

    return Uint8Array.from(out)
  }
}

function unobfuscate(data: Uint8Array, length: number): Uint8Array {
  const mask = KEY[(length & 0x0f) ^ 0x06] ^ 0x55

  return data.subarray(0, length).map((byte) => byte ^ mask)
}
