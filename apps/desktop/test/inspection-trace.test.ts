import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HealthBoard, HealthClaim, HealthName, Json, StoreDoc } from '@mec/contracts'
import { InspectionReads, MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server'

/**
 * Canonical inspection, stage 2 (M3.1): trace access. Real `buildServer`, real `SqliteStore`, and
 * records in the shapes M2.1 to M2.3 write them: `head_sha`, `check/<attempt>/<name>`,
 * `report/<attempt>/<n>`, `delivery/<work>`.
 */

const AT = '2026-11-05T12:00:00.000Z'
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const MIB = 1024 * 1024

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
let scratch: string
let worktree: string

const CLIENT = { 'x-mec-client': '1' }

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
  scratch = mkdtempSync(join(tmpdir(), 'mec-trace-'))
  worktree = join(scratch, 'work', 'att_1')
  mkdirSync(join(worktree, 'src'), { recursive: true })
  mkdirSync(join(worktree, '.mec'), { recursive: true })
  seedRecords()
})

afterEach(async () => {
  await app.close()
  db.close()
  rmSync(scratch, { recursive: true, force: true })
})

const save = (repo: 'engines' | 'attempts' | 'tasks' | 'workItems', doc: StoreDoc): void => {
  store.atomic(() => store[repo].save(doc))
}

/** One finished attempt, written the way the runner and `StoreFacts` write it. */
function seedRecords(): void {
  save('engines', { id: 'repo_a', url: 'https://github.com/acme/alpha.git', bootstrap: [], checks: [] })
  save('workItems', { id: 'wi_1', repoId: 'repo_a', state: 'executing', createdAt: AT, updatedAt: AT })
  save('tasks', {
    id: 'task_1',
    workItemId: 'wi_1',
    repoId: 'repo_a',
    localKey: 'task_1',
    objective: 'Do it',
    status: 'done',
    role: 'implementer',
    dependsOn: [],
    modelRequest: { tier: 'strong' },
  })
  save('attempts', {
    id: 'att_1',
    taskId: 'task_1',
    workItemId: 'wi_1',
    slotId: 'slot_1',
    state: 'succeeded',
    generation: 1,
    engine: 'claude',
    role: 'implementer',
    worktree,
    base_sha: OLD,
    head_sha: HEAD,
    resolved_model: 'claude-opus-4-1',
    usage: { type: 'usage', input_tokens: 1, output_tokens: 1, cost_usd: 0.5 },
    exit_code: 0,
    exit_reason: 'completed',
    reports: 1,
    checks: ['unit'],
    createdAt: AT,
    updatedAt: AT,
  })
  save('engines', {
    id: 'check/att_1/unit',
    attemptId: 'att_1',
    name: 'unit',
    status: 'failed',
    exit_code: 1,
    duration_ms: 10,
    log_tail: `boom ${KEY}`,
    sha: HEAD,
    at: AT,
  })
  save('engines', {
    id: 'check/att_1/stale',
    attemptId: 'att_1',
    name: 'stale',
    status: 'passed',
    exit_code: 0,
    duration_ms: 10,
    log_tail: '',
    sha: OLD,
    at: AT,
  })
}

const event = (seq: number, type: string, body: Json, stream = 'attempt:att_1'): void => {
  store.atomic(() => store.events.append(stream, { stream, seq, at: AT, type, body }))
}

const get = async (url: string, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method: 'GET', url, headers })
  return { status: res.statusCode, body: res.body, headers: res.headers, json: () => res.json() as any }
}

const artifact = (ref: string, extra = '') =>
  get(`/api/inspect/artifacts?attemptId=att_1&ref=${encodeURIComponent(ref)}${extra}`)

