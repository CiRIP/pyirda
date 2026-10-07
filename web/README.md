# irda-web

An IrDA stack for the browser: IrLAP, IrLMP with IAS, TinyTP and OBEX. A TypeScript port of [pyirda](..), written against the specs in `../docs`.

Each layer is a state machine transcribed from its spec's tables, and each connection is a `{ readable, writable }` pair of Web Streams, so the same shape is used from the dongle up to OBEX.

## Dongles

A dongle moves IrLAP frames (address, control and information, no FCS) and knows what it can run at:

```ts
interface Dongle {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<{ frame: Uint8Array; xbofs: number; turnaround: number }>
  baudRates: number[]
  setSpeed(baudRate: number): Promise<void>
  close(): Promise<void>
}
```

Each written frame carries the extra BOFs to send and the minimum turnaround (in ms) to wait before sending it. The streams stay valid across speed changes, and `setSpeed` applies to the frames written after it, so IrLAP never reopens anything itself. `baudRates` feeds straight into IrLAP's negotiated capabilities, so a dongle is as fast as it says it is. Everyone starts at 9600, the rate IrLAP negotiates at.

Most dongles are plain SIR transceivers that move raw bytes. They implement `SirPort`, the same interface over bytes, and `sir(port)` turns one into a `Dongle` by adding the BOFs, escaping, FCS and turnaround padding:

- `SerialDongle` — any SIR dongle behind [Web Serial](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API); changing speed reopens the port underneath. Limited to 9600 baud for now.
- `KS959` — KingSun KS-959 over [WebUSB](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API), which carries frames in control transfers, obfuscated and padded, and is polled for receive. Ported from the Linux `ks959-sir` driver. Not working yet: its speed request needs a control transfer WebUSB refuses to send.
- `STIR4200` — SigmaTel STIr4200 over WebUSB: bulk endpoints with a `55 AA` length header on transmit, raw bytes on receive, and speed set by programming the transceiver's registers. Reads wait until the FIFO is not transmitting, since WebUSB cannot cancel a pending transfer. Ported from the Linux `stir4200` driver and the datasheet.
- `MCS7780` — MosChip MCS7780 over WebUSB: one wrapped frame per bulk transfer behind a little-endian length that counts itself, received frames arrive without their BOF and EOF, and speed is a register write followed by a reset once the transmitter is idle. Ported from the Linux `mcs7780` driver and the datasheet.
- `MCS7784` — MosChip MCS7784 and MCS7703 (sold as the UIR-33) over WebUSB: a 16550-style UART behind vendor register requests, carrying the raw byte stream over bulk endpoints, with speed set through the divisor once the transmitter is empty. Ported from MosChip's Windows `MosSir.sys` driver.

The SigmaTel STIr4210, STIr4220 and STIr4116 do the framing themselves, so `STIR421X` is a `Dongle` directly: each bulk transfer is one frame behind a 3-byte header that carries speed, extra BOFs and turnaround. The chip needs a firmware patch uploaded on open: `STIR421X.open(device, STIR421X_PATCHES)` picks the one matching the device version from the patches in `src/dongle/firmware`, which Vite inlines into the bundle. The patched chip reports its speeds in the USB-IrDA class descriptor. Ported from the Linux `irda-usb` driver.

```ts
const irlap = new IrLAP(sir(await SerialDongle.open(await navigator.serial.requestPort())))
const irlmp = new IrLMP(irlap, { nickname: "web", hints: Hints.COMPUTER | Hints.OBEX })
const tinytp = new TinyTP(irlmp)
const obex = new OBEX(tinytp)

irlmp.listeners.set(0x05, tinytp.server(obex.server({ put: (headers, content) => ResponseCode.SUCCESS })))
irlmp.ias.objects.OBEX = { "IrDA:TinyTP:LsapSel": 0x05 }

const [device] = await irlmp.discover()
const client = await obex.connect(device.address)
await client.put("hello.txt", new TextEncoder().encode("hello"))
await client.disconnect()
```

## Development

```sh
npm install
npm run dev            # drop-a-file sender at http://localhost:5173, needs a Chromium browser for Web Serial / WebUSB
                       # demo page with every layer exposed at http://localhost:5173/demo.html
npm run check          # typecheck
npm test               # loopback tests over a simulated 9600 baud line
npm run test:interop   # both stacks against the Python implementation over TCP (needs uv)
```

The interop test runs `python -m pyirda socket://127.0.0.1:PORT` from the parent repository and exchanges files in both directions. Each USB driver is covered against a fake device that implements its documented protocol, so the whole stack runs through it.
