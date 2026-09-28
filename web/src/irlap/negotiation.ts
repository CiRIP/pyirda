import { IrdaError } from "../errors.ts"

const PI_BAUD_RATE = 0x01
const PI_MAX_TURN_AROUND = 0x82
const PI_DATA_SIZE = 0x83
const PI_WINDOW_SIZE = 0x84
const PI_ADDITIONAL_BOFS = 0x85
const PI_MIN_TURN_AROUND = 0x86
const PI_LINK_DISCONNECT = 0x08

const BAUD_RATES = [2400, 9600, 19200, 38400, 57600, 115200, 576000, 1152000]
const MAX_TURN_AROUND_MS = [500, 250, 100, 50]
const DATA_SIZES = [64, 128, 256, 512, 1024, 2048]
const WINDOW_SIZES = [1, 2, 3, 4, 5, 6, 7]
const LINK_DISCONNECT_SECS = [3, 8, 12, 16, 20, 25, 30, 40]
const MIN_TURN_AROUND_MS = [10, 5, 1, 0.5, 0.1, 0.05, 0.01, 0]
const ADDITIONAL_BOFS_AT_115200 = [48, 24, 12, 6, 3, 2, 1, 0]

export class NegotiationError extends IrdaError {}

export class Parameters {
  readonly baudRatePv: number = 0b00000010
  readonly maxTurnAroundPv: number = 0b00000001
  readonly dataSizePv: number = 0b00000111
  readonly windowSizePv: number = 0b01111111
  readonly additionalBofsPv: number = 0b11111111
  readonly minTurnAroundPv: number = 0b11111111
  readonly linkDisconnectPv: number = 0b11111111

  constructor(pv: Partial<Record<Field, number>> = {}) {
    Object.assign(this, pv)
  }

  static parse(data: Uint8Array): Parameters {
    const pv: Partial<Record<Field, number>> = {}

    for (let i = 0; i + 2 <= data.length;) {
      const [pi, pl] = [data[i], data[i + 1]]
      const field = FIELDS[pi]
      if (pl && i + 2 + pl <= data.length && field) pv[field] = data[i + 2]
      i += 2 + pl
    }

    return new Parameters(pv)
  }

  build(): Uint8Array {
    return Uint8Array.from(Object.entries(FIELDS).flatMap(([pi, field]) => [Number(pi), 1, this[field]]))
  }

  negotiate(remote: Parameters): [ours: Parameters, theirs: Parameters] {
    const type0 = {
      baudRatePv: pickType0(this.baudRatePv, remote.baudRatePv),
      linkDisconnectPv: pickType0(this.linkDisconnectPv, remote.linkDisconnectPv),
    }

    const type1 = (side: Parameters) => ({
      maxTurnAroundPv: pickType1(side.maxTurnAroundPv),
      dataSizePv: pickType1(side.dataSizePv),
      windowSizePv: pickType1(side.windowSizePv),
      additionalBofsPv: pickType1(side.additionalBofsPv),
      minTurnAroundPv: pickType1(side.minTurnAroundPv),
    })

    return [new Parameters({ ...type0, ...type1(this) }), new Parameters({ ...type0, ...type1(remote) })]
  }

  get baudRate() {
    return lookup(this.baudRatePv, BAUD_RATES)
  }

  get maxTurnAroundMs() {
    return lookup(this.maxTurnAroundPv, MAX_TURN_AROUND_MS)
  }

  get dataSize() {
    return lookup(this.dataSizePv, DATA_SIZES)
  }

  get windowSize() {
    return lookup(this.windowSizePv, WINDOW_SIZES)
  }

  get linkDisconnectSecs() {
    return lookup(this.linkDisconnectPv, LINK_DISCONNECT_SECS)
  }

  get minTurnAroundMs() {
    return lookup(this.minTurnAroundPv, MIN_TURN_AROUND_MS)
  }

  get additionalBofsAt115200() {
    return lookup(this.additionalBofsPv, ADDITIONAL_BOFS_AT_115200)
  }
}

type Field = keyof Parameters & `${string}Pv`

const FIELDS: Record<number, Field> = {
  [PI_BAUD_RATE]: "baudRatePv",
  [PI_MAX_TURN_AROUND]: "maxTurnAroundPv",
  [PI_DATA_SIZE]: "dataSizePv",
  [PI_WINDOW_SIZE]: "windowSizePv",
  [PI_ADDITIONAL_BOFS]: "additionalBofsPv",
  [PI_MIN_TURN_AROUND]: "minTurnAroundPv",
  [PI_LINK_DISCONNECT]: "linkDisconnectPv",
}

export const baudRatePv = (rates: number[]) =>
  BAUD_RATES.reduce((pv, rate, bit) => (rates.includes(rate) ? pv | (1 << bit) : pv), 0)

export const CAPABILITIES = new Parameters()

export const CONTENTION = new Parameters({
  baudRatePv: 0b00000010,
  maxTurnAroundPv: 0b00000001,
  dataSizePv: 0b00000001,
  windowSizePv: 0b00000001,
  additionalBofsPv: 0b10000000,
  minTurnAroundPv: 0b00000001,
  linkDisconnectPv: 0b10000000,
})

function lookup(pv: number, table: number[]): number {
  for (let bit = 7; bit >= 0; bit--) {
    if (pv & (1 << bit) && bit < table.length) return table[bit]
  }

  throw new NegotiationError(`No value for PV ${pv.toString(2)}`)
}

function pickType0(ours: number, theirs: number): number {
  const agreed = ours & theirs
  if (!agreed) throw new NegotiationError(`No common capabilities: ${ours.toString(2)} vs ${theirs.toString(2)}`)

  return 1 << (31 - Math.clz32(agreed))
}

function pickType1(ours: number): number {
  if (!ours) throw new NegotiationError("No capabilities set for type 1 parameter")

  return 1 << (31 - Math.clz32(ours))
}