describe('the read gate', () => {
  const ROUTES = [
    '/api/inspect/snapshot',
    '/api/inspect/work',
    '/api/inspect/work/wi_1',
    '/api/inspect/tasks/task_1',
    '/api/inspect/needs',
    '/api/inspect/search?q=x',
    '/api/inspect/attempts/att_1/activity',
    '/api/inspect/artifacts?attemptId=att_1&ref=a.txt',
  ]

  it('rebound Host is refused', async () => {
    for (const url of ROUTES) {
      const res = await get(url, { host: 'evil.example:4173', ...CLIENT })
      expect(res.status, url).toBe(403)
      expect(res.json().error).toBe('forbidden_host')
    }
  })

  it('a loopback-looking name is not loopback', async () => {
    for (const host of ['127.0.0.1.evil.example', 'localhost.evil.example', '0.0.0.0:80']) {
      expect((await get('/api/inspect/work', { host })).status, host).toBe(403)
    }
  })

  it('every loopback spelling is served', async () => {
    for (const host of ['localhost', 'localhost:8080', '127.0.0.1:8080', '[::1]:8080', 'LOCALHOST:1']) {
      expect((await get('/api/inspect/work', { host })).status, host).toBe(200)
    }
  })

  it('browser read without the client header is refused', async () => {
    const browsers: Record<string, string>[] = [
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-mode': 'cors' },
      { origin: 'http://127.0.0.1:4173' },
      { referer: 'http://127.0.0.1:4173/' },
      { 'user-agent': 'Mozilla/5.0 (Macintosh)' },
    ]
    for (const headers of browsers) {
      for (const url of ROUTES) {
        const res = await get(url, headers)
        expect(res.status, `${url} ${JSON.stringify(headers)}`).toBe(403)
        expect(res.json().error).toBe('client_header_required')
      }
    }
  })

  it('a browser with the client header reads, and so does a plain tool', async () => {
    expect((await get('/api/inspect/work', { 'sec-fetch-site': 'same-origin', ...CLIENT })).status).toBe(200)
    expect((await get('/api/inspect/work', { 'user-agent': 'curl/8.7.1' })).status).toBe(200)
  })
})

