import { match, P } from "ts-pattern"

import { EMPTY, hex } from "../bytes.ts"
import { Connection } from "../connection.ts"
import type { Dongle, Transmission } from "../dongle/dongle.ts"
import { IrdaError } from "../errors.ts"
import { log } from "../log.ts"
import { Timer } from "../timer.ts"
import {
  BROADCAST,
  CONTENTION_XBOFS,
  F_TIMEOUT,
  FRAME_OVERHEAD,
  INITIAL_BAUD_RATE,
  P_TIMEOUT,
  QUERY_TIMEOUT,
  RETRY_COUNT,
  SLOT_TIMEOUT,
  WD_TIMEOUT,
  XID_BROADCAST,
} from "./constants.ts"
import { decode, encode, RR, U, type Frame, type IFrame, type UFrame } from "./frame.ts"
import { baudRatePv, CONTENTION, NegotiationError, Parameters } from "./negotiation.ts"

export type XIDFrame = Extract<UFrame, { kind: "XID" }>
type SNRMFrame = Extract<UFrame, { kind: "SNRM" }>

type Primary = "P.XMIT" | "P.RECV" | "P.CLOSE_WAIT" | "P.CLOSE"
type Secondary = "S.XMIT" | "S.RECV" | "S.ERROR" | "S.CLOSE"
export type State = "NDM" | "QUERY" | "REPLY" | "CONN" | "SETUP" | Primary | Secondary

const primary = (state: State) => state.startsWith("P.")
const secondary = (state: State) => state.startsWith("S.")

type Request =
  | { request: "discovery" }
  | { request: "connect"; address: number }
  | { request: "connectResponse" }
  | { request: "disconnect" }
  | { request: "data" }

type Expiry = { timer: "slot" | "query" | "P" | "F" | "WD" }

type Trigger = Frame | Request | Expiry

export interface Options {
  listener?: (link: Link) => void
  discoveryInfo?: Uint8Array
  slots?: number
  capabilities?: Parameters
}

export class Link extends Connection {
  readonly address: number
  readonly dataSize: number
  #irlap: IrLAP

  constructor(irlap: IrLAP) {
    super()
    this.#irlap = irlap
    this.address = irlap.dstDeviceAddress!
    this.dataSize = irlap.theirs.dataSize
  }

  protected write(data: Uint8Array) {
    if (this.#irlap.link !== this) {
      log.debug("Dropping", data.length, "bytes written to a closed link")
      return
    }

    if (data.length > this.dataSize) {
      throw new RangeError(`Frame of ${data.length} bytes exceeds the negotiated ${this.dataSize}`)
    }

    this.#irlap.dataRequest(data)
  }

  protected disconnect() {
    if (this.#irlap.link === this) this.#irlap.disconnectRequest()
  }
}

export class IrLAP {
  readonly dongle: Dongle
  listener?: (link: Link) => void
  discoveryInfo: Uint8Array
  capabilities: Parameters

  state: State = "NDM"
  readonly srcDeviceAddress = crypto.getRandomValues(new Uint32Array(1))[0]
  dstDeviceAddress?: number
  connectionAddress?: number
  theirs = CONTENTION
  link?: Link
  vs = 0
  vr = 0

  #baudRate = INITIAL_BAUD_RATE
  #writer: WritableStreamDefaultWriter<Transmission>
  #tx = Promise.resolve()
  #txEnd = 0
  #turnaround = false

  #discovering?: PromiseWithResolvers<XIDFrame[]>
  #connecting?: PromiseWithResolvers<Link>

  #slotCount: number
  #slotNumber = 0
  #slot = 0
  #frameSent = false
  #discovered: XIDFrame[] = []
  #snrm?: SNRMFrame

  #store: IFrame[] = []
  #pending: Uint8Array[] = []
  #closing = false
  #remoteBusy = false
  #retryCount = 0
  #frmr?: UFrame

