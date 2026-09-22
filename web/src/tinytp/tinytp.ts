import { chunks, concat, EMPTY } from "../bytes.ts"
import { Connection } from "../connection.ts"
import { ConnectionClosed } from "../errors.ts"
import type { IrLMP, LSAPConnection, Listener as LSAPListener } from "../irlmp/irlmp.ts"
import { log } from "../log.ts"
import {
  decodeConnect,
  decodeData,
  encodeConnect,
  encodeData,
  INITIAL_CREDIT,
  LOW_THRESHOLD,
  MAX_CREDIT,
  UNBOUNDED,
  type DataPDU,
} from "./pdu.ts"

const HEADER_SIZE = 1

export type Listener = (connection: TTPConnection) => void

const offer = (maxSduSize: number, data = EMPTY) => encodeConnect({ initialCredit: INITIAL_CREDIT, maxSduSize, data })

export class TTPConnection extends Connection {
  readonly lsap: LSAPConnection
  readonly address: number
  readonly dataSize: number
  readonly maxSduSize: number
  readonly rxMaxSduSize: number
  readonly connectData: Uint8Array

  sendCredit: number
  remoteCredit = INITIAL_CREDIT
  availCredit = 0

  #writer: WritableStreamDefaultWriter<Uint8Array>
  #waiting?: PromiseWithResolvers<void>
  #rxSdu = EMPTY
  #closing = false

  constructor(lsap: LSAPConnection, maxSduSize = 0) {
    super()
    const peer = decodeConnect(lsap.connectData)

    this.lsap = lsap
    this.address = lsap.address
    this.dataSize = lsap.dataSize - HEADER_SIZE
    this.maxSduSize = peer.maxSduSize
    this.rxMaxSduSize = maxSduSize
    this.connectData = peer.data
    this.sendCredit = peer.initialCredit

    this.#writer = lsap.writable.getWriter()
    void this.#receive()
  }

  // --- service interface ---

  protected async write(sdu: Uint8Array) {
    const limit = this.maxSduSize || this.dataSize

    if (!sdu.length || sdu.length > limit) {
      throw new RangeError(`SDU of ${sdu.length} bytes must be 1 to ${limit} bytes`)
    }

    const segments = this.maxSduSize ? chunks(sdu, this.dataSize) : [sdu]

    for (const [i, data] of segments.entries()) {
      await this.#credit()
      this.#send({ deltaCredit: this.#advanceCredit(), more: i < segments.length - 1, data })
    }
  }

  protected disconnect() {
    if (this.#closing) return

    this.#closing = true
    void this.#writer.close()
  }

  // --- LSAP side ---

  async #receive() {
    let error: unknown

    try {
      for await (const chunk of this.lsap.readable) this.#dataReceived(chunk)
    } catch (caught) {
      error = caught
    }

    this.#closing = true
    this.#waiting?.reject(error ?? new ConnectionClosed())
    this.end(error)
  }

  #dataReceived(chunk: Uint8Array) {
    const pdu = decodeData(chunk)
    log.debug("--->", pdu)
    this.sendCredit += pdu.deltaCredit

    if (pdu.data.length) {
      this.remoteCredit -= 1
      this.availCredit += 1
      this.#reassemble(pdu)
    }

    this.#service()
  }

  // --- actions ---

  #reassemble(pdu: DataPDU) {
    this.#rxSdu = this.#rxSdu.length ? concat(this.#rxSdu, pdu.data) : pdu.data

    if (pdu.more && this.rxMaxSduSize) return

    let sdu = this.#rxSdu
    this.#rxSdu = EMPTY

    if (this.rxMaxSduSize && this.rxMaxSduSize !== UNBOUNDED && sdu.length > this.rxMaxSduSize) {
      console.warn(`Truncating ${sdu.length} byte SDU to ${this.rxMaxSduSize}`)
      sdu = sdu.subarray(0, this.rxMaxSduSize)
    }

    this.push(sdu)
  }

  async #credit() {
    while (!this.sendCredit) {
      this.#waiting = Promise.withResolvers()
      await this.#waiting.promise
    }

    this.sendCredit -= 1
  }

  #service() {
    const sending = this.#waiting !== undefined && this.sendCredit > 0

    if (sending) {
      this.#waiting!.resolve()
      this.#waiting = undefined
    }

    if (!sending && this.remoteCredit <= LOW_THRESHOLD && this.availCredit) {
      this.#send({ deltaCredit: this.#advanceCredit(), more: false, data: EMPTY })
    }
  }

  #advanceCredit(): number {
    const credit = Math.min(this.availCredit, MAX_CREDIT)
    this.availCredit -= credit
    this.remoteCredit += credit

    return credit
  }

  #send(pdu: DataPDU) {
    if (this.#closing) return

    log.debug("<---", pdu)
    void this.#writer.write(encodeData(pdu))
  }
}

export class TinyTP {
  readonly irlmp: IrLMP

  constructor(irlmp: IrLMP) {
    this.irlmp = irlmp
  }

  async connect(
    address: number,
    sel: number | string,
    { maxSduSize = 0, data = EMPTY }: { maxSduSize?: number; data?: Uint8Array } = {},
  ): Promise<TTPConnection> {
    const remote = typeof sel === "string" ? await this.irlmp.resolve(address, sel, "IrDA:TinyTP:LsapSel") : sel
    const lsap = await this.irlmp.connect(address, remote, offer(maxSduSize, data))

    return new TTPConnection(lsap, maxSduSize)
  }

  server(listener: Listener, maxSduSize = 0): LSAPListener {
    return (lsap) => {
      const connection = new TTPConnection(lsap, maxSduSize)
      lsap.accept(offer(maxSduSize))
      listener(connection)
    }
  }
}
