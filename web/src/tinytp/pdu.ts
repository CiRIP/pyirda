import { concat, view } from "../bytes.ts"

const PI_MAX_SDU_SIZE = 0x01
const PARAMETERS = 0b10000000
const MORE = 0b10000000

export const UNBOUNDED = 0xffffffff
export const INITIAL_CREDIT = 14
export const LOW_THRESHOLD = 7
export const MAX_CREDIT = 127

export type DataPDU = { deltaCredit: number; more: boolean; data: Uint8Array }

export const encodeData = ({ deltaCredit, more, data }: DataPDU) =>
  concat(Uint8Array.of((more ? MORE : 0) | deltaCredit), data)

export const decodeData = (raw: Uint8Array): DataPDU => ({
  deltaCredit: raw[0] & ~MORE,
  more: Boolean(raw[0] & MORE),
  data: raw.subarray(1),
})

export type ConnectPDU = { initialCredit: number; maxSduSize: number; data: Uint8Array }

export function encodeConnect({ initialCredit, maxSduSize, data }: ConnectPDU): Uint8Array {
  if (!maxSduSize) return concat(Uint8Array.of(initialCredit), data)

  const value = new Uint8Array(4)
  view(value).setUint32(0, maxSduSize)
  const encoded = value.subarray(
    Math.min(
      3,
      value.findIndex((byte) => byte !== 0),
    ),
  )

  return concat(
    Uint8Array.of(PARAMETERS | initialCredit, encoded.length + 2, PI_MAX_SDU_SIZE, encoded.length),
    encoded,
    data,
  )
}

export function decodeConnect(raw: Uint8Array): ConnectPDU {
  const initialCredit = raw[0] & ~PARAMETERS
  if (!(raw[0] & PARAMETERS)) return { initialCredit, maxSduSize: 0, data: raw.subarray(1) }

  const end = 2 + raw[1]
  let maxSduSize = 0

  for (let i = 2; i + 2 <= end; i += 2 + raw[i + 1]) {
    const [pi, pl] = [raw[i], raw[i + 1]]
    if (pi === PI_MAX_SDU_SIZE)
      maxSduSize = raw.subarray(i + 2, i + 2 + pl).reduce((value, byte) => value * 256 + byte, 0)
  }

  return { initialCredit, maxSduSize, data: raw.subarray(end) }
}