  #slotTimer = new Timer(SLOT_TIMEOUT, () => this.#dispatch({ timer: "slot" }))
  #queryTimer = new Timer(QUERY_TIMEOUT, () => this.#dispatch({ timer: "query" }))
  #pTimer = new Timer(P_TIMEOUT, () => this.#dispatch({ timer: "P" }))
  #fTimer = new Timer(
    F_TIMEOUT,
    () => this.#dispatch({ timer: "F" }),
    () => this.#transmissionRemaining(),
  )
  #wdTimer = new Timer(
    WD_TIMEOUT,
    () => this.#dispatch({ timer: "WD" }),
    () => this.#transmissionRemaining(),
  )

  constructor(dongle: Dongle, options: Options = {}) {
    this.dongle = dongle
    this.listener = options.listener
    this.discoveryInfo = options.discoveryInfo ?? Uint8Array.of(0x80, 0x20, 0x00, ...new TextEncoder().encode("irda"))
    this.capabilities = options.capabilities ?? new Parameters({ baudRatePv: baudRatePv(dongle.baudRates) })
    this.#slotCount = options.slots ?? 6
    this.#writer = dongle.writable.getWriter()

    void this.#listen()
  }

  // --- service interface ---

  async close() {
    await this.dongle.close()
    this.#reset(new IrdaError("Dongle closed"))
  }

  async discover(): Promise<XIDFrame[]> {
    this.#require("NDM")

    this.#discovering = Promise.withResolvers()
    this.#dispatch({ request: "discovery" })

    return this.#discovering.promise
  }

  async connect(address: number): Promise<Link> {
    this.#require("NDM")

    this.#connecting = Promise.withResolvers()
    this.#dispatch({ request: "connect", address })

    return this.#connecting.promise
  }

  #require(state: State) {
    if (this.state !== state) throw new IrdaError(`Cannot do that while in ${this.state}`)
  }

  dataRequest(data: Uint8Array) {
    this.#pending.push(data)
    this.#dispatch({ request: "data" })
  }

  disconnectRequest() {
    this.#closing = true
    this.#dispatch({ request: "disconnect" })
  }

  // --- dongle side ---

  async #listen() {
    let failure: unknown

    try {
      for await (const data of this.dongle.readable) this.#receive(data)
    } catch (error) {
      failure = error
    }

    this.#reset(failure instanceof Error ? failure : new IrdaError("Dongle closed"))
  }

  #receive(data: Uint8Array) {
    const frame = decode(data)

    if (frame) this.#dispatch(frame)
    else log.debug("Dropping malformed frame", hex(data))
  }

  #send(frame: Frame) {
    log.debug("<---", frame)

    const transmission = {
      frame: encode(frame),
      xbofs: this.#xbofs(),
      turnaround: this.#turnaround ? this.theirs.minTurnAroundMs : 0,
    }
    this.#queue(() => this.#writer.write(transmission))

    const bytes = transmission.xbofs + transmission.frame.length + FRAME_OVERHEAD
    this.#txEnd = Math.max(performance.now(), this.#txEnd) + transmission.turnaround + (bytes * 10_000) / this.#baudRate
    this.#turnaround = false
  }

  #queue(action: () => Promise<void>) {
    this.#tx = this.#tx.then(action).catch((error) => log.debug("Dongle write failed", error))
  }

  #setBaudRate(baudRate: number) {
    if (baudRate === this.#baudRate) return

    this.#queue(async () => {
      await this.dongle.setSpeed(baudRate)
      this.#baudRate = baudRate
    })
  }

  #xbofs(): number {
    if (this.theirs === CONTENTION) return CONTENTION_XBOFS

    return Math.floor((this.theirs.additionalBofsAt115200 * this.#baudRate) / 115200)
  }

  #transmissionRemaining(): number {
    return Math.max(0, this.#txEnd - performance.now())
  }

  // --- state machine ---

  #dispatch(trigger: Trigger) {
    const state = this.state

    if ("kind" in trigger) {
      if (this.connected && trigger.address !== this.connectionAddress) return

      this.#turnaround = true
      if (state === "P.RECV" || state === "S.RECV") this.#retryCount = 0
    }

    log.debug("--->", trigger)

    match<[State, Trigger]>([state, trigger])
      // --- DISCOVERY ---

      .with(["NDM", { request: "discovery" }], () => {
        this.#slotNumber = 0
        this.#discovered = []
        this.#sendXIDCommand(this.#slotNumber)
        this.#slotTimer.start()

        this.state = "QUERY"
      })

      .with(["NDM", { kind: "XID", command: true, slotNumber: 0xff }], () => {
        this.state = "NDM"
      })

      .with(["NDM", { kind: "XID", command: true }], ([, xid]) => {
        this.#slot = xid.slotNumber + Math.floor(Math.random() * (xid.slotCount - xid.slotNumber))
        this.#frameSent = this.#slot === xid.slotNumber

        if (this.#frameSent) this.#sendXIDResponse(xid)

        this.#queryTimer.start()

        this.state = "REPLY"
      })

      .with(
        ["QUERY", { timer: "slot" }],
        () => this.#slotNumber < this.#slotCount - 1,
        () => {
          this.#slotNumber += 1
          this.#sendXIDCommand(this.#slotNumber)
          this.#slotTimer.start()

          this.state = "QUERY"
        },
      )

      .with(["QUERY", { timer: "slot" }], () => {
        this.#sendXIDCommand(0xff)
        this.#discovering?.resolve([...this.#discovered])
        this.#discovering = undefined

        this.state = "NDM"
      })

      .with(["QUERY", { kind: "XID", command: false, dstDeviceAddress: this.srcDeviceAddress }], ([, xid]) => {
        this.#discovered.push(xid)

        this.state = "QUERY"
      })

      .with(["REPLY", { kind: "XID", command: true, slotNumber: 0xff }], ([, xid]) => {
        this.#queryTimer.stop()
        log.debug("Announced ourselves to", xid.discoveryInfo)

        this.state = "NDM"
      })

      .with(
        ["REPLY", { kind: "XID", command: true }],
        ([, xid]) => xid.slotNumber >= this.#slot && !this.#frameSent,
        ([, xid]) => {
          this.#sendXIDResponse(xid)
          this.#frameSent = true

          this.state = "REPLY"
        },
      )

      .with(["REPLY", { timer: "query" }], () => {
        this.state = "NDM"
      })

      .with([P.union("QUERY", "REPLY"), { kind: P.string }], () => {
        this.state = state
      })

      // --- CONNECTION ---

      .with(["NDM", { request: "connect" }], ([, { address }]) => {
        this.connectionAddress = 1 + Math.floor(Math.random() * (BROADCAST - 1))
        this.dstDeviceAddress = address
        this.#sendSNRM()
        this.#fTimer.start()
        this.#retryCount = 0

        this.state = "SETUP"
      })

      .with(["NDM", { kind: "SNRM" }], ([, snrm]) => {
        this.dstDeviceAddress = snrm.srcDeviceAddress
        this.connectionAddress = snrm.connectionAddress
        this.#snrm = snrm

        this.state = "CONN"

        this.#dispatch({ request: "connectResponse" })
      })

      .with(["NDM", { kind: "TEST", command: true }], ([, test]) => {
        this.#send(
          U("TEST", BROADCAST, false, {
            srcDeviceAddress: this.srcDeviceAddress,
            dstDeviceAddress: test.srcDeviceAddress,
            data: test.data,
          }),
        )

        this.state = "NDM"
      })

      .with(["CONN", { request: "connectResponse" }], () => {
        try {
          this.#accept(this.#snrm!)
        } catch (error) {
          if (!(error instanceof NegotiationError)) throw error

          console.warn("Negotiation failed", error)
          this.#send(U("DM", this.connectionAddress!, false))

          this.state = "NDM"
          return
        }

        this.#wdTimer.start()

        this.state = "S.RECV"
      })

      .with(
        ["SETUP", { timer: "F" }],
        () => this.#retryCount < RETRY_COUNT,
        () => {
          this.#sendSNRM()
          this.#fTimer.start()
          this.#retryCount += 1

          this.state = "SETUP"
        },
      )

      .with(["SETUP", { timer: "F" }], () => {
        this.#disconnectIndication()

        this.state = "NDM"
      })

      .with(
        ["SETUP", { kind: "SNRM" }],
        ([, snrm]) => snrm.srcDeviceAddress > this.srcDeviceAddress,
        ([, snrm]) => {
          this.#fTimer.stop()
          this.connectionAddress = snrm.connectionAddress
          this.#accept(snrm)
          this.#wdTimer.start()

          this.state = "S.RECV"
        },
      )

      .with(["SETUP", { kind: "UA", parameters: P.nonNullable }], ([, ua]) => {
        this.#fTimer.stop()
        ;[, this.theirs] = this.capabilities.negotiate(ua.parameters)
        this.#initializeConnectionState()
        this.#connect()
        this.#setBaudRate(this.theirs.baudRate)
        this.#send(RR(this.connectionAddress!, true, this.vr))
        this.#fTimer.start()

        this.state = "P.RECV"
      })

      .with(["SETUP", { kind: P.union("DM", "DISC") }], () => {
        this.#fTimer.stop()
        this.#disconnectIndication()

        this.state = "NDM"
      })

      // --- NRM(P) ---

      .with(
        ["P.XMIT", { request: "data" }],
        () => !this.#remoteBusy,
        () => {
          this.#pTimer.stop()
          this.#sendData()
          this.#fTimer.start()

          this.state = "P.RECV"
        },
      )

      .with(
        ["P.XMIT", { request: "disconnect" }],
        () => !this.#pending.length || this.#remoteBusy,
        () => {
          this.#pTimer.stop()
          this.#send(U("DISC", this.connectionAddress!, true))
          this.#fTimer.start()
          this.#retryCount = 0

          this.state = "P.CLOSE"
        },
      )

      .with(["P.XMIT", { timer: "P" }], () => {
        this.#send(RR(this.connectionAddress!, true, this.vr))
        this.#fTimer.start()

        this.state = "P.RECV"
      })

      .with(
        ["P.RECV", { format: P.union("I", "S"), command: false }],
        ([, frame]) => !this.#validNr(frame.nr),
        ([, frame]) => {
          if (frame.pf) {
            this.#send(U("DISC", this.connectionAddress!, true))
            this.#fTimer.start()
            this.#retryCount = 0

            this.state = "P.CLOSE"
          } else {
            this.state = "P.CLOSE_WAIT"
          }
        },
      )

      .with(["P.RECV", { kind: "I", command: false, pf: false, ns: this.vr }], ([, i]) => {
        this.#dataIndication(i.information)
        this.vr = (this.vr + 1) % 8
        this.#ack(i.nr)

        this.state = "P.RECV"
      })

      .with(["P.RECV", { kind: "I", command: false, pf: true, ns: this.vr, nr: this.vs }], ([, i]) => {
        this.#fTimer.stop()
        this.#dataIndication(i.information)
        this.vr = (this.vr + 1) % 8
        this.#ack(i.nr)
        this.#pTimer.start()

        this.state = "P.XMIT"
      })

      .with(["P.RECV", { kind: "I", command: false, pf: true, ns: this.vr }], ([, i]) => {
        this.#dataIndication(i.information)
        this.vr = (this.vr + 1) % 8
        this.#ack(i.nr)
        this.#resend()
        this.#fTimer.start()

        this.state = "P.RECV"
      })

      .with(["P.RECV", { kind: "I", command: false, pf: false }], ([, i]) => {
        this.#ack(i.nr)

        this.state = "P.RECV"
      })

      .with(["P.RECV", { kind: "I", command: false, pf: true }], ([, i]) => {
        this.#ack(i.nr)
        this.#send(RR(this.connectionAddress!, true, this.vr))
        this.#fTimer.start()

        this.state = "P.RECV"
      })

      .with(["P.RECV", { kind: "RR", command: false, pf: true, nr: this.vs }], ([, rr]) => {
        this.#fTimer.stop()
        this.#remoteBusy = false
        this.#ack(rr.nr)
        this.#pTimer.start()

        this.state = "P.XMIT"
      })

      .with(["P.RECV", { kind: "RR", command: false, pf: true }], ([, rr]) => {
        this.#remoteBusy = false
        this.#ack(rr.nr)
        this.#resend()
        this.#fTimer.start()

        this.state = "P.RECV"
      })

      .with(["P.RECV", { kind: "REJ", command: false, pf: true }], ([, rej]) => {
        this.#ack(rej.nr)

        if (this.#remoteBusy) this.#send(RR(this.connectionAddress!, true, this.vr))
        else this.#resend()

        this.#fTimer.start()

        this.state = "P.RECV"
      })

      .with(["P.RECV", { kind: "SREJ", command: false, pf: true }], ([, srej]) => {
        this.#ack(srej.nr)

        if (this.#remoteBusy) this.#send(RR(this.connectionAddress!, true, this.vr))
        else this.#resend(srej.nr)

        this.#fTimer.start()

        this.state = "P.RECV"
      })

      .with(["P.RECV", { kind: "RNR", command: false, pf: true }], ([, rnr]) => {
        this.#fTimer.stop()
        this.#remoteBusy = true
        this.#ack(rnr.nr)
        this.#pTimer.start()

        this.state = "P.XMIT"
      })

      .with(["P.RECV", { kind: "UI", command: false, pf: false }], ([, ui]) => {
        this.#unitdataIndication(ui.information)

        this.state = "P.RECV"
      })

      .with(["P.RECV", { kind: "UI", command: false, pf: true }], ([, ui]) => {
        this.#fTimer.stop()
        this.#unitdataIndication(ui.information)
        this.#pTimer.start()

        this.state = "P.XMIT"
      })

      .with(["P.RECV", { kind: P.union("FRMR", "RD", "RNRM") }], () => {
        this.#send(U("DISC", this.connectionAddress!, true))
        this.#fTimer.start()
        this.#retryCount = 0

        this.state = "P.CLOSE"
      })

      .with(
        ["P.RECV", { timer: "F" }],
        () => this.#retryCount < this.#n2,
        () => {
          this.#send(RR(this.connectionAddress!, true, this.vr))
          this.#fTimer.start()
          this.#retryCount += 1

          this.state = "P.RECV"
        },
      )

      .with(["P.RECV", { timer: "F" }], () => {
        this.#disconnectIndication(new IrdaError("No response"))

        this.state = "NDM"
      })

      .with([P.union("P.RECV", "P.CLOSE_WAIT", "P.CLOSE"), { format: P.union("S", "I"), command: true }], () => {
        this.#fTimer.stop()
        this.#disconnectIndication(new IrdaError("Primary conflict"))

        this.state = "NDM"
      })

      .with(["P.RECV", { kind: P.string, pf: false }], () => {
        this.state = "P.RECV"
      })

      .with(["P.RECV", { kind: P.string, pf: true }], () => {
        this.#fTimer.stop()
        this.#pTimer.start()

        this.state = "P.XMIT"
      })

      .with(["P.CLOSE_WAIT", P.union({ timer: "F" }, { kind: P.string, pf: true })], () => {
        this.#send(U("DISC", this.connectionAddress!, true))
        this.#fTimer.start()
        this.#retryCount = 0

        this.state = "P.CLOSE"
      })

      .with(["P.CLOSE_WAIT", { kind: P.string, pf: false }], () => {
        this.state = "P.CLOSE_WAIT"
      })

      .with(["P.CLOSE", { kind: P.union("UA", "DM") }], () => {
        this.#fTimer.stop()
        this.#disconnectIndication()

        this.state = "NDM"
      })

      .with(
        ["P.CLOSE", { timer: "F" }],
        () => this.#retryCount < RETRY_COUNT,
        () => {
          this.#send(U("DISC", this.connectionAddress!, true))
          this.#fTimer.start()
          this.#retryCount += 1

          this.state = "P.CLOSE"
        },
      )

      .with(["P.CLOSE", { timer: "F" }], () => {
        this.#disconnectIndication()

        this.state = "NDM"
      })

      .with(["P.CLOSE", { kind: P.string }], () => {
        this.state = "P.CLOSE"
      })

      // --- NRM(S) ---

      .with(
        ["S.XMIT", { request: "data" }],
        () => !this.#remoteBusy,
        () => {
          this.#sendData()
          this.#wdTimer.start()

          this.state = "S.RECV"
        },
      )

      .with(
        ["S.XMIT", { request: "disconnect" }],
        () => !this.#pending.length || this.#remoteBusy,
        () => {
          this.#send(U("RD", this.connectionAddress!, false))
          this.#wdTimer.start()

          this.state = "S.CLOSE"
        },
      )

      .with(
        ["S.RECV", { format: P.union("I", "S"), command: true }],
        ([, frame]) => !this.#validNr(frame.nr),
        ([, frame]) => {
          this.#frmr = U("FRMR", this.connectionAddress!, false, {
            rejectedControl: encode(frame)[1],
            ns: this.vs,
            cr: frame.command,
            nr: this.vr,
            w: false,
            x: false,
            y: false,
            z: true,
          })

          if (frame.pf) {
            this.#send(this.#frmr)
            this.#wdTimer.start()

            this.state = "S.RECV"
          } else {
            this.state = "S.ERROR"
          }
        },
      )

      .with(["S.RECV", { kind: "I", command: true, pf: false, ns: this.vr }], ([, i]) => {
        this.#dataIndication(i.information)
        this.vr = (this.vr + 1) % 8
        this.#ack(i.nr)

        this.state = "S.RECV"
      })

      .with(
        ["S.RECV", { kind: "I", command: true, pf: true, ns: this.vr, nr: this.vs }],
        () => this.#requestsPending,
        ([, i]) => {
          this.#dataIndication(i.information)
          this.vr = (this.vr + 1) % 8
          this.#ack(i.nr)
          this.#wdTimer.stop()

          this.state = "S.XMIT"
        },
      )

      .with(["S.RECV", { kind: "I", command: true, pf: true, ns: this.vr, nr: this.vs }], ([, i]) => {
        this.#dataIndication(i.information)
        this.vr = (this.vr + 1) % 8
        this.#ack(i.nr)
        this.#send(RR(this.connectionAddress!, false, this.vr))
        this.#wdTimer.start()

        this.state = "S.RECV"
      })

      .with(["S.RECV", { kind: "I", command: true, pf: true, ns: this.vr }], ([, i]) => {
        this.#dataIndication(i.information)
        this.vr = (this.vr + 1) % 8
        this.#ack(i.nr)
        this.#resend()
        this.#wdTimer.start()

        this.state = "S.RECV"
      })

      .with(["S.RECV", { kind: "I", command: true, pf: false }], ([, i]) => {
        this.#ack(i.nr)

        this.state = "S.RECV"
      })

      .with(["S.RECV", { kind: "I", command: true, pf: true }], ([, i]) => {
        this.#ack(i.nr)
        this.#send(RR(this.connectionAddress!, false, this.vr))
        this.#wdTimer.start()

        this.state = "S.RECV"
      })

      .with(
        ["S.RECV", { kind: "RR", command: true, pf: true, nr: this.vs }],
        () => this.#requestsPending,
        ([, rr]) => {
          this.#remoteBusy = false
          this.#ack(rr.nr)
          this.#wdTimer.stop()

          this.state = "S.XMIT"
        },
      )

      .with(["S.RECV", { kind: "RR", command: true, pf: true, nr: this.vs }], ([, rr]) => {
        this.#remoteBusy = false
        this.#ack(rr.nr)
        this.#send(RR(this.connectionAddress!, false, this.vr))
        this.#wdTimer.start()

        this.state = "S.RECV"
      })

      .with(["S.RECV", { kind: "RR", command: true, pf: true }], ([, rr]) => {
        this.#remoteBusy = false
        this.#ack(rr.nr)
        this.#resend()
        this.#wdTimer.start()

        this.state = "S.RECV"
      })

      .with(["S.RECV", { kind: "REJ", command: true, pf: true }], ([, rej]) => {
        this.#ack(rej.nr)

        if (this.#remoteBusy) this.#send(RR(this.connectionAddress!, false, this.vr))
        else this.#resend()

        this.#wdTimer.start()

        this.state = "S.RECV"
      })

      .with(["S.RECV", { kind: "SREJ", command: true, pf: true }], ([, srej]) => {
        this.#ack(srej.nr)

        if (this.#remoteBusy) this.#send(RR(this.connectionAddress!, false, this.vr))
        else this.#resend(srej.nr)

        this.#wdTimer.start()

        this.state = "S.RECV"
      })

      .with(["S.RECV", { kind: "RNR", command: true, pf: true }], ([, rnr]) => {
        this.#remoteBusy = true
        this.#ack(rnr.nr)
        this.#send(RR(this.connectionAddress!, false, this.vr))
        this.#wdTimer.start()

        this.state = "S.RECV"
      })

      .with(["S.RECV", { kind: "UI", command: true, pf: false }], ([, ui]) => {
        this.#unitdataIndication(ui.information)

        this.state = "S.RECV"
      })

      .with(
        ["S.RECV", { kind: "UI", command: true, pf: true }],
        () => this.#requestsPending,
        ([, ui]) => {
          this.#unitdataIndication(ui.information)
          this.#wdTimer.stop()

          this.state = "S.XMIT"
        },
      )

      .with(["S.RECV", { kind: "UI", command: true, pf: true }], ([, ui]) => {
        this.#unitdataIndication(ui.information)
        this.#send(RR(this.connectionAddress!, false, this.vr))
        this.#wdTimer.start()

        this.state = "S.RECV"
      })

      .with(["S.RECV", { kind: "TEST", command: true, pf: true }], ([, test]) => {
        this.#send(U("TEST", this.connectionAddress!, false, { data: test.data }))
        this.#wdTimer.start()

        this.state = "S.RECV"
      })

      .with([P.union("S.RECV", "S.ERROR"), { kind: "DISC", pf: true }], () => {
        this.#send(U("UA", this.connectionAddress!, false))
        this.#wdTimer.stop()
        this.#disconnectIndication()

        this.state = "NDM"
      })

      .with(["S.RECV", { kind: "SNRM", pf: true }], () => {
        this.#send(U("RD", this.connectionAddress!, false))
        this.#wdTimer.start()

        this.state = "S.CLOSE"
      })

      .with(
        ["S.RECV", { timer: "WD" }],
        () => this.#retryCount < this.#n2,
        () => {
          this.#retryCount += 1
          this.#wdTimer.start()

          this.state = "S.RECV"
        },
      )

      .with(["S.RECV", { timer: "WD" }], () => {
        this.#disconnectIndication(new IrdaError("No response"))

        this.state = "NDM"
      })

      .with([P.union("S.RECV", "S.CLOSE"), { format: P.union("S", "I"), command: false }], () => {
        this.#wdTimer.stop()
        this.#disconnectIndication(new IrdaError("Primary conflict"))

        this.state = "NDM"
      })

      .with(["S.RECV", { kind: P.string }], () => {
        this.state = "S.RECV"
      })

      .with(["S.ERROR", { kind: P.string, pf: true }], () => {
        this.#send(this.#frmr!)
        this.#wdTimer.start()

        this.state = "S.RECV"
      })

      .with(["S.ERROR", { kind: P.string, pf: false }], () => {
        this.state = "S.ERROR"
      })

      .with(["S.CLOSE", { kind: "DISC", pf: true }], () => {
        this.#wdTimer.stop()
        this.#send(U("UA", this.connectionAddress!, false))
        this.#disconnectIndication()

        this.state = "NDM"
      })

      .with(["S.CLOSE", { kind: "DM" }], () => {
        this.#wdTimer.stop()
        this.#disconnectIndication()

        this.state = "NDM"
      })

      .with(["S.CLOSE", { kind: P.string, pf: true }], () => {
        this.#send(U("RD", this.connectionAddress!, false))
        this.#wdTimer.start()

        this.state = "S.CLOSE"
      })

      .with(["S.CLOSE", { kind: P.string, pf: false }], () => {
        this.state = "S.CLOSE"
      })

      .with(["S.CLOSE", { timer: "WD" }], () => {
        this.#disconnectIndication()

        this.state = "NDM"
      })

      .with([P._, { request: P.string }], () => {})

      .otherwise(() => log.debug("Ignoring", trigger, "in", state))

    log.debug("<-->", this.state)

    if ((this.state === "P.XMIT" || this.state === "S.XMIT") && this.state !== state) {
      this.#servicePendingRequests()
    }
  }

  #reset(error: Error) {
    for (const timer of [this.#slotTimer, this.#queryTimer, this.#pTimer, this.#fTimer, this.#wdTimer]) timer.stop()

    this.#discovering?.reject(error)
    this.#discovering = undefined
    if (this.state !== "NDM") this.#disconnectIndication(error)

    this.state = "NDM"
  }

  #servicePendingRequests() {
    if (this.#pending.length && !this.#remoteBusy) this.#dispatch({ request: "data" })
    else if (this.#closing) this.#dispatch({ request: "disconnect" })
  }

  // --- predicates ---

  get connected(): boolean {
    return primary(this.state) || secondary(this.state)
  }

  get #requestsPending(): boolean {
    return this.#closing || (this.#pending.length > 0 && !this.#remoteBusy)
  }

  get #n2(): number {
    const timeout = primary(this.state) ? F_TIMEOUT : WD_TIMEOUT

    return Math.ceil((this.theirs.linkDisconnectSecs * 1000) / timeout)
  }

  #validNr(nr: number): boolean {
    return nr === this.vs || this.#store.some((frame) => frame.ns === nr)
  }

  // --- actions ---

  #sendXIDCommand(slotNumber: number) {
    this.#send(
      U("XID", BROADCAST, true, {
        srcDeviceAddress: this.srcDeviceAddress,
        dstDeviceAddress: XID_BROADCAST,
        generateNewAddress: false,
        slotCount: this.#slotCount,
        slotNumber,
        version: 0,
        discoveryInfo: slotNumber === 0xff ? this.discoveryInfo : EMPTY,
      }),
    )
  }

  #sendXIDResponse(xid: XIDFrame) {
    this.#send(
      U("XID", BROADCAST, false, {
        srcDeviceAddress: this.srcDeviceAddress,
        dstDeviceAddress: xid.srcDeviceAddress,
        generateNewAddress: false,
        slotCount: xid.slotCount,
        slotNumber: this.#slot,
        version: 0,
        discoveryInfo: this.discoveryInfo,
      }),
    )
  }

  #sendSNRM() {
    this.#send(
      U("SNRM", BROADCAST, true, {
        srcDeviceAddress: this.srcDeviceAddress,
        dstDeviceAddress: this.dstDeviceAddress!,
        connectionAddress: this.connectionAddress!,
        parameters: this.capabilities,
      }),
    )
  }

  #accept(snrm: SNRMFrame) {
    const [ours, theirs] = this.capabilities.negotiate(snrm.parameters)
    this.theirs = theirs
    this.#initializeConnectionState()
    this.#connect()
    this.#send(
      U("UA", this.connectionAddress!, false, {
        srcDeviceAddress: this.srcDeviceAddress,
        dstDeviceAddress: this.dstDeviceAddress,
        parameters: ours,
      }),
    )
    this.#setBaudRate(theirs.baudRate)
  }

  #initializeConnectionState() {
    this.vs = 0
    this.vr = 0
    this.#store = []
    this.#remoteBusy = false
    this.#retryCount = 0
  }

  #takeWindow(): Uint8Array[] {
    let budget = Math.floor((this.#baudRate * this.theirs.maxTurnAroundMs) / 10_000)
    const overhead = FRAME_OVERHEAD + this.#xbofs()
    const window = [this.#pending.shift()!]

    while (this.#pending.length && window.length < this.theirs.windowSize) {
      budget -= window.at(-1)!.length + overhead

      if (budget < this.#pending[0].length + overhead) break

      window.push(this.#pending.shift()!)
    }

    return window
  }

  #sendData() {
    const window = this.#takeWindow()

    for (const [i, information] of window.entries()) {
      const frame: IFrame = {
        format: "I",
        kind: "I",
        address: this.connectionAddress!,
        command: primary(this.state),
        ns: this.vs,
        nr: this.vr,
        information,
        pf: i === window.length - 1,
      }
      this.#store.push(frame)
      this.#send(frame)
      this.vs = (this.vs + 1) % 8
    }
  }

  #ack(nr: number) {
    while (this.#store.length && this.#store[0].ns !== nr) {
      this.#store.shift()
    }
  }

  #resend(nr?: number) {
    const frames: Frame[] = this.#store.filter((frame) => nr === undefined || frame.ns === nr)

    if (!frames.length) frames.push(RR(this.connectionAddress!, primary(this.state), this.vr))

    for (const [i, frame] of frames.entries()) {
      frame.pf = i === frames.length - 1
      this.#send(frame)
    }
  }

  #connect() {
    this.link = new Link(this)
    this.listener?.(this.link)

    this.#connecting?.resolve(this.link)
    this.#connecting = undefined
  }

  #disconnectIndication(error?: Error) {
    this.theirs = CONTENTION
    this.connectionAddress = undefined
    this.#store = []
    this.#pending = []
    this.#closing = false

    this.#connecting?.reject(error ?? new IrdaError("Connection refused"))
    this.#connecting = undefined

    this.link?.end(error)
    this.link = undefined

    this.#setBaudRate(INITIAL_BAUD_RATE)
  }

  #dataIndication(data: Uint8Array) {
    this.link!.push(data)
  }

  #unitdataIndication(data: Uint8Array) {
    log.debug("Received unit data", hex(data))
  }
}
