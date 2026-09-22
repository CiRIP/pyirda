export function encodeText(text: string, charset: number): Uint8Array {
  const codes = Array.from(text, (c) => c.charCodeAt(0))
  if (charset === 0xff) return Uint8Array.from(codes.flatMap((code) => [code >> 8, code & 0xff]))

  const limit = charset === 0x00 ? 0x80 : 0x100
  if (codes.some((code) => code >= limit)) throw new RangeError(`${text} does not fit charset ${charset}`)

  return Uint8Array.from(codes)
}

export function decodeText(data: Uint8Array, charset: number): string {
  const label = charset === 0xff ? "utf-16be" : charset === 0x00 ? "ascii" : `iso-8859-${charset}`

  try {
    return new TextDecoder(label).decode(data)
  } catch {
    return new TextDecoder("latin1").decode(data)
  }
}
