const TABLE = new Uint16Array(256).map((_, i) => {
  let crc = i

  for (let bit = 0; bit < 8; bit++) {
    crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1
  }

  return crc
})

export function crc16(data: Uint8Array): number {
  let crc = 0xffff

  for (const byte of data) {
    crc = (crc >>> 8) ^ TABLE[(crc ^ byte) & 0xff]
  }

  return crc ^ 0xffff
}
