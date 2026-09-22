import { concat, EMPTY, u16, u32, view } from "../bytes.ts"
import { decodeText, encodeText } from "../text.ts"
import { FINAL, Header } from "./constants.ts"

export type HeaderValue = string | Uint8Array | number
export type Headers = (readonly [id: number, value: HeaderValue])[]

const UNICODE = 0x00
const BYTES = 0x40
const BYTE = 0x80
const PACKET_OVERHEAD = 3
const UTF_16 = 0xff

export function encodeHeader(id: number, value: HeaderValue): Uint8Array {
  switch (id & 0xc0) {
    case UNICODE: {
      const encoded = value ? concat(encodeText(String(value), UTF_16), Uint8Array.of(0, 0)) : EMPTY
      return concat(Uint8Array.of(id), u16(encoded.length + 3), encoded)
    }
    case BYTES: {
      const encoded = value as Uint8Array
      return concat(Uint8Array.of(id), u16(encoded.length + 3), encoded)
    }
    case BYTE:
      return Uint8Array.of(id, value as number)
    default:
      return concat(Uint8Array.of(id), u32(value as number))
  }
}

export const encodeHeaders = (headers: Headers) => concat(...headers.map(([id, value]) => encodeHeader(id, value)))

export function decodeHeaders(data: Uint8Array): Headers {
  const headers: Headers = []

  for (let i = 0; i < data.length;) {
    const id = data[i]

    switch (id & 0xc0) {
      case UNICODE:
      case BYTES: {
        const length = Math.max(view(data).getUint16(i + 1), 3)
        const raw = data.subarray(i + 3, i + length)
        const text = raw.length >= 2 && !raw[raw.length - 2] && !raw[raw.length - 1] ? raw.subarray(0, -2) : raw
        headers.push([id, (id & 0xc0) === UNICODE ? decodeText(text, UTF_16) : raw])
        i += length
        break
      }
      case BYTE:
        headers.push([id, data[i + 1]])
        i += 2
        break
      default:
        headers.push([id, view(data).getUint32(i + 1)])
        i += 5
    }
  }

  return headers
}

export const header = (headers: Headers, id: number) => headers.find(([hi]) => hi === id)?.[1]

export function body(headers: Headers): Uint8Array | null {
  const chunks = headers
    .filter(([id]) => id === Header.BODY || id === Header.END_OF_BODY)
    .map(([, value]) => value as Uint8Array)

  return chunks.length ? concat(...chunks) : null
}

export type Packet = { opcode: number; code: number; final: boolean; payload: Uint8Array }

export function encodePacket(opcode: number, ...parts: Uint8Array[]): Uint8Array {
  const payload = concat(...parts)

  return concat(Uint8Array.of(opcode), u16(payload.length + PACKET_OVERHEAD), payload)
}

export const decodePacket = (raw: Uint8Array): Packet => ({
  opcode: raw[0],
  code: raw[0] & ~FINAL,
  final: Boolean(raw[0] & FINAL),
  payload: raw.subarray(PACKET_OVERHEAD),
})

export async function* packets(readable: ReadableStream<Uint8Array>): AsyncGenerator<Packet> {
  let buffer = EMPTY

  for await (const chunk of readable) {
    buffer = buffer.length ? concat(buffer, chunk) : chunk

    while (buffer.length >= PACKET_OVERHEAD) {
      const length = Math.max(view(buffer).getUint16(1), PACKET_OVERHEAD)
      if (length > buffer.length) break

      yield decodePacket(buffer.subarray(0, length))
      buffer = buffer.subarray(length)
    }
  }
}
