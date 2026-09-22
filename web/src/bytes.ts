export const EMPTY: Uint8Array = new Uint8Array(0)

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0

  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }

  return out
}

export const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength)

export const hex = (data: Uint8Array) => Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("")

export const ascii = (text: string) => new TextEncoder().encode(text)

export const equals = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i])

export function chunks(data: Uint8Array, size: number): Uint8Array[] {
  const out = []

  for (let offset = 0; offset < data.length; offset += size) {
    out.push(data.subarray(offset, offset + size))
  }

  return out
}

export function u16(value: number, littleEndian = false): Uint8Array {
  const out = new Uint8Array(2)
  view(out).setUint16(0, value, littleEndian)

  return out
}

export function u32(value: number, littleEndian = false): Uint8Array {
  const out = new Uint8Array(4)
  view(out).setUint32(0, value, littleEndian)

  return out
}
