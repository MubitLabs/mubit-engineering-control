// Owner ruling: a restart comes back on the last port, so an open tab stays connected. If that port
// is taken, MEC takes an ephemeral one and says so.
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type RunningServer, startServer } from '../src/composition'
import { serveOptions, startupLines } from '../src/serve'

let dataDir: string
let running: RunningServer | undefined
let squatter: Server | undefined

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mec-port-'))
})

afterEach(async () => {
  await running?.close()
  running = undefined
  await new Promise<void>((resolve) => (squatter === undefined ? resolve() : squatter.close(() => resolve())))
  squatter = undefined
  rmSync(dataDir, { recursive: true, force: true })
})

const start = async (): Promise<RunningServer> => {
  running = await startServer(serveOptions(dataDir))
  return running
}

const stop = async (): Promise<void> => {
  await running?.close()
  running = undefined
}

const occupy = (port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    squatter = createServer()
    squatter.once('error', reject)
    squatter.listen(port, '127.0.0.1', resolve)
  })

describe('the server port across restarts', () => {
  it('a restart comes back on the last port', async () => {
    const { port } = await start()
    await stop()
    const again = await start()
    expect(again.port).toBe(port)
    expect(again.portMoved).toBeUndefined()
  })

  it('a taken port falls back to an ephemeral one and says so', async () => {
    const { port } = await start()
    await stop()
    await occupy(port)
    const moved = await start()
    expect(moved.port).not.toBe(port)
    expect(moved.portMoved).toEqual({ from: port, to: moved.port })
    expect(startupLines(moved).join('\n')).toContain(`port ${port} is taken`)
  })

  it('the port it moved to is the one the next restart reuses', async () => {
    const { port } = await start()
    await stop()
    await occupy(port)
    const moved = await start()
    await stop()
    expect((await start()).port).toBe(moved.port)
  })

  it('without the real entry a start stays ephemeral', async () => {
    const { port } = await start()
    await stop()
    await occupy(port)
    running = await startServer({ dataDir })
    expect(running.portMoved).toBeUndefined()
    expect(serveOptions(dataDir).reuseLastPort).toBe(true)
  })

  it('an unmoved start says only where it listens', async () => {
    const handle = await start()
    expect(startupLines(handle)).toEqual([`mec server listening on ${handle.url}`])
  })
})