describe('evidence from the records M2 wrote', () => {
  it('attempts carry the pinned facts, and requested and actual stay apart', async () => {
    const task = (await get('/api/inspect/tasks/task_1')).json()
    expect(task.attempts[0]).toMatchObject({
      id: 'att_1',
      state: 'succeeded',
      role: 'implementer',
      requested: { tier: 'strong', model: null },
      actual: { model: 'claude-opus-4-1', engine: 'claude' },
      baseSha: OLD,
      headSha: HEAD,
      processOutcome: 'completed',
    })
  })

  it('a model chosen for a queued attempt is not yet what ran', async () => {
    const att = store.attempts.get('att_1') as StoreDoc
    const { engine: _engine, ...queued } = att
    save('attempts', { ...queued, state: 'queued' })
    expect((await get('/api/inspect/tasks/task_1')).json().attempts[0].actual.model).toBeNull()
  })

  it('checks come from the check records on the exact head, redacted', async () => {
    const task = (await get('/api/inspect/tasks/task_1')).json()
    expect(task.checks.headSha).toBe(HEAD)
    expect(task.checks.results.map((c: any) => [c.name, c.state])).toEqual([['unit', 'failed']])
    expect(task.checks.results[0].detail).toContain('boom')
    expect(JSON.stringify(task)).not.toContain(KEY)
    expect(task.coverage.checks).toBe(true)
    expect(task.coverage.reports).toBe(true)
    expect(task.coverage.usage).toBe(true)
  })

  it('an errored check reads failed, not not-run', async () => {
    save('engines', { ...(store.engines.get('check/att_1/unit') as StoreDoc), status: 'error' })
    const task = (await get('/api/inspect/tasks/task_1')).json()
    expect(task.checks.results[0].state).toBe('failed')
  })

  it('skipped checks say so instead of looking clean', async () => {
    // Check records from another head are as good as none on this one.
    save('engines', { ...(store.engines.get('check/att_1/unit') as StoreDoc), sha: OLD })
    const { checks: _checks, ...attempt } = store.attempts.get('att_1') as StoreDoc
    save('attempts', { ...attempt, checks_note: 'no checks are registered for this repository' })
    const task = (await get('/api/inspect/tasks/task_1')).json()
    expect(task.checks.results).toEqual([
      {
        name: 'checks',
        state: 'not-run',
        headSha: HEAD,
        detail: 'no checks are registered for this repository',
        artifactRef: null,
      },
    ])
    expect(task.coverage.checks).toBe(false)
  })

  it('no diff is recorded by M2, so the diff stays empty and uncovered', async () => {
    const task = (await get('/api/inspect/tasks/task_1')).json()
    expect(task.diff).toEqual({ headSha: null, summary: null, files: [], truncated: 0 })
    expect(task.coverage.diff).toBe(false)
  })

  it('no delegation is recorded by M2, so nothing is inferred', async () => {
    expect((await get('/api/inspect/work/wi_1')).json().delegation).toEqual([])
  })

  it('usage is summed from the stream, and a gap is a labelled subtotal', async () => {
    event(1, 'usage', { type: 'usage', input_tokens: 1, output_tokens: 1, cost_usd: 0.25 })
    event(2, 'usage', { type: 'usage', input_tokens: 2, output_tokens: 2, cost_usd: 0.5 })
    let usage = (await get('/api/inspect/tasks/task_1')).json().usage
    expect(usage).toMatchObject({ reportedUsd: 0.5, missingAttempts: 0, coverage: 'total' })
    event(3, 'usage', { type: 'usage', input_tokens: 3, output_tokens: 3 })
    usage = (await get('/api/inspect/tasks/task_1')).json().usage
    expect(usage).toMatchObject({ reportedUsd: 0.5, coverage: 'subtotal' })
  })

  it('the billing mode is read from the slot', async () => {
    save('engines', { id: 'x', note: 'unrelated' })
    store.atomic(() => store.slots.save({ id: 'slot_1', kind: 'claude-sub', label: 'Max' } as never))
    let task = (await get('/api/inspect/tasks/task_1')).json()
    expect(task.usage.mode).toBe('subscription')
    expect(task.attempts[0].actual.slotLabel).toBe('Max')
    store.atomic(() => store.slots.save({ id: 'slot_1', kind: 'claude-api', label: 'API' } as never))
    task = (await get('/api/inspect/tasks/task_1')).json()
    expect(task.usage.mode).toBe('api')
  })

  it.each([
    ['local_complete', 'local-complete'],
    ['moved', 'local-complete'],
    ['push_card', 'awaiting-push'],
    ['pushed', 'awaiting-pr'],
    ['pr_card', 'awaiting-pr'],
    ['pr_open', 'pr-open'],
    ['ready', 'pr-ready'],
    ['merged', 'merged'],
    ['no_change', 'none'],
    ['dropped', 'none'],
    ['closed', 'none'],
    ['declined', 'local-complete'],
    ['failed', 'local-complete'],
  ])('delivery stage %s reads %s', async (stored, wire) => {
    save('engines', {
      id: 'delivery/wi_1',
      workItemId: 'wi_1',
      stage: stored,
      head: HEAD,
      branch: 'mec/1/integration',
      prNumber: 12,
    })
    const work = (await get('/api/inspect/work/wi_1')).json()
    expect(work.delivery).toMatchObject({
      stage: wire,
      branch: 'mec/1/integration',
      headSha: HEAD,
      prNumber: 12,
    })
    expect(work.coverage.delivery).toBe(true)
  })

  it('a merged delivery record ends the item as merged', async () => {
    save('engines', { id: 'delivery/wi_1', workItemId: 'wi_1', stage: 'merged', head: HEAD })
    save('workItems', {
      ...(store.workItems.get('wi_1') as StoreDoc),
      state: 'done',
    })
    expect((await get('/api/inspect/work')).json().items[0].stage.label).toBe('Merged')
  })

  it('a clean exit with a failed check is not delivered on any route', async () => {
    const task = (await get('/api/inspect/tasks/task_1')).json()
    const work = (await get('/api/inspect/work/wi_1')).json()
    expect(task.attempts[0].processOutcome).toBe('completed')
    expect(task.outcome).toEqual({ process: 'completed', validation: 'failed', delivery: 'not-delivered' })
    expect(work.delivery.stage).toBe('none')
    save('engines', { id: 'delivery/wi_1', workItemId: 'wi_1', stage: 'merged', head: HEAD })
    const after = (await get('/api/inspect/tasks/task_1')).json()
    expect(after.outcome.delivery).toBe('not-delivered')
  })

  it('search finds a delivery reference and a sha in the merged shapes', async () => {
    save('engines', {
      id: 'delivery/wi_1',
      workItemId: 'wi_1',
      repoId: 'repo_a',
      stage: 'pr_open',
      head: HEAD,
      prNumber: 12,
      prUrl: 'https://github.com/acme/alpha/pull/12',
    })
    const find = async (q: string) =>
      (await get(`/api/inspect/search?q=${encodeURIComponent(q)}`))
        .json()
        .items.map((h: any) => `${h.kind}:${h.id}`)
    expect(await find('#12')).toContain('reference:wi_1')
    expect(await find('https://github.com/acme/alpha/pull/12')).toContain('reference:wi_1')
    expect(await find('#13')).not.toContain('reference:wi_1')
    expect(await find(HEAD.slice(0, 12))).toEqual(
      expect.arrayContaining(['reference:att_1', 'reference:wi_1']),
    )
  })
})

