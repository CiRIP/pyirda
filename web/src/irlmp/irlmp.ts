import { match, P } from "ts-pattern"

import { EMPTY } from "../bytes.ts"
import { Connection } from "../connection.ts"
import { IrdaError } from "../errors.ts"
import type { IrLAP, Link, XIDFrame } from "../irlap/irlap.ts"
import { log } from "../log.ts"
import { Timer } from "../timer.ts"
import {
  Hints,
  LINGER_TIMEOUT,
  LSAP_CONNECTIONLESS,
  LSAP_IAS,
  LSAP_MAX,
  Reason,
  reasonName,
  WATCHDOG_TIMEOUT,
} from "./constants.ts"
import { IAS } from "./ias.ts"
import { decode, decodeDeviceInfo, encode, encodeDeviceInfo, type Body, type PDU } from "./pdu.ts"

const HEADER_SIZE = 2

export type Device = { address: number; hints: number; nickname: string }

export const parseDevice = (xid: XIDFrame): Device => ({
  address: xid.srcDeviceAddress,
  ...decodeDeviceInfo(xid.discoveryInfo),
})

export const formatAddress = (address: number) => `0x${address.toString(16).padStart(8, "0")}`

export type Listener = (connection: LSAPConnection) => void

type State = "DISCONNECTED" | "SETUP_PEND" | "SETUP" | "CONNECT_PEND" | "CONNECT" | "DTR"

type Request =
  | { request: "connect"; data: Uint8Array }
  | { request: "connectResponse"; data: Uint8Array }
  | { request: "disconnect" }
  | { request: "data" }

type Indication = { indication: "connect" } | { indication: "disconnect"; error?: unknown }

type Trigger = PDU | Request | Indication | { timer: "watchdog" }

export class LSAPConnection extends Connection {
  readonly irlmp: IrLMP
  readonly local: number
  readonly remote: number
  readonly address: number
  readonly dataSize: number

  state: State = "DISCONNECTED"
  connectData: Uint8Array = EMPTY

  #listener?: Listener
  #confirmed?: PromiseWithResolvers<LSAPConnection>
  #pending: Uint8Array[] = []
  #watchdog = new Timer(WATCHDOG_TIMEOUT, () => this.dispatch({ timer: "watchdog" }))

  constructor(irlmp: IrLMP, local: number, remote: number, listener?: Listener) {
    super()
    this.irlmp = irlmp
    this.local = local
    this.remote = remote
    this.address = irlmp.link!.address
    this.dataSize = irlmp.link!.dataSize - HEADER_SIZE
    this.#listener = listener
  }

  toString() {
    return `LSAP(${this.local}<->${this.remote}, ${this.state})`
  }

  // --- service interface ---

  connectRequest(data: Uint8Array): Promise<LSAPConnection> {
    this.#confirmed = Promise.withResolvers()
    this.dispatch({ request: "connect", data })

    return this.#confirmed.promise
  }

  accept(data: Uint8Array = EMPTY) {
    this.dispatch({ request: "connectResponse", data })
  }

  protected write(data: Uint8Array) {
    if (data.length > this.dataSize) {
      throw new RangeError(`LM-PDU of ${data.length} bytes exceeds the ${this.dataSize} that fit an I frame`)
    }

    this.#pending.push(data)
    this.dispatch({ request: "data" })
  }

  protected disconnect() {
    this.dispatch({ request: "disconnect" })
  }

  // --- state machine ---

