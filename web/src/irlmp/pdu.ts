import { concat } from "../bytes.ts"
import { decodeText, encodeText } from "../text.ts"

export type Body =
  | { kind: "data"; data: Uint8Array }
  | { kind: "connect"; data: Uint8Array }
  | { kind: "connectConfirm"; data: Uint8Array }
  | { kind: "disconnect"; reason: number; data: Uint8Array }
  | { kind: "accessMode"; mode: number }
  | { kind: "accessModeConfirm"; status: number; mode: number }
  | { kind: "control"; opcode: number; confirm: boolean; parameters: Uint8Array }

export type PDU = { dlsap: number; slsap: number } & Body

const CONTROL = 0b10000000
const CONFIRM = 0b10000000

export function encode(pdu: PDU): Uint8Array {
  if (pdu.kind === "data") return concat(Uint8Array.of(pdu.dlsap, pdu.slsap), pdu.data)

  const [opcode, confirm, parameters] = control(pdu)

  return concat(Uint8Array.of(CONTROL | pdu.dlsap, pdu.slsap, (confirm ? CONFIRM : 0) | opcode), parameters)
}

function control(pdu: Exclude<PDU, { kind: "data" }>): [opcode: number, confirm: boolean, parameters: Uint8Array] {
  switch (pdu.kind) {
    case "connect":
      return [1, false, concat(Uint8Array.of(0), pdu.data)]
    case "connectConfirm":
      return [1, true, concat(Uint8Array.of(0), pdu.data)]
    case "disconnect":
      return [2, false, concat(Uint8Array.of(pdu.reason), pdu.data)]
    case "accessMode":
      return [3, false, Uint8Array.of(0, pdu.mode)]
    case "accessModeConfirm":
      return [3, true, Uint8Array.of(pdu.status, pdu.mode)]
    case "control":
      return [pdu.opcode, pdu.confirm, pdu.parameters]
  }
}

export function decode(data: Uint8Array): PDU | undefined {
  if (data.length < 2) return

  const header = { dlsap: data[0] & ~CONTROL, slsap: data[1] & ~CONTROL }

  if (!(data[0] & CONTROL)) return { ...header, kind: "data", data: data.subarray(2) }
  if (data.length < 3) return

  const opcode = data[2] & ~CONFIRM
  const confirm = Boolean(data[2] & CONFIRM)
  const parameters = data.subarray(3)

  switch (opcode) {
    case 1:
      return { ...header, kind: confirm ? "connectConfirm" : "connect", data: parameters.subarray(1) }

    case 2:
      if (confirm || !parameters.length) return
      return { ...header, kind: "disconnect", reason: parameters[0], data: parameters.subarray(1) }

    case 3:
      if (parameters.length < 2) return
      return confirm
        ? { ...header, kind: "accessModeConfirm", status: parameters[0], mode: parameters[1] }
        : { ...header, kind: "accessMode", mode: parameters[1] }

    default:
      return { ...header, kind: "control", opcode, confirm, parameters }
  }
}

export type DeviceInfo = { hints: number; nickname: string }

export function encodeDeviceInfo({ hints, nickname }: DeviceInfo): Uint8Array {
  return concat(
    Uint8Array.of((hints & 0x7f) | 0x80, (hints >> 8) & 0x7f, 0x00),
    encodeText(nickname.slice(0, 20), 0x00),
  )
}

export function decodeDeviceInfo(data: Uint8Array): DeviceInfo {
  let hints = 0
  let i = 0

  while (i < data.length) {
    hints |= (data[i] & 0x7f) << (8 * i)
    i += 1
    if (!(data[i - 1] & 0x80)) break
  }

  return { hints, nickname: i < data.length ? decodeText(data.subarray(i + 1), data[i]) : "" }
}
