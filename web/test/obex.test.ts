import assert from "node:assert/strict"
import { test } from "node:test"

import { ascii, equals } from "../src/bytes.ts"
import { IrLAP } from "../src/irlap/irlap.ts"
import { Hints, IrLMP } from "../src/irlmp/index.ts"
import { LINGER_TIMEOUT } from "../src/irlmp/constants.ts"
import {
  Header,
  OBEX,
  OBEXError,
  Opcode,
  ResponseCode,
  header,
  type Handlers,
  type Headers,
} from "../src/obex/index.ts"
import { TinyTP } from "../src/tinytp/index.ts"
import { sir, sleep, Wire } from "./wire.ts"

function stack(port: Wire, nickname: string) {
  const irlap = new IrLAP(sir(port))
  const irlmp = new IrLMP(irlap, { nickname, hints: Hints.COMPUTER | Hints.OBEX })

  return { irlap, irlmp, obex: new OBEX(new TinyTP(irlmp)) }
}

test("OBEX put, get, setpath, abort and disconnect", async () => {
  const [ab, ba] = Wire.pair()
  const a = stack(ab, "A")
  const b = stack(ba, "B")

  const objects = new Map<string, Uint8Array>()
  const puts: [Headers, Uint8Array | null][] = []
  const served: [number, unknown, number, number | undefined][] = []

  const inbox: Handlers = {
    progress(opcode, headers, transferred, total) {
      served.push([opcode, header(headers, Header.NAME), transferred, total])
    },

    put(headers, content) {
      puts.push([headers, content])
      const name = String(header(headers, Header.NAME))

      if (name === "secret") return ResponseCode.FORBIDDEN

      if (content) objects.set(name, content)
      return ResponseCode.SUCCESS
    },

    get(headers) {
      const content = objects.get(String(header(headers, Header.NAME)))
      if (!content) return ResponseCode.NOT_FOUND

      return {
        headers: [
          [Header.NAME, header(headers, Header.NAME)!],
          [Header.LENGTH, content.length],
        ],
        content,
      }
    },
  }

  b.irlmp.listeners.set(0x05, b.obex.tinytp.server(b.obex.server(inbox)))
  b.irlmp.ias.objects.OBEX = { "IrDA:TinyTP:LsapSel": 0x05 }

  const [device] = await a.irlmp.discover()
  assert.ok(device.hints & Hints.OBEX)

  const client = await a.obex.connect(device.address, { maxPacketLength: 600 })
  assert.equal(client.peerMaxPacketLength, 1024)

  // multi-packet PUT, packets spanning several TTP SDUs
  const jumar = new Uint8Array(3072).map((_, i) => i)
  const sent: [number, number | undefined][] = []
  await client.put("jumar.txt", jumar, {
    type: "text/plain",
    progress: (transferred, total) => sent.push([transferred, total]),
  })
  assert.deepEqual(objects.get("jumar.txt"), jumar)
  assert.ok(sent.length > 1)
  assert.deepEqual(sent.at(-1), [jumar.length, jumar.length])
  assert.deepEqual(
    served.map(([, , transferred]) => transferred),
    sent.map(([transferred]) => transferred),
  )
  assert.ok(
    served.every(([opcode, name, , total]) => opcode === Opcode.PUT && name === "jumar.txt" && total === jumar.length),
  )
  const [headers] = puts.at(-1)!
  assert.equal(header(headers, Header.NAME), "jumar.txt")
  assert.ok(equals(header(headers, Header.TYPE) as Uint8Array, ascii("text/plain\0")))
  assert.equal(header(headers, Header.LENGTH), jumar.length)

  // create-empty and delete
  await client.put("empty", new Uint8Array(0))
  assert.deepEqual(puts.at(-1)![1], new Uint8Array(0))
  await client.put("gone", null)
  assert.equal(puts.at(-1)![1], null)

  // refused PUT
  await assert.rejects(client.put("secret", ascii("x")), (error: OBEXError) => error.code === ResponseCode.FORBIDDEN)

  // multi-packet GET
  served.length = 0
  const received: [number, number | undefined][] = []
  const got = await client.get("jumar.txt", { progress: (transferred, total) => received.push([transferred, total]) })
  assert.deepEqual(got.content, jumar)
  assert.deepEqual(received.at(-1), [jumar.length, jumar.length])
  assert.deepEqual(
    served.map(([opcode, , transferred]) => [opcode, transferred]),
    received.map(([transferred]) => [Opcode.GET, transferred]),
  )
  assert.equal(header(got.headers, Header.LENGTH), jumar.length)

  await assert.rejects(client.get("missing"), (error: OBEXError) => error.code === ResponseCode.NOT_FOUND)

  // unsupported operations
  await assert.rejects(client.setpath("dir"), (error: OBEXError) => error.code === ResponseCode.NOT_IMPLEMENTED)

  // aborted multi-packet PUT: the server never sees the object
  const controller = new AbortController()
  const put = client.put("half.txt", jumar, { signal: controller.signal, progress: () => controller.abort() })
  await assert.rejects(put, { name: "AbortError" })
  assert.equal(objects.has("half.txt"), false)

  await client.disconnect()

  await sleep(LINGER_TIMEOUT + 1000)
  assert.equal(a.irlap.state, "NDM")
  assert.equal(b.irlap.state, "NDM")

  await a.irlap.close()
  await b.irlap.close()
})
