import { concat, u32, view } from "../bytes.ts"
import { BROADCAST } from "./constants.ts"
import { Parameters } from "./negotiation.ts"

type Base = { address: number; command: boolean; pf: boolean }

export type IFrame = Base & { format: "I"; kind: "I"; ns: number; nr: number; information: Uint8Array }

export type SFrame = Base & { format: "S"; kind: "RR" | "RNR" | "REJ" | "SREJ"; nr: number }

export type UFrame = Base & { format: "U" } & (
    | {
        kind: "SNRM"
        srcDeviceAddress: number
        dstDeviceAddress: number
        connectionAddress: number
        parameters: Parameters
      }
    | { kind: "UA"; srcDeviceAddress?: number; dstDeviceAddress?: number; parameters?: Parameters }
    | { kind: "DISC" }
    | { kind: "RD" }
    | { kind: "RNRM" }
    | { kind: "DM" }
    | { kind: "UI"; information: Uint8Array }
    | { kind: "TEST"; srcDeviceAddress?: number; dstDeviceAddress?: number; data: Uint8Array }
    | {
        kind: "XID"
        srcDeviceAddress: number
        dstDeviceAddress: number
        generateNewAddress: boolean
        slotCount: number
        slotNumber: number
        version: number
        discoveryInfo: Uint8Array
      }
    | {
        kind: "FRMR"
        rejectedControl: number
        ns: number
        cr: boolean
        nr: number
        w: boolean
        x: boolean
        y: boolean
        z: boolean
      }
  )

export type Frame = IFrame | SFrame | UFrame

type Fields<K extends UFrame["kind"]> = Omit<Extract<UFrame, { kind: K }>, keyof Base | "format" | "kind">

export const RR = (address: number, command: boolean, nr: number): SFrame => ({
  format: "S",
  kind: "RR",
  address,
  command,
  pf: true,
  nr,
})

export const U = <K extends UFrame["kind"]>(kind: K, address: number, command: boolean, fields?: Fields<K>): UFrame =>
  ({ format: "U", kind, address, command, pf: true, ...fields }) as UFrame

const PF = 0b00010000
const S_KINDS = ["RR", "RNR", "REJ", "SREJ"] as const
const SLOT_COUNTS = [1, 6, 8, 16]

export function encode(frame: Frame): Uint8Array {
  const address = (frame.address << 1) | (frame.command ? 1 : 0)
  const pf = frame.pf ? PF : 0

  switch (frame.format) {
    case "I":
      return concat(Uint8Array.of(address, (frame.nr << 5) | pf | (frame.ns << 1)), frame.information)

    case "S":
      return Uint8Array.of(address, (frame.nr << 5) | pf | (S_KINDS.indexOf(frame.kind) << 2) | 0b01)

    case "U":
      return concat(Uint8Array.of(address, unnumberedControl(frame) | pf), unnumberedInformation(frame))
  }
}

function unnumberedControl(frame: UFrame): number {
  switch (frame.kind) {
    case "SNRM":
    case "RNRM":
      return 0b10000011
    case "DISC":
    case "RD":
      return 0b01000011
    case "UI":
      return 0b00000011
    case "TEST":
      return 0b11100011
    case "UA":
      return 0b01100011
    case "FRMR":
      return 0b10000111
    case "DM":
      return 0b00001111
    case "XID":
      return frame.command ? 0b00101111 : 0b10101111
  }
}

