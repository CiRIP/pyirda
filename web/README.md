# irda-web

An IrDA stack for the browser: IrLAP over [Web Serial](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API), IrLMP with IAS, TinyTP and OBEX. A TypeScript port of [pyirda](..), written against the specs in `../docs`.

Each layer is a state machine transcribed from its spec's tables, and each connection is a `{ readable, writable }` pair of Web Streams, so the same shape is used from the serial port up to OBEX.

```ts
const irlap = new IrLAP(await navigator.serial.requestPort())
const irlmp = new IrLMP(irlap, { nickname: "web", hints: Hints.COMPUTER | Hints.OBEX })
const tinytp = new TinyTP(irlmp)
const obex = new OBEX(tinytp)

irlmp.listeners.set(0x05, tinytp.server(obex.server({ put: (headers, content) => ResponseCode.SUCCESS })))
irlmp.ias.objects.OBEX = { "IrDA:TinyTP:LsapSel": 0x05 }
await irlap.open()

const [device] = await irlmp.discover()
const client = await obex.connect(device.address)
await client.put("hello.txt", new TextEncoder().encode("hello"))
await client.disconnect()
```

## Development

```sh
npm install
npm run dev            # demo page at http://localhost:5173, needs a Chromium browser for Web Serial
npm run check          # typecheck
npm test               # loopback tests over a simulated 9600 baud line
npm run test:interop   # both stacks against the Python implementation over TCP (needs uv)
```

The interop test runs `python -m pyirda socket://127.0.0.1:PORT` from the parent repository and exchanges files in both directions.
