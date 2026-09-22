import { chunks, concat, EMPTY, u16, u32, view } from "../bytes.ts"
import { ConnectionClosed } from "../errors.ts"
import { log } from "../log.ts"
import { LSAP_IAS } from "./constants.ts"
import type { IrLMP, LSAPConnection } from "./irlmp.ts"
import { decodeText, encodeText } from "../text.ts"

const GET_VALUE_BY_CLASS = 4
const UNSUPPORTED = 0xff

export type Value = number | Uint8Array | string | null

type Frame = { opcode: number; last: boolean; ack: boolean; data: Uint8Array }

const LAST = 0b10000000
const ACK = 0b01000000

const encodeFrame = ({ opcode, last, ack, data }: Frame) =>
  concat(Uint8Array.of((last ? LAST : 0) | (ack ? ACK : 0) | opcode), data)

const decodeFrame = (data: Uint8Array): Frame => ({
  opcode: data[0] & 0b00111111,
  last: Boolean(data[0] & LAST),
  ack: Boolean(data[0] & ACK),
  data: data.subarray(1),
})

export function encodeValue(value: Value): Uint8Array {
  if (value === null) return Uint8Array.of(0)
  if (typeof value === "number") return concat(Uint8Array.of(1), u32(value))
  if (value instanceof Uint8Array) return concat(Uint8Array.of(2), u16(value.length), value)

  for (const charset of [0x00, 0x01, 0xff]) {
    try {
      const encoded = encodeText(value, charset)
      return concat(Uint8Array.of(3, charset, encoded.length), encoded)
    } catch {
      continue
    }
  }

  throw new RangeError(`Cannot encode ${value}`)
}

export function decodeValue(data: Uint8Array, offset: number): [value: Value, end: number] {
  switch (data[offset]) {
    case 0:
      return [null, offset + 1]

    case 1:
      return [view(data).getInt32(offset + 1), offset + 5]

    case 2: {
      const length = view(data).getUint16(offset + 1)
      return [data.subarray(offset + 3, offset + 3 + length), offset + 3 + length]
    }

    case 3: {
      const [charset, length] = [data[offset + 1], data[offset + 2]]
      const end = offset + 3 + length
      return [decodeText(data.subarray(offset + 3, end), charset), end]
    }

    default:
      throw new RangeError(`Unknown IAS value type ${data[offset]}`)
  }
}

export class IAS {
  readonly irlmp: IrLMP
  readonly objects: Record<string, Record<string, Value>>

  constructor(irlmp: IrLMP, nickname: string) {
    this.irlmp = irlmp
    this.objects = { Device: { DeviceName: nickname, IrLMPSupport: Uint8Array.of(1, 0, 0) } }

    irlmp.listeners.set(LSAP_IAS, (connection) => void this.#serve(connection))
  }

  async getValueByClass(address: number, className: string, attribute: string): Promise<[id: number, value: Value][]> {
    const connection = await this.irlmp.connect(address, LSAP_IAS)
    const writer = connection.writable.getWriter()
    const reader = connection.readable.getReader()

    try {
      const args = concat(octets(className), octets(attribute))
      await writer.write(encodeFrame({ opcode: GET_VALUE_BY_CLASS, last: true, ack: false, data: args }))
      const result = await receive(reader, writer)

      if (result[0] !== 0) return []

      const values: [number, Value][] = []
      let offset = 3

      for (let n = view(result).getUint16(1); n > 0; n--) {
        const [value, end] = decodeValue(result, offset + 2)
        values.push([view(result).getUint16(offset), value])
        offset = end
      }

      return values
    } finally {
      reader.releaseLock()
      await writer.close()
    }
  }

  getValueByClassLocal(className: string, attribute: string): Uint8Array {
    const attributes = this.objects[className]
    if (!attributes) return Uint8Array.of(1)
    if (!(attribute in attributes)) return Uint8Array.of(2)

    const objectId = Object.keys(this.objects).indexOf(className)

    return concat(Uint8Array.of(0), u16(1), u16(objectId), encodeValue(attributes[attribute]))
  }

  async #serve(connection: LSAPConnection) {
    const writer = connection.writable.getWriter()
    let command = EMPTY
    let reply: Uint8Array[] = []

    const sendNext = () => {
      const frame = reply.shift()
      if (frame) void writer.write(frame)
    }

    try {
      for await (const chunk of connection.readable) {
        const frame = decodeFrame(chunk)

        if (frame.ack) {
          sendNext()
          continue
        }

        command = concat(command, frame.data)

        if (!frame.last) {
          void writer.write(encodeFrame({ opcode: frame.opcode, last: false, ack: true, data: EMPTY }))
          continue
        }

        const parts = chunks(this.#execute(frame.opcode, command), connection.dataSize - 1)
        command = EMPTY
        reply = parts.map((data, i) =>
          encodeFrame({ opcode: frame.opcode, last: i === parts.length - 1, ack: false, data }),
        )
        sendNext()
      }
    } catch (error) {
      log.debug("IAS server connection lost", error)
    }
  }

  #execute(opcode: number, command: Uint8Array): Uint8Array {
    if (opcode !== GET_VALUE_BY_CLASS) return Uint8Array.of(UNSUPPORTED)

    const [className, offset] = readOctets(command, 0)
    const [attribute] = readOctets(command, offset)

    return this.getValueByClassLocal(className, attribute)
  }
}

async function receive(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<Uint8Array> {
  let result = EMPTY

  for (;;) {
    const { value, done } = await reader.read()
    if (done) throw new ConnectionClosed()

    const frame = decodeFrame(value)
    if (frame.ack) continue

    result = concat(result, frame.data)
    if (frame.last) return result

    await writer.write(encodeFrame({ opcode: frame.opcode, last: false, ack: true, data: EMPTY }))
  }
}

function octets(text: string): Uint8Array {
  const encoded = encodeText(text, 0x00)

  return concat(Uint8Array.of(encoded.length), encoded)
}

function readOctets(data: Uint8Array, offset: number): [text: string, end: number] {
  const end = offset + 1 + data[offset]

  return [decodeText(data.subarray(offset + 1, end), 0x00), end]
}