function unnumberedInformation(frame: UFrame): Uint8Array {
  switch (frame.kind) {
    case "SNRM":
      return concat(
        u32(frame.srcDeviceAddress, true),
        u32(frame.dstDeviceAddress, true),
        Uint8Array.of(frame.connectionAddress << 1),
        frame.parameters.build(),
      )

    case "UA":
      return frame.parameters
        ? concat(u32(frame.srcDeviceAddress!, true), u32(frame.dstDeviceAddress!, true), frame.parameters.build())
        : new Uint8Array(0)

    case "UI":
      return frame.information

    case "TEST":
      return frame.address === BROADCAST
        ? concat(u32(frame.srcDeviceAddress!, true), u32(frame.dstDeviceAddress!, true), frame.data)
        : frame.data

    case "XID":
      return concat(
        Uint8Array.of(0x01),
        u32(frame.srcDeviceAddress, true),
        u32(frame.dstDeviceAddress, true),
        Uint8Array.of(
          SLOT_COUNTS.indexOf(frame.slotCount) | (frame.generateNewAddress ? 0b100 : 0),
          frame.slotNumber,
          frame.version,
        ),
        frame.discoveryInfo,
      )

    case "FRMR":
      return Uint8Array.of(
        frame.rejectedControl,
        (frame.nr << 5) | (frame.cr ? 0b00010000 : 0) | (frame.ns << 1),
        (frame.w ? 1 : 0) | (frame.x ? 2 : 0) | (frame.y ? 4 : 0) | (frame.z ? 8 : 0),
      )

    default:
      return new Uint8Array(0)
  }
}

export function decode(payload: Uint8Array): Frame | undefined {
  if (payload.length < 2) return

  const control = payload[1]
  const base = { address: payload[0] >> 1, command: Boolean(payload[0] & 1), pf: Boolean(control & PF) }
  const info = payload.subarray(2)

  if (!(control & 0b01)) {
    return { ...base, format: "I", kind: "I", ns: (control >> 1) & 0b111, nr: control >> 5, information: info }
  }

  if ((control & 0b11) === 0b01) {
    return { ...base, format: "S", kind: S_KINDS[(control >> 2) & 0b11], nr: control >> 5 }
  }

  const u = { ...base, format: "U" as const }
  const dv = view(info)

  switch (control & ~PF) {
    case 0b10000011:
      if (!u.command) return { ...u, kind: "RNRM" }
      if (info.length < 9) return
      return {
        ...u,
        kind: "SNRM",
        srcDeviceAddress: dv.getUint32(0, true),
        dstDeviceAddress: dv.getUint32(4, true),
        connectionAddress: info[8] >> 1,
        parameters: Parameters.parse(info.subarray(9)),
      }

    case 0b01000011:
      if (!u.command) return { ...u, kind: "RD" }
      return info.length ? undefined : { ...u, kind: "DISC" }

    case 0b00000011:
      return { ...u, kind: "UI", information: info }

    case 0b11100011:
      if (u.address !== BROADCAST) return { ...u, kind: "TEST", data: info }
      if (info.length < 8) return
      return {
        ...u,
        kind: "TEST",
        srcDeviceAddress: dv.getUint32(0, true),
        dstDeviceAddress: dv.getUint32(4, true),
        data: info.subarray(8),
      }

    case 0b01100011:
      if (u.command) return
      if (info.length < 8) return { ...u, kind: "UA" }
      return {
        ...u,
        kind: "UA",
        srcDeviceAddress: dv.getUint32(0, true),
        dstDeviceAddress: dv.getUint32(4, true),
        parameters: Parameters.parse(info.subarray(8)),
      }

    case 0b10000111:
      if (u.command || info.length !== 3) return
      return {
        ...u,
        kind: "FRMR",
        rejectedControl: info[0],
        ns: (info[1] >> 1) & 0b111,
        cr: Boolean(info[1] & 0b00010000),
        nr: info[1] >> 5,
        w: Boolean(info[2] & 1),
        x: Boolean(info[2] & 2),
        y: Boolean(info[2] & 4),
        z: Boolean(info[2] & 8),
      }

    case 0b00001111:
      return u.command ? undefined : { ...u, kind: "DM" }

    case 0b00101111:
    case 0b10101111:
      if (u.command !== ((control & ~PF) === 0b00101111)) return
      if (u.address !== BROADCAST || info.length < 12 || info[0] !== 0x01) return
      return {
        ...u,
        kind: "XID",
        srcDeviceAddress: dv.getUint32(1, true),
        dstDeviceAddress: dv.getUint32(5, true),
        generateNewAddress: Boolean(info[9] & 0b100),
        slotCount: SLOT_COUNTS[info[9] & 0b11],
        slotNumber: info[10],
        version: info[11],
        discoveryInfo: info.subarray(12),
      }
  }

  return
}