describe('activity pages', () => {
  it('activity drops an unknown event type', async () => {
    event(1, 'message', { type: 'message', role: 'assistant', text: 'hello' })
    event(2, 'attempt.turn_ended', { generation: 1 })
    event(3, 'thinking', { text: 'private reasoning' })
    event(4, 'exit', { type: 'exit', code: 0, terminal_reason: 'completed' })
    const page = (await get('/api/inspect/attempts/att_1/activity')).json()
    expect(page.items.map((i: any) => [i.seq, i.type])).toEqual([
      [1, 'message'],
      [4, 'exit'],
    ])
    expect(JSON.stringify(page)).not.toContain('private reasoning')
  })

  it('every allow-listed type reads as a line', async () => {
    const bodies: [string, Json][] = [
      ['message', { role: 'assistant', text: 'first line\nsecond line' }],
      ['tool_call', { tool: 'Read', input: { path: 'a' }, ok: false }],
      ['permission_request', { request_id: 'r', operation: { kind: 'bash' } }],
      ['permission_result', { request_id: 'r', decision: { allow: true } }],
      ['usage', { input_tokens: 1, output_tokens: 2 }],
      ['rate_limit', { window: 'five_hour', status: 'rejected' }],
      ['report', { report: { kind: 'ready', summary: 'done' } }],
      ['error', { class: 'quota', detail: 'over' }],
      ['exit', { code: 3, terminal_reason: 'crashed' }],
      ['session_started', { engine: 'claude', engine_version: '2.1.317' }],
    ]
    bodies.forEach(([type, body], i) => {
      event(i + 1, type, { type, ...(body as object) })
    })
    const page = (await get('/api/inspect/attempts/att_1/activity')).json()
    expect(page.items.map((i: any) => i.type)).toEqual(bodies.map(([type]) => type))
    const summary = (type: string) => page.items.find((i: any) => i.type === type).summary
    expect(summary('message')).toBe('assistant: first line')
    expect(summary('tool_call')).toBe('Read failed')
    expect(summary('usage')).toBe('1 in, 2 out')
    expect(summary('rate_limit')).toBe('five_hour rejected')
    expect(summary('report')).toBe('ready: done')
    expect(summary('error')).toBe('quota: over')
    expect(summary('exit')).toBe('Exit 3: crashed')
    expect(summary('session_started')).toBe('Started claude 2.1.317')
  })

  it('activity is redacted', async () => {
    event(1, 'tool_call', { type: 'tool_call', tool: 'Bash', input: { command: `echo ${KEY}` } })
    event(2, 'message', { type: 'message', role: 'assistant', text: `my key is ${KEY}` })
    const res = await get('/api/inspect/attempts/att_1/activity')
    expect(res.body).not.toContain(KEY)
    expect(res.json().items[1].summary).toContain('[redacted:')
  })

  it('pages by cursor with no gap and no repeat', async () => {
    for (let seq = 1; seq <= 7; seq += 1) {
      event(seq, 'message', { type: 'message', role: 'assistant', text: `m${seq}` })
    }
    const seen: number[] = []
    let cursor: string | null = null
    do {
      const query: string = cursor === null ? '' : `&cursor=${cursor}`
      const page: any = (await get(`/api/inspect/attempts/att_1/activity?limit=3${query}`)).json()
      seen.push(...page.items.map((i: any) => i.seq))
      cursor = page.nextCursor
    } while (cursor !== null)
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('an unknown attempt is 404 and a bad cursor is 400', async () => {
    expect((await get('/api/inspect/attempts/att_none/activity')).status).toBe(404)
    expect((await get('/api/inspect/attempts/att_1/activity?cursor=%%%')).status).toBe(400)
  })

  it('a huge body is cut and the page stays under the ceiling', async () => {
    const wide = 'é'.repeat(3 * MIB)
    for (let seq = 1; seq <= 3; seq += 1) {
      event(seq, 'message', { type: 'message', role: 'assistant', text: wide })
    }
    const res = await get('/api/inspect/attempts/att_1/activity?limit=100')
    expect(res.status).toBe(200)
    expect(Buffer.byteLength(res.body)).toBeLessThanOrEqual(MIB)
  })
})

describe('artifacts', () => {
  it('artifact path escape is refused', async () => {
    writeFileSync(join(scratch, 'secret.txt'), 'outside')
    writeFileSync(join(worktree, 'ok.txt'), 'inside')
    symlinkSync(join(scratch, 'secret.txt'), join(worktree, 'link.txt'))
    symlinkSync(scratch, join(worktree, 'linkdir'))
    expect((await artifact('ok.txt')).status).toBe(200)
    for (const ref of [
      '../../secret.txt',
      'src/../../../secret.txt',
      join(scratch, 'secret.txt'),
      '/etc/hosts',
      'link.txt',
      'linkdir/secret.txt',
    ]) {
      const res = await artifact(ref)
      expect(res.status, ref).toBeGreaterThanOrEqual(400)
      expect(res.body, ref).not.toContain('outside')
    }
  })

  it('the control directories are refused, through a symlink too', async () => {
    writeFileSync(join(worktree, '.mec', 'mcp.json'), 'token')
    writeFileSync(join(worktree, '.git'), 'gitdir: x')
    symlinkSync(join(worktree, '.mec', 'mcp.json'), join(worktree, 'inner.txt'))
    for (const ref of ['.mec/mcp.json', '.git', 'inner.txt', 'src/../.mec/mcp.json']) {
      const res = await artifact(ref)
      expect(res.status, ref).toBeGreaterThanOrEqual(400)
      expect(res.body, ref).not.toContain('token')
    }
  })

  it('a directory, a missing file and a missing root are refused', async () => {
    expect((await artifact('src')).status).toBe(404)
    expect((await artifact('none.txt')).status).toBe(404)
    rmSync(worktree, { recursive: true })
    expect((await artifact('none.txt')).status).toBe(404)
  })

  it('an unknown attempt and a bad request are refused', async () => {
    expect((await get('/api/inspect/artifacts?attemptId=att_none&ref=a')).status).toBe(404)
    expect((await get('/api/inspect/artifacts?attemptId=att_1')).status).toBe(400)
    expect((await get('/api/inspect/artifacts?ref=a')).status).toBe(400)
    expect((await artifact('a.txt', '&cursor=%%%')).status).toBe(400)
  })

  it('an attempt with no worktree has no artifacts', async () => {
    const { worktree: _worktree, ...attempt } = store.attempts.get('att_1') as StoreDoc
    save('attempts', attempt)
    expect((await artifact('a.txt')).status).toBe(404)
  })

  it('html artifact is served as text', async () => {
    writeFileSync(join(worktree, 'page.html'), '<script>alert(1)</script>')
    const res = await artifact('page.html')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.body).toBe('<script>alert(1)</script>')
  })

  it('an artifact is redacted on read', async () => {
    writeFileSync(join(worktree, 'log.txt'), `line ${KEY} end`)
    const res = await artifact('log.txt')
    expect(res.body).not.toContain(KEY)
    expect(res.body).toContain('end')
  })

  it('oversized artifact is paged', async () => {
    const size = 2 * MIB + 5
    writeFileSync(join(worktree, 'big.txt'), 'a'.repeat(size))
    let served = 0
    let pages = 0
    let cursor: string | null = null
    do {
      const res: any = await artifact('big.txt', cursor === null ? '' : `&cursor=${cursor}`)
      expect(res.status).toBe(200)
      expect(Buffer.byteLength(res.body)).toBeLessThanOrEqual(MIB)
      expect(res.headers['x-mec-artifact-size']).toBe(String(size))
      served += res.body.length
      pages += 1
      cursor = (res.headers['x-mec-next-cursor'] as string | undefined) ?? null
    } while (cursor !== null)
    expect(served).toBe(size)
    expect(pages).toBe(3)
  })

  it('a key across a page boundary is not split into two harmless halves', async () => {
    const pad = 'a '.repeat(MIB / 2 - 10)
    writeFileSync(join(worktree, 'edge.txt'), `${pad} ${KEY} tail`)
    const first = await artifact('edge.txt')
    const next = first.headers['x-mec-next-cursor'] as string
    const second = await artifact('edge.txt', `&cursor=${next}`)
    const whole = first.body + second.body
    expect(whole).not.toContain('sk-ant-')
    expect(whole).toContain('[redacted:')
    expect(whole).toContain('tail')
  })

  it('a character across a page boundary stays whole', async () => {
    writeFileSync(join(worktree, 'wide.txt'), 'é'.repeat(MIB))
    const first = await artifact('wide.txt')
    expect(first.status).toBe(200)
    expect(first.body).not.toContain('�')
    const second = await artifact('wide.txt', `&cursor=${first.headers['x-mec-next-cursor']}`)
    expect(second.status).toBe(200)
    expect(second.body).not.toContain('�')
    expect(first.body.length + second.body.length).toBe(MIB)
  })

  it('a binary file returns metadata only', async () => {
    writeFileSync(join(worktree, 'a.bin'), Buffer.from([0x7f, 0x45, 0x00, 0x46, 0xff]))
    const res = await artifact('a.bin')
    expect(res.status).toBe(200)
    expect(res.json()).toEqual({ ref: 'a.bin', binary: true, size: 5 })
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('invalid text is treated as binary', async () => {
    writeFileSync(join(worktree, 'b.bin'), Buffer.from([0x68, 0x69, 0xff, 0xfe]))
    expect((await artifact('b.bin')).json().binary).toBe(true)
  })
})

describe('search and held rows', () => {
  it('search finds an attempt by id, within the repo filter', async () => {
    save('engines', { id: 'repo_b', url: '/Users/me/code/beta', bootstrap: [], checks: [] })
    const hits = (await get('/api/inspect/search?q=att_1')).json().items
    expect(hits).toContainEqual({
      kind: 'attempt',
      id: 'att_1',
      title: 'Attempt att_1',
      repoLabel: 'acme/alpha',
      workItemId: 'wi_1',
    })
    const elsewhere = (await get('/api/inspect/search?q=att_1&repoId=repo_b')).json().items
    expect(elsewhere.map((h: any) => h.kind)).not.toContain('attempt')
  })

  it('a wake row is not listed as a message', async () => {
    store.atomic(() => {
      store.messages.save({
        id: 'msg_wake_abc',
        text: 'question answered',
        createdAt: AT,
        workItemId: 'wi_1',
        repoId: 'repo_a',
      })
      store.messages.save({
        id: 'msg_1',
        text: 'which question answered this',
        createdAt: AT,
        repoId: 'repo_a',
      })
    })
    const find = async (q: string) =>
      (await get(`/api/inspect/search?q=${encodeURIComponent(q)}`)).json().items.map((h: any) => h.id)
    expect(await find('question answered')).toEqual(['msg_1'])
    expect(await find('msg_wake_abc')).toEqual([])
  })

  it('twenty wake rows do not push out the message a person wrote', async () => {
    store.atomic(() => {
      for (let i = 0; i < 25; i += 1) {
        store.messages.save({ id: `msg_wake_${i}`, text: 'question answered', createdAt: AT })
      }
      store.messages.save({ id: 'msg_1', text: 'question answered by hand', createdAt: AT })
    })
    const hits = (await get('/api/inspect/search?q=question')).json().items
    expect(hits.map((h: any) => h.id)).toEqual(['msg_1'])
  })

  it('a held row says when in words, not as a raw time', async () => {
    const at = new Date(2026, 10, 5, 9, 7, 0).toISOString()
    save('workItems', {
      ...(store.workItems.get('wi_1') as StoreDoc),
      hold: { reason: 'wait for design', at },
    })
    const row = (await get('/api/inspect/work')).json().items[0]
    expect(row.reason).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(row.reason).toMatch(/^Held by you since (5 Nov )?09:07: wait for design$/)
    // The structured field stays exact.
    expect((await get('/api/inspect/work/wi_1')).json().hold.since).toBe(at)
  })

  it('a hold on an earlier day names the day', async () => {
    const at = new Date(2026, 9, 30, 9, 7, 0).toISOString()
    save('workItems', { ...(store.workItems.get('wi_1') as StoreDoc), hold: { at } })
    expect((await get('/api/inspect/work')).json().items[0].reason).toBe('Held by you since 30 Oct 09:07')
  })

  it('a hold time that does not parse reads as unknown', async () => {
    save('workItems', { ...(store.workItems.get('wi_1') as StoreDoc), hold: { at: 'whenever' } })
    expect((await get('/api/inspect/work')).json().items[0].reason).toBe('Held by you since an unknown time')
  })
})
