import type { AddressInfo, Socket } from 'node:net'
import { connect } from 'node:net'
import type { HealthBoard, HealthClaim, HealthName, Json } from '@mec/contracts'
import { InspectionReads, MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildServer, EVENT_BACKLOG_CAP, EVENT_FLUSH_CAP } from '../src/server'

/** The bounded `/api/events` (§17): capped flushes, compact frames, a reset past the backlog cap. */

const AT = '2026-11-05T12:00:00.000Z'
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

const quietHealth: HealthBoard = {
  claim(_name: HealthName): HealthClaim {
    return { starting: () => {}, ready: () => {}, paused: () => {}, error: () => {} }
  },
  names: () => [],
  entry: () => undefined,
} as unknown as HealthBoard

let db: Database.Database
let store: SqliteStore
let app: ReturnType<typeof buildServer>

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db, MIGRATIONS_v1)
  store = new SqliteStore(db, { now: () => new Date(AT) })
  app = buildServer({
    store,
    effects: store.effects,
    health: quietHealth,
    policyText: '{"preAuthorised":{}}',
    now: () => new Date(AT),
    inspection: new InspectionReads(db),
  })
})

afterEach(async () => {
  app.server.closeAllConnections()
  await app.close()
  db.close()
})

const seed = (stream: string, count: number, body: (seq: number) => Json = (seq) => ({ seq })): void => {
  store.atomic(() => {
    const start = store.events.read(stream).at(-1)?.seq ?? 0
    for (let seq = start + 1; seq <= start + count; seq += 1) {
      store.events.append(stream, { stream, seq, at: AT, type: 'tick', body: body(seq) })
    }
  })
}

type Frame = { id?: string; event?: string; data: string }
const framesOf = (text: string): Frame[] =>
  text
    .split('\n\n')
    .filter((chunk) => chunk.trim() !== '')
    .map((chunk) => {
      const frame: Frame = { data: '' }
      for (const line of chunk.split('\n')) {
        if (line.startsWith('id: ')) frame.id = line.slice(4)
        if (line.startsWith('event: ')) frame.event = line.slice(7)
        if (line.startsWith('data: ')) frame.data = line.slice(6)
      }
      return frame
    })

const open = async (url: string): Promise<Frame[]> =>
  framesOf((await app.inject({ method: 'GET', url })).body)
const seqs = (frames: Frame[]): number[] =>
  frames.map((frame) => (JSON.parse(frame.data) as { seq: number }).seq)

describe('/api/events is bounded', () => {
  it('flush is capped per stream', async () => {
    seed('work:a', EVENT_FLUSH_CAP + 10)
    seed('work:b', EVENT_FLUSH_CAP + 10)
    const frames = await open('/api/events?stream=work:a,work:b')
    const perStream = (name: string): number =>
      frames.filter((frame) => frame.id?.startsWith(`${name}:`)).length
    expect(perStream('work:a')).toBe(EVENT_FLUSH_CAP)
    expect(perStream('work:b')).toBe(EVENT_FLUSH_CAP)
  })

  it('compact frames carry no body', async () => {
    seed('work:a', 2, () => ({ text: 'a body with words', key: KEY }))
    const frames = await open('/api/events?stream=work:a&compact=1')
    expect(frames).toHaveLength(2)
    expect(JSON.parse(frames[0]?.data ?? '')).toEqual({ stream: 'work:a', seq: 1, type: 'tick', at: AT })
    expect(frames.map((frame) => frame.data).join('')).not.toContain('words')
  })

  it('a full frame is redacted', async () => {
    seed('work:a', 1, () => ({ nested: { text: `key ${KEY} here` } }))
    const [frame] = await open('/api/events?stream=work:a')
    expect(frame?.data).not.toContain(KEY)
    expect(frame?.data).toContain('[redacted:')
    expect(frame?.data).toContain('here')
  })

  it('backlog past the cap sends reset', async () => {
    seed('work:a', EVENT_BACKLOG_CAP + 1)
    const frames = await open('/api/events?stream=work:a')
    expect(frames).toHaveLength(1)
    expect(frames[0]?.event).toBe('reset')
    expect(JSON.parse(frames[0]?.data ?? '')).toMatchObject({ reason: 'backlog' })
  })

  it('a backlog at the cap is served, not reset', async () => {
    seed('work:a', EVENT_BACKLOG_CAP)
    const frames = await open('/api/events?stream=work:a')
    expect(frames.some((frame) => frame.event === 'reset')).toBe(false)
    expect(frames).toHaveLength(EVENT_FLUSH_CAP)
  })

  it('resume from cursors repeats nothing', async () => {
    seed('work:a', 5)
    seed('work:b', 3)
    const first = await open('/api/events?stream=work:a,work:b&after=2,1')
    expect(first.map((frame) => frame.id)).toEqual([
      'work:a:3',
      'work:a:4',
      'work:a:5',
      'work:b:2',
      'work:b:3',
    ])
    seed('work:a', 2)
    const second = await open('/api/events?stream=work:a,work:b&after=5,3')
    expect(second.map((frame) => frame.id)).toEqual(['work:a:6', 'work:a:7'])
  })

  it('the classic single stream form keeps working', async () => {
    seed('work:a', 3)
    expect(seqs(await open('/api/events?stream=work:a&after=1'))).toEqual([2, 3])
  })

  it('a rebound Host is refused', async () => {
    seed('work:a', 1)
    const res = await app.inject({
      method: 'GET',
      url: '/api/events?stream=work:a',
      headers: { host: 'evil.example:8080' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.body).not.toContain('tick')
  })

  it('a real connection serves the whole backlog past one flush, in order', async () => {
    const count = EVENT_FLUSH_CAP * 3
    seed('work:a', count)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/api/events?stream=work:a`)
    const reader = res.body?.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline && framesOf(text).length <= count) {
      const { value, done } = (await reader?.read()) ?? { done: true, value: undefined }
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (framesOf(text).length >= count && text.endsWith('\n\n')) break
    }
    await reader?.cancel()
    expect(seqs(framesOf(text))).toEqual(Array.from({ length: count }, (_, i) => i + 1))
  })

  it('a client that stops reading is not written to until it drains', async () => {
    // Enough bytes that the kernel's buffers fill long before the backlog is out.
    const body = { text: 'x'.repeat(64 * 1024) }
    seed('work:a', 500, () => body)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as AddressInfo
    let serverSocket: Socket | undefined
    app.server.once('connection', (socket) => {
      serverSocket = socket
    })
    const client = connect({ port, host: '127.0.0.1' })
    await new Promise((resolve) => client.once('connect', resolve))
    client.pause()
    client.write('GET /api/events?stream=work:a HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    // A writer that ignores the socket's answer holds the rest of the 32 MiB in memory here.
    expect(serverSocket?.writableLength).toBeLessThan(1024 * 1024)
    client.destroy()
  }, 30_000)
})
