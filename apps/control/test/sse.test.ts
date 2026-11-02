import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, seedProject, type TestApp } from './helpers/app'

let t: TestApp | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

interface SseEvent {
  id: number
  data: { seq: number; type: string }
}

/** Minimal SSE reader: collects events until `count` arrive, then aborts the connection. */
async function readEvents(
  url: string,
  cookie: string,
  count: number,
  lastEventId?: number,
): Promise<SseEvent[]> {
  const controller = new AbortController()
  const headers: Record<string, string> = { cookie }
  if (lastEventId !== undefined) headers['last-event-id'] = String(lastEventId)
  const res = await fetch(url, { headers, signal: controller.signal })
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const events: SseEvent[] = []
  let buffer = ''
  const timeout = setTimeout(() => controller.abort(), 5_000)
  try {
    while (events.length < count) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx = buffer.indexOf('\n\n')
      while (idx !== -1) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const id = /^id: (\d+)$/m.exec(block)
        const data = /^data: (.*)$/m.exec(block)
        if (id && data) events.push({ id: Number(id[1]), data: JSON.parse(data[1]!) })
        idx = buffer.indexOf('\n\n')
      }
    }
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
  return events
}

describe('project event stream (SSE)', () => {
  it('replays history, delivers live events, and resumes from Last-Event-ID without gaps or duplicates', async () => {
    t = await createTestApp()
    const s = await seedProject(t)
    const address = await t.app.listen({ host: '127.0.0.1', port: 0 })
    const url = `${address}/api/projects/${s.project.id}/events`

    const [{ n: initial }] = (await t.db.sql`
      select count(*)::int as n from events where stream = ${`project:${s.project.id}`}
    `) as unknown as [{ n: number }]
    expect(initial).toBeGreaterThan(0)

    // History, then a live event while connected.
    const live = readEvents(url, s.admin.cookie, initial + 1)
    await new Promise((r) => setTimeout(r, 200))
    await s.admin.post(`/api/projects/${s.project.id}/members`, { login: 'lee', role: 'viewer' })
    const first = await live
    expect(first.map((e) => e.id)).toEqual(Array.from({ length: initial + 1 }, (_, i) => i + 1))
    expect(first.at(-1)!.data.type).toBe('project.member_set')

    // Disconnected: three more events happen, then the browser reconnects with its cursor.
    for (const login of ['ana', 'bo', 'cy']) {
      await s.admin.post(`/api/projects/${s.project.id}/members`, { login, role: 'viewer' })
    }
    const resumed = await readEvents(url, s.admin.cookie, 3, first.at(-1)!.id)
    expect(resumed.map((e) => e.id)).toEqual([initial + 2, initial + 3, initial + 4])
  })

  it('ends open streams on shutdown so a restart is not blocked', async () => {
    t = await createTestApp()
    const s = await seedProject(t)
    const address = await t.app.listen({ host: '127.0.0.1', port: 0 })
    const res = await fetch(`${address}/api/projects/${s.project.id}/events`, {
      headers: { cookie: s.admin.cookie },
    })
    expect(res.status).toBe(200)
    const started = Date.now()
    await t.app.close()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('refuses non-members', async () => {
    t = await createTestApp()
    const s = await seedProject(t)
    const outsider = await t.login('olga')
    const res = await outsider.get(`/api/projects/${s.project.id}/events`)
    expect(res.statusCode).toBe(403)
  })
})
