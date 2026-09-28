import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import { Duplex } from "../src/connection.ts"
import { sir, type SirPort } from "../src/dongle/index.ts"
import { IrLAP } from "../src/irlap/irlap.ts"
import { Hints, IrLMP } from "../src/irlmp/index.ts"
import { Header, OBEX, ResponseCode, header } from "../src/obex/index.ts"
import { TinyTP } from "../src/tinytp/index.ts"
import "./wire.ts"

const REPO = path.resolve(import.meta.dirname, "../..")

const pattern = (length: number) => new Uint8Array(length).map((_, i) => (i * 7) & 0xff)

class SocketDongle extends Duplex implements SirPort {
  readonly baudRates = [9600]

  #socket: net.Socket

  constructor(socket: net.Socket) {
    super()
    this.#socket = socket
    socket.on("data", (data: Uint8Array) => this.push(data))
    socket.on("close", () => this.end())
    socket.on("error", (error) => this.end(error))
  }

  async setSpeed() {}

  async close() {
    this.#socket.destroy()
    this.end()
  }

  protected write(data: Uint8Array) {
    this.#socket.write(data)
  }

  protected disconnect() {
    void this.close()
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

function stack(socket: net.Socket) {
  const irlap = new IrLAP(sir(new SocketDongle(socket)))
  const irlmp = new IrLMP(irlap, { nickname: "web", hints: Hints.COMPUTER | Hints.OBEX })
  const tinytp = new TinyTP(irlmp)

  return { irlap, irlmp, tinytp, obex: new OBEX(tinytp) }
}

test("sends a file to the Python inbox", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pyirda-"))
  const { port, socket, server } = await line()
  const child = python([`socket://127.0.0.1:${port}`], dir)
  const { irlap, irlmp, obex } = stack(await socket)

  try {
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
  const child = python([`socket://127.0.0.1:${port}`, path.join(dir, "send.bin")], dir)
  const { irlap, irlmp, tinytp, obex } = stack(await socket)
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

  try {
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