  dispatch(trigger: Trigger) {
    const state = this.state
    log.debug("--->", `${this}`, trigger)

    match<[State, Trigger]>([state, trigger])
      .with(["DISCONNECTED", { request: "connect" }], ([, { data }]) => {
        this.connectData = data

        this.state = "SETUP_PEND"

        this.irlmp.bind(this)
      })

      .with(["DISCONNECTED", { kind: "connect" }], ([, { data }]) => {
        this.connectData = data

        this.state = "CONNECT_PEND"

        this.irlmp.bind(this)
      })

      .with(["SETUP_PEND", { indication: "connect" }], () => {
        this.#send({ kind: "connect", data: this.connectData })
        this.#watchdog.start()

        this.state = "SETUP"
      })

      .with(["CONNECT_PEND", { indication: "connect" }], () => {
        this.state = "CONNECT"

        this.#open()
        queueMicrotask(() => this.dispatch({ request: "connectResponse", data: EMPTY }))
      })

      .with(["SETUP", { kind: "connectConfirm" }], ([, { data }]) => {
        this.#watchdog.stop()
        this.connectData = data

        this.state = "DTR"

        this.#open()
        this.#confirmed?.resolve(this)
        this.#confirmed = undefined
      })

      .with(["SETUP", { kind: "connect" }], () => {
        this.#watchdog.stop()
        this.#closed(new IrdaError("Connection race"))

        this.state = "DISCONNECTED"
      })

      .with(["SETUP", { kind: "disconnect" }], ([, { reason }]) => {
        this.#watchdog.stop()
        this.#closed(new IrdaError(`Connection refused: ${reasonName(reason)}`))

        this.state = "DISCONNECTED"
      })

      .with(["SETUP", { timer: "watchdog" }], () => {
        this.#closed(new IrdaError("Peer did not respond"))

        this.state = "DISCONNECTED"
      })

      .with(["CONNECT", { request: "connectResponse" }], ([, { data }]) => {
        this.#send({ kind: "connectConfirm", data })

        this.state = "DTR"
      })

      .with([P.union("CONNECT", "DTR"), { request: "disconnect" }], () => {
        this.#send({ kind: "disconnect", reason: Reason.USER_REQUEST, data: EMPTY })
        this.#closed()

        this.state = "DISCONNECTED"
      })

      .with(["DTR", { request: "data" }], () => {
        for (const data of this.#pending.splice(0)) {
          this.#send({ kind: "data", data })
        }

        this.state = "DTR"
      })

      .with(["DTR", { kind: "data" }], ([, { data }]) => {
        this.push(data)

        this.state = "DTR"
      })

      .with(["DTR", { kind: "connect" }], () => {
        this.#send({ kind: "disconnect", reason: Reason.HALF_OPEN, data: EMPTY })
        this.#closed(new IrdaError(`Connection reset: ${reasonName(Reason.HALF_OPEN)}`))

        this.state = "DISCONNECTED"
      })

      .with(["DTR", { kind: "disconnect" }], ([, { reason }]) => {
        this.#closed(
          reason === Reason.USER_REQUEST ? undefined : new IrdaError(`Connection reset: ${reasonName(reason)}`),
        )

        this.state = "DISCONNECTED"
      })

      .with([P.not("DISCONNECTED"), { indication: "disconnect" }], ([, { error }]) => {
        this.#watchdog.stop()
        this.#closed(error)

        this.state = "DISCONNECTED"
      })

      .with([P._, { request: P.string }], () => {})

      .otherwise(() => log.debug("Ignoring", trigger, "in", state))

    log.debug("<-->", `${this}`)

    if (this.state === "DTR" && state !== "DTR" && this.#pending.length) {
      this.dispatch({ request: "data" })
    }
  }

  // --- actions ---

  #send(body: Body) {
    this.irlmp.send({ dlsap: this.remote, slsap: this.local, ...body })
  }

  #open() {
    this.#listener?.(this)
  }

  #closed(error?: unknown) {
    this.irlmp.unbind(this)
    this.#pending = []

    this.#confirmed?.reject(error ?? new IrdaError("Connection reset"))
    this.#confirmed = undefined

    this.end(error)
  }
}

export interface Options {
  nickname?: string
  hints?: number
}

export class IrLMP {
  readonly irlap: IrLAP
  readonly listeners = new Map<number, Listener>()
  readonly ias: IAS
  link?: Link

  #writer?: WritableStreamDefaultWriter<Uint8Array>
  #connections = new Map<string, LSAPConnection>()
  #connecting?: Promise<Link>
  #released?: PromiseWithResolvers<void>
  #cache: Device[] = []
  #linger = new Timer(LINGER_TIMEOUT, () => this.#closeLink())

  constructor(irlap: IrLAP, { nickname = "irda", hints = Hints.COMPUTER }: Options = {}) {
    this.irlap = irlap
    this.irlap.listener = (link) => void this.#serve(link)
    this.irlap.discoveryInfo = encodeDeviceInfo({ hints, nickname })
    this.ias = new IAS(this, nickname)
  }

  // --- service interface ---

