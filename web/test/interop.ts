import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { Duplex } from "node:stream"
import { test } from "node:test"

import { IrLAP, type Port } from "../src/irlap/irlap.ts"
import { Hints, IrLMP } from "../src/irlmp/index.ts"
import { Header, OBEX, ResponseCode, header } from "../src/obex/index.ts"
import { TinyTP } from "../src/tinytp/index.ts"
import "./wire.ts"

const REPO = path.resolve(import.meta.dirname, "../..")

const pattern = (length: number) => new Uint8Array(length).map((_, i) => (i * 7) & 0xff)

class SocketPort implements Port {
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null
  #socket: Promise<net.Socket>

  constructor(socket: Promise<net.Socket>) {
    this.#socket = socket
  }

  async open() {
    const { readable, writable } = Duplex.toWeb(await this.#socket)
    this.readable = readable as unknown as ReadableStream<Uint8Array>
    this.writable = writable as unknown as WritableStream<Uint8Array>
  }

  async close() {
    ;(await this.#socket).destroy()
    this.readable = null
    this.writable = null
  }
}

async function line(): Promise<{ port: number; socket: Promise<net.Socket>; server: net.Server }> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const socket = new Promise<net.Socket>((resolve) => server.once("connection", resolve))

  return { port: (server.address() as net.AddressInfo).port, socket, server }
}

function python(args: string[], cwd: string): ChildProcess {
  return spawn("uv", ["run", "--project", REPO, "python", "-m", "pyirda", ...args], {
    cwd,
    env: { ...process.env, PYTHONPATH: path.join(REPO, "src") },
    stdio: ["ignore", "inherit", "inherit"],
  })
}

function stack(port: Port) {
  const irlap = new IrLAP(port)
  const irlmp = new IrLMP(irlap, { nickname: "web", hints: Hints.COMPUTER | Hints.OBEX })
  const tinytp = new TinyTP(irlmp)

  return { irlap, irlmp, tinytp, obex: new OBEX(tinytp) }
}

test("sends a file to the Python inbox", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pyirda-"))
  const { port, socket, server } = await line()
  const { irlap, irlmp, obex } = stack(new SocketPort(socket))
  const child = python([`socket://127.0.0.1:${port}`], dir)

  try {
    await irlap.open()

    const device = (await irlmp.discover()).find((device) => device.hints & Hints.OBEX)
    assert.ok(device)
    assert.equal(device.nickname, "pyirda")

    const content = pattern(5000)
    const client = await obex.connect(device.address)
    await client.put("hello.bin", content)
    await client.disconnect()

    assert.deepEqual(new Uint8Array(await readFile(path.join(dir, "hello.bin"))), content)
  } finally {
    child.kill()
    await irlap.close()
    server.close()
  }
})

test("receives a file from the Python client", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pyirda-"))
  const content = pattern(5000)
  await writeFile(path.join(dir, "send.bin"), content)

  const { port, socket, server } = await line()
  const { irlap, irlmp, tinytp, obex } = stack(new SocketPort(socket))
  const received = Promise.withResolvers<{ name: unknown; content: Uint8Array | null }>()

  irlmp.listeners.set(
    0x05,
    tinytp.server(
      obex.server({
        put(headers, content) {
          received.resolve({ name: header(headers, Header.NAME), content })
          return ResponseCode.SUCCESS
        },
      }),
    ),
  )
  irlmp.ias.objects.OBEX = { "IrDA:TinyTP:LsapSel": 0x05 }

  const child = python([`socket://127.0.0.1:${port}`, path.join(dir, "send.bin")], dir)

  try {
    await irlap.open()

    const result = await received.promise
    assert.equal(result.name, "send.bin")
    assert.deepEqual(result.content, content)

    await new Promise((resolve) => child.once("exit", resolve))
  } finally {
    child.kill()
    await irlap.close()
    server.close()
  }
})
