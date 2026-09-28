export interface Transmission {
  readonly frame: Uint8Array
  readonly xbofs: number
  readonly turnaround: number
}

interface Transceiver<T> {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<T>
  readonly baudRates: number[]
  setSpeed(baudRate: number): Promise<void>
  close(): Promise<void>
}

export type Dongle = Transceiver<Transmission>

export type SirPort = Transceiver<Uint8Array>
