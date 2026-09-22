export const LSAP_IAS = 0x00
export const LSAP_MAX = 0x6f
export const LSAP_CONNECTIONLESS = 0x70

export const WATCHDOG_TIMEOUT = 20_000
export const LINGER_TIMEOUT = 2000

export const Reason = {
  USER_REQUEST: 0x01,
  UNEXPECTED_IRLAP_DISCONNECT: 0x02,
  FAILED_TO_ESTABLISH_IRLAP: 0x03,
  IRLAP_RESET: 0x04,
  LINK_MANAGEMENT_INITIATED: 0x05,
  DISCONNECTED: 0x06,
  NON_RESPONSIVE_CLIENT: 0x07,
  NO_PEER_MUX_CLIENT: 0x08,
  HALF_OPEN: 0x09,
  ILLEGAL_SOURCE_ADDRESS: 0x0a,
  UNSPECIFIED: 0xff,
} as const

export const reasonName = (reason: number) =>
  Object.entries(Reason).find(([, code]) => code === reason)?.[0] ?? `0x${reason.toString(16)}`

export const Hints = {
  PNP: 1 << 0,
  PDA: 1 << 1,
  COMPUTER: 1 << 2,
  PRINTER: 1 << 3,
  MODEM: 1 << 4,
  FAX: 1 << 5,
  LAN: 1 << 6,
  TELEPHONY: 1 << 8,
  FILE_SERVER: 1 << 9,
  OBEX: 1 << 13,
} as const