  async discover(): Promise<Device[]> {
    if (this.#connecting || this.#connections.size) return this.#cache

    await this.#release()
    const devices = new Map((await this.irlap.discover()).map((xid) => [xid.srcDeviceAddress, parseDevice(xid)]))
    this.#cache = [...devices.values()]

    return this.#cache
  }

  async connect(address: number, sel: number | string, data: Uint8Array = EMPTY): Promise<LSAPConnection> {
    await this.#link(address)

    const remote = typeof sel === "string" ? await this.resolve(address, sel) : sel
    const connection = new LSAPConnection(this, this.#freeSel(remote), remote)

    return connection.connectRequest(data)
  }

  async resolve(address: number, service: string, attribute = "IrDA:IrLMP:LsapSel"): Promise<number> {
    const [first] = await this.ias.getValueByClass(address, service, attribute)

    if (typeof first?.[1] !== "number") throw new IrdaError(`No ${service} service on ${formatAddress(address)}`)

    return first[1]
  }

  #freeSel(remote: number): number {
    const used = new Set([...this.#connections.values()].filter((c) => c.remote === remote).map((c) => c.local))

    for (let sel = LSAP_IAS + 1; sel <= LSAP_MAX; sel++) {
      if (!used.has(sel) && !this.listeners.has(sel)) return sel
    }

    throw new IrdaError("No free LSAP selector")
  }

  // --- IrLAP connection control ---

  async #link(address: number): Promise<Link> {
    if (this.link?.address === address) return this.link

    this.#connecting ??= this.#release().then(() => this.irlap.connect(address))

    try {
      return await this.#connecting
    } finally {
      this.#connecting = undefined
    }
  }

  async #release() {
    if (!this.link || this.#connections.size) return

    if (!this.#released) {
      this.#released = Promise.withResolvers()
      this.#closeLink()
    }

    await this.#released.promise
  }

  #closeLink() {
    void this.#writer?.close()
    this.#writer = undefined
  }

  bind(connection: LSAPConnection) {
    this.#connections.set(key(connection.local, connection.remote), connection)
    this.#linger.stop()

    connection.dispatch({ indication: "connect" })
  }

  unbind(connection: LSAPConnection) {
    this.#connections.delete(key(connection.local, connection.remote))

    if (!this.#connections.size && this.link) this.#linger.start()
  }

  // --- IrLAP side ---

  async #serve(link: Link) {
    this.link = link
    this.#writer = link.writable.getWriter()
    let error: unknown

    try {
      for await (const data of link.readable) this.#demux(data)
    } catch (caught) {
      error = caught
    }

    this.link = undefined
    this.#writer = undefined
    this.#linger.stop()

    for (const connection of [...this.#connections.values()]) {
      connection.dispatch({
        indication: "disconnect",
        error: error ?? new IrdaError(`Connection reset: ${reasonName(Reason.UNEXPECTED_IRLAP_DISCONNECT)}`),
      })
    }

    this.#released?.resolve()
    this.#released = undefined
  }

  #demux(data: Uint8Array) {
    const pdu = decode(data)
    if (!pdu) return

    match(pdu)
      .with({ dlsap: P.number.gte(LSAP_CONNECTIONLESS) }, { slsap: P.number.gte(LSAP_CONNECTIONLESS) }, () => {})

      .with({ kind: "accessMode" }, () => {
        this.send({ dlsap: pdu.slsap, slsap: pdu.dlsap, kind: "accessModeConfirm", status: 0xff, mode: 0 })
      })

      .when(
        () => this.#connections.has(key(pdu.dlsap, pdu.slsap)),
        () => this.#connections.get(key(pdu.dlsap, pdu.slsap))!.dispatch(pdu),
      )

      .with({ kind: "connect" }, () => {
        const listener = this.listeners.get(pdu.dlsap)

        if (listener) new LSAPConnection(this, pdu.dlsap, pdu.slsap, listener).dispatch(pdu)
        else
          this.send({
            dlsap: pdu.slsap,
            slsap: pdu.dlsap,
            kind: "disconnect",
            reason: Reason.NO_PEER_MUX_CLIENT,
            data: EMPTY,
          })
      })

      .with({ kind: P.union("data", "connectConfirm") }, () => {
        this.send({ dlsap: pdu.slsap, slsap: pdu.dlsap, kind: "disconnect", reason: Reason.DISCONNECTED, data: EMPTY })
      })

      .otherwise(() => log.debug("Ignoring", pdu))
  }

  send(pdu: PDU) {
    void this.#writer?.write(encode(pdu))
  }
}

const key = (local: number, remote: number) => `${local}:${remote}`
