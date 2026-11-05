import type { HealthBoard, HealthClaim, HealthName } from '@mec/contracts'
import { fakeBrain, MetaAgentService, type MetaDecision } from '@mec/meta'
import { InspectionReads, MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server'

/**
 * Canonical inspection, stage 1 (M3.1): bounded keyset reads over the existing schema, served
 * through the real `buildServer` over a real `SqliteStore`. Nothing here mocks its own unit.
 */

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

const plan = (...keys: [string, string[]][]): MetaDecision => ({
  ack: 'On it',
  plan: {
    tasks: keys.map(([taskId, dependsOn]) => ({
      taskId,
      objective: `Do ${taskId}`,
      dependsOn,
      role: 'implementer',
    })),
  },
})

beforeEach(() => {
  process.env.MEC_FAKE_ENGINE = '1'
  db = new Database(':memory:')
  migrate(db, MIGRATIONS_v1)
  store = new SqliteStore(db, { now: () => new Date(AT) })
  store.atomic(() => {
    store.engines.save({
      id: 'repo_a',
      url: 'https://github.com/acme/alpha.git',
      bootstrap: [],
      checks: [],
      trust: true,
    })
    store.engines.save({ id: 'repo_b', url: '/Users/me/code/beta', bootstrap: [], checks: [], trust: true })
  })
  app = serverWith()
})

afterEach(async () => {
  await app.close()
  db.close()
  delete process.env.MEC_FAKE_ENGINE
})

function serverWith(brain: MetaDecision = plan(['task_1', []])): ReturnType<typeof buildServer> {
  return buildServer({
    store,
    effects: store.effects,
    health: quietHealth,
    policyText: '{"preAuthorised":{}}',
    now: () => new Date(AT),
    inspection: new InspectionReads(db),
    metaAgent: new MetaAgentService({
      store,
      effects: store.effects,
      brain: fakeBrain(brain),
      now: () => AT,
      policyText: '{"preAuthorised":{}}',
    }),
  })
}

const get = async (url: string) => {
  const res = await app.inject({ method: 'GET', url })
  return { status: res.statusCode, body: res.body, json: () => res.json() as any }
}

const say = async (repoId: string | undefined, text: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/chat/messages',
    payload: { text, ...(repoId !== undefined && { repoId }) },
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { workItemId: string }).workItemId
}

const seedWork = (id: string, extra: Record<string, unknown> = {}): void => {
  store.atomic(() => {
    store.workItems.save({ id, state: 'executing', createdAt: AT, updatedAt: AT, ...extra })
  })
}

describe('inspection routes: scope and identity', () => {
  it("repo filter returns no other repository's row", async () => {
    const a = await say('repo_a', 'add alpha thing')
    const b = await say('repo_b', 'add beta thing')
    const onlyA = (await get('/api/inspect/work?repoId=repo_a')).json()
    expect(onlyA.items.map((r: any) => r.id)).toEqual([a])
    const onlyB = (await get('/api/inspect/work?repoId=repo_b')).json()
    expect(onlyB.items.map((r: any) => r.id)).toEqual([b])
    const all = (await get('/api/inspect/work')).json()
    expect(all.items.map((r: any) => r.id).sort()).toEqual([a, b].sort())
    expect((await get('/api/inspect/work?repoId=repo_nope')).status).toBe(400)
    expect((await get('/api/inspect/needs?repoId=repo_nope')).status).toBe(400)
    expect((await get('/api/inspect/search?q=x&repoId=repo_nope')).status).toBe(400)
    expect((await get('/api/inspect/snapshot?repoId=repo_nope')).status).toBe(400)
  })

  it('labels the repository from its registration', async () => {
    await say('repo_a', 'one')
    await say('repo_b', 'two')
    const rows = (await get('/api/inspect/work')).json().items
    expect(rows.find((r: any) => r.repoId === 'repo_a').repoLabel).toBe('acme/alpha')
    expect(rows.find((r: any) => r.repoId === 'repo_b').repoLabel).toBe('beta')
  })

  it('legacy work is Unassigned and read-only', async () => {
    seedWork('wi_old')
    await say('repo_a', 'new thing')
    const rows = (await get('/api/inspect/work')).json().items
    const old = rows.find((r: any) => r.id === 'wi_old')
    expect(old).toMatchObject({ repoId: null, repoLabel: null, readOnly: true })
    expect(rows.find((r: any) => r.repoId === 'repo_a').readOnly).toBe(false)
    expect((await get('/api/inspect/work?repoId=repo_a')).json().items.map((r: any) => r.id)).not.toContain(
      'wi_old',
    )
    expect((await get('/api/inspect/work/wi_old')).json()).toMatchObject({ repoId: null, readOnly: true })
  })

  it('reused local task keys stay separate in two repos', async () => {
    const a = await say('repo_a', 'a')
    const b = await say('repo_b', 'b')
    const detailA = (await get(`/api/inspect/work/${a}`)).json()
    const detailB = (await get(`/api/inspect/work/${b}`)).json()
    expect(detailA.tasks).toHaveLength(1)
    expect(detailB.tasks).toHaveLength(1)
    expect(detailA.tasks[0].localKey).toBe('task_1')
    expect(detailB.tasks[0].localKey).toBe('task_1')
    expect(detailA.tasks[0].id).not.toBe(detailB.tasks[0].id)
    const task = (await get(`/api/inspect/tasks/${detailA.tasks[0].id}`)).json()
    expect(task).toMatchObject({ workItemId: a, repoId: 'repo_a', objective: 'Do task_1' })
  })
})

describe('inspection routes: pages', () => {
  it('pages work by cursor with a limit and refuses a malformed one', async () => {
    for (let i = 1; i <= 7; i++) seedWork(`wi_${i}`, { repoId: 'repo_a' })
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page = (
        await get(`/api/inspect/work?limit=3${cursor === null ? '' : `&cursor=${cursor}`}`)
      ).json()
      expect(page.items.length).toBeLessThanOrEqual(3)
      expect(typeof page.observedAt).toBe('string')
      seen.push(...page.items.map((r: any) => r.id))
      cursor = page.nextCursor
    } while (cursor !== null)
    expect(seen).toEqual(['wi_1', 'wi_2', 'wi_3', 'wi_4', 'wi_5', 'wi_6', 'wi_7'])

    for (const bad of ['cursor=%25%25', 'cursor=e30', 'limit=0', 'limit=-1', 'limit=abc', 'limit=1.5']) {
      const res = await get(`/api/inspect/work?${bad}`)
      expect(res.status, bad).toBe(400)
    }
  })

  it('an over-large limit is held to the maximum of 100', async () => {
    for (let i = 1; i <= 105; i++) seedWork(`wi_${String(i).padStart(3, '0')}`)
    const page = (await get('/api/inspect/work?limit=5000')).json()
    expect(page.items).toHaveLength(100)
    expect(page.nextCursor).not.toBeNull()
    const defaults = (await get('/api/inspect/work')).json()
    expect(defaults.items).toHaveLength(50)
  })

  it('a response is at most 1 MiB and ends early with a valid cursor', async () => {
    for (let i = 1; i <= 40; i++) seedWork(`wi_${i}`, { padding: 'p'.repeat(60_000) })
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const res = await get(`/api/inspect/work?limit=100${cursor === null ? '' : `&cursor=${cursor}`}`)
      expect(res.body.length).toBeLessThanOrEqual(1024 * 1024)
      const page = res.json()
      seen.push(...page.items.map((r: any) => r.id))
      cursor = page.nextCursor
      pages += 1
    } while (cursor !== null)
    expect(pages).toBeGreaterThan(1)
    expect(seen).toEqual(Array.from({ length: 40 }, (_, i) => `wi_${i + 1}`))
  })
})

describe('inspection routes: honesty', () => {
  it('secret-shaped task text is redacted in every route', async () => {
    const padded = `${'a'.repeat(66)} ${KEY}`
    store.atomic(() => {
      store.messages.save({ id: 'msg_1', text: padded, createdAt: AT, workItemId: 'wi_s', repoId: 'repo_a' })
      store.workItems.save({
        id: 'wi_s',
        state: 'executing',
        repoId: 'repo_a',
        originMessageId: 'msg_1',
        hold: { reason: `wait ${KEY}`, at: AT },
        createdAt: AT,
        updatedAt: AT,
      })
      store.tasks.save({
        id: 'task_s',
        workItemId: 'wi_s',
        repoId: 'repo_a',
        localKey: 'k',
        objective: padded,
        status: 'ready',
        dependsOn: [],
        role: 'implementer',
      })
      store.engines.save({
        id: 'question/q_s',
        questionId: 'q_s',
        question: `which? ${KEY}`,
        options: [KEY, 'no'],
        workItemId: 'wi_s',
        status: 'open',
        askedAt: AT,
      })
      store.confirmations.save({
        id: 'conf_s',
        cls: `push ${KEY}`,
        status: 'pending',
        operationHash: 'h',
        createdAt: AT,
        expiresAt: '2999-01-01T00:00:00.000Z',
        workItemId: 'wi_s',
      })
    })
    const urls = [
      '/api/inspect/snapshot',
      '/api/inspect/work',
      '/api/inspect/work/wi_s',
      '/api/inspect/tasks/task_s',
      '/api/inspect/needs?recent=1',
      '/api/inspect/search?q=aaaa',
      '/api/inspect/search?q=which',
    ]
    for (const url of urls) {
      const res = await get(url)
      expect(res.status, url).toBe(200)
      expect(res.body, url).not.toContain('sk-ant')
      expect(res.body, url).not.toContain('AAAAAAAA')
    }
    const row = (await get('/api/inspect/work')).json().items[0]
    expect(row.title.length).toBeLessThanOrEqual(80 + '[redacted:anthropic]'.length)
    expect(row.title).toContain('[redacted:')
  })

  it('needsCount equals needs length', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    seedWork('wi_2', { repoId: 'repo_b' })
    store.atomic(() => {
      for (const [id, wi] of [
        ['q1', 'wi_1'],
        ['q2', 'wi_1'],
        ['q3', 'wi_2'],
      ] as const) {
        store.engines.save({
          id: `question/${id}`,
          questionId: id,
          question: id,
          options: [],
          workItemId: wi,
          status: 'open',
          askedAt: AT,
        })
      }
      store.engines.save({
        id: 'question/done',
        questionId: 'done',
        question: 'old',
        options: [],
        workItemId: 'wi_1',
        status: 'answered',
        answer: 'yes',
        askedAt: AT,
      })
      store.confirmations.save({
        id: 'conf_open',
        cls: 'install',
        status: 'pending',
        operationHash: 'h',
        createdAt: AT,
        expiresAt: '2999-01-01T00:00:00.000Z',
        workItemId: 'wi_1',
      })
      store.confirmations.save({
        id: 'conf_late',
        cls: 'install',
        status: 'pending',
        operationHash: 'h',
        createdAt: AT,
        expiresAt: '2000-01-01T00:00:00.000Z',
        workItemId: 'wi_1',
      })
      store.confirmations.save({
        id: 'conf_done',
        cls: 'install',
        status: 'approved',
        operationHash: 'h',
        createdAt: AT,
        expiresAt: '2999-01-01T00:00:00.000Z',
        workItemId: 'wi_1',
      })
    })
    for (const scope of ['', '?repoId=repo_a', '?repoId=repo_b']) {
      const needs = (await get(`/api/inspect/needs${scope}`)).json()
      const snapshot = (await get(`/api/inspect/snapshot${scope}`)).json()
      expect(snapshot.needsCount, scope).toBe(needs.items.length)
      expect(needs.items.every((i: any) => i.status === 'open' || i.status === 'pending')).toBe(true)
    }
    expect((await get('/api/inspect/needs?repoId=repo_a')).json().items).toHaveLength(3)
    expect((await get('/api/inspect/needs?repoId=repo_b')).json().items).toHaveLength(1)
    const snapshot = (await get('/api/inspect/snapshot')).json()
    expect(snapshot.needsCount).toBe(4)
    expect(snapshot.repositories.map((r: any) => [r.id, r.needsCount])).toEqual([
      ['repo_a', 3],
      ['repo_b', 1],
    ])
    // Recent adds the settled and the expired; they never count as needing you.
    const recent = (await get('/api/inspect/needs?recent=1')).json().items
    const statuses = recent.map((i: any) => i.status).sort()
    expect(statuses).toEqual(['answered', 'approved', 'expired', 'open', 'open', 'open', 'pending'].sort())
    expect((await get('/api/inspect/snapshot')).json().needsCount).toBe(4)
  })

  it('a card with no proven join has a null workItemId', async () => {
    seedWork('wi_1', { repoId: 'repo_a', branch: 'feat/x', mandate: { id: 'mand_1' } })
    seedWork('wi_2', { repoId: 'repo_a', branch: 'feat/y' })
    const future = '2999-01-01T00:00:00.000Z'
    store.atomic(() => {
      // A release card: payload names a repo and a branch that wi_1 also uses. Not a join.
      store.confirmations.save({
        id: 'conf_pr',
        cls: 'pr_create',
        status: 'pending',
        operationHash: 'h',
        createdAt: AT,
        expiresAt: future,
        payload: { repo: 'acme/alpha', branch: 'feat/x', title: 't', body: 'b' },
      })
      // A push card: payload carries a repoId, which attributes the repository but not the work.
      store.confirmations.save({
        id: 'conf_push',
        cls: 'push',
        status: 'pending',
        operationHash: 'h',
        createdAt: AT,
        expiresAt: future,
        payload: { repoId: 'repo_b', repo: 'me/beta', remoteUrl: 'https://x/y', branch: 'feat/y' },
      })
      store.confirmations.save({
        id: 'conf_field',
        cls: 'install',
        status: 'pending',
        operationHash: 'h',
        createdAt: AT,
        expiresAt: future,
        workItemId: 'wi_2',
      })
      store.confirmations.save({
        id: 'conf_mandate',
        cls: 'install',
        status: 'pending',
        operationHash: 'h',
        createdAt: AT,
        expiresAt: future,
        mandateId: 'mand_1',
      })
    })
    const items = (await get('/api/inspect/needs')).json().items
    const byId = Object.fromEntries(items.map((i: any) => [i.id, i]))
    expect(byId.conf_pr).toMatchObject({
      workItemId: null,
      repoId: null,
      repoLabel: 'acme/alpha',
      kind: 'card',
      detailPath: '/api/inbox/conf_pr/detail',
    })
    expect(byId.conf_push).toMatchObject({ workItemId: null, repoId: 'repo_b' })
    expect(byId.conf_field.workItemId).toBe('wi_2')
    expect(byId.conf_mandate.workItemId).toBe('wi_1')
    // Only a proven join puts a work item in the approval stage.
    const rows = Object.fromEntries((await get('/api/inspect/work')).json().items.map((r: any) => [r.id, r]))
    expect(rows.wi_1.stage).toMatchObject({ key: 'person/decision', label: 'Needs your approval' })
    expect(rows.wi_2.stage.key).toBe('person/decision')
    // A repo filter only shows a card the repository is proven for.
    const forA = (await get('/api/inspect/needs?repoId=repo_a'))
      .json()
      .items.map((i: any) => i.id)
      .sort()
    expect(forA).toEqual(['conf_field', 'conf_mandate'])
  })

  it('missing record is coverage false and not zero', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    store.atomic(() => {
      store.tasks.save({
        id: 'task_1',
        workItemId: 'wi_1',
        repoId: 'repo_a',
        localKey: 'k',
        objective: 'Do it',
        status: 'ready',
        dependsOn: [],
      })
    })
    const none = (await get('/api/inspect/tasks/task_1')).json()
    expect(none.coverage).toEqual({
      reports: false,
      checks: false,
      diff: false,
      activity: false,
      usage: false,
      delivery: false,
    })
    expect(none.usage).toEqual({ reportedUsd: null, missingAttempts: 0, mode: 'unknown' })
    expect(none.checks).toEqual({ headSha: null, results: [] })
    expect(none.diff).toEqual({ headSha: null, summary: null, files: [] })
    expect(none.attempts).toEqual([])
    const work = (await get('/api/inspect/work/wi_1')).json()
    expect(work.coverage.delivery).toBe(false)
    expect(work.delivery).toEqual({ stage: 'none', branch: null, headSha: null, prNumber: null, prUrl: null })
    expect(work.delegation).toEqual([])

    store.atomic(() => {
      store.attempts.save({
        id: 'att_1',
        taskId: 'task_1',
        workItemId: 'wi_1',
        state: 'running',
        generation: 1,
        engine: 'claude',
        headSha: 'abc1234',
        baseSha: 'def5678',
        costUsd: 0.5,
        checks: [
          { name: 'unit', state: 'passed', headSha: 'abc1234' },
          { name: 'lint', state: 'passed', headSha: 'oldoldold' },
        ],
      })
      store.attempts.save({
        id: 'att_2',
        taskId: 'task_1',
        workItemId: 'wi_1',
        state: 'running',
        generation: 2,
      })
    })
    const some = (await get('/api/inspect/tasks/task_1')).json()
    expect(some.coverage.usage).toBe(true)
    expect(some.coverage.checks).toBe(true)
    expect(some.usage.reportedUsd).toBe(0.5)
    expect(some.usage.missingAttempts).toBe(1)
    expect(some.attemptCount).toBe(2)
    expect(some.attempts.map((a: any) => a.id)).toEqual(['att_1', 'att_2'])
    expect(some.attempts[0]).toMatchObject({
      generation: 1,
      baseSha: 'def5678',
      headSha: 'abc1234',
      processOutcome: 'unknown',
    })
    expect(some.attempts[0].actual).toMatchObject({ engine: 'claude', model: null })
    // Checks belong to the exact head they ran on; the stale one is not carried over.
    expect(some.checks.headSha).toBe('abc1234')
    expect(some.checks.results.map((c: any) => c.name)).toEqual(['unit'])
  })
})

describe('inspection routes: stage', () => {
  it('computes one stage from facts and shows the outcome of an ended item', async () => {
    seedWork('wi_open', { repoId: 'repo_a' })
    seedWork('wi_q', { repoId: 'repo_a' })
    seedWork('wi_hold', { repoId: 'repo_a', hold: { reason: 'wait for design', at: AT } })
    seedWork('wi_lifted', { repoId: 'repo_a', hold: { reason: 'x', at: AT, liftedAt: AT } })
    seedWork('wi_blocked', { repoId: 'repo_a', state: 'blocked', blockedReason: 'dependency' })
    seedWork('wi_stop', { repoId: 'repo_a', state: 'stopped' })
    seedWork('wi_done', { repoId: 'repo_a', state: 'done', delivery: { stage: 'merged', prNumber: 7 } })
    store.atomic(() => {
      store.engines.save({
        id: 'question/q',
        questionId: 'q',
        question: 'which one?',
        options: ['a', 'b'],
        workItemId: 'wi_q',
        status: 'open',
        askedAt: AT,
      })
    })
    const rows = Object.fromEntries((await get('/api/inspect/work')).json().items.map((r: any) => [r.id, r]))
    expect(rows.wi_open.stage).toEqual({ key: 'working', label: 'Working', waitingOn: 'none' })
    expect(rows.wi_q.stage).toEqual({
      key: 'person/decision',
      label: 'Needs your answer',
      waitingOn: 'person',
    })
    expect(rows.wi_q.nextAction).toBeTruthy()
    expect(rows.wi_q.reason).toMatch(/question/i)
    expect(rows.wi_hold.stage.key).toBe('held')
    expect(rows.wi_hold.reason).toContain('wait for design')
    expect(rows.wi_lifted.stage.key).toBe('working')
    expect(rows.wi_blocked.stage.key).toBe('person/blocked')
    expect(rows.wi_stop.stage.label).toBe('Stopped by you')
    expect(rows.wi_done.stage.label).toBe('Merged')
    expect(rows.wi_done.nextAction).toBeNull()
  })

  it('an attempt parked on quota shows the reset time', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    const reset = new Date(2026, 10, 5, 16, 30, 0)
    store.atomic(() => {
      store.attempts.save({
        id: 'att_1',
        workItemId: 'wi_1',
        taskId: 't',
        state: 'quota_wait',
        resetsAt: reset.toISOString(),
      })
    })
    const row = (await get('/api/inspect/work')).json().items[0]
    expect(row.stage).toMatchObject({
      key: 'waiting/quota',
      label: 'Waiting for quota (resets 16:30)',
      waitingOn: 'system',
    })
  })
})

describe('inspection routes: titles, counts, details, search, snapshot', () => {
  it('serves a stored title, else the first line of the origin message cut to 80, else null', async () => {
    store.atomic(() => {
      store.messages.save({ id: 'msg_1', text: `\n  Add audit log viewing\nmore detail`, createdAt: AT })
      store.messages.save({ id: 'msg_2', text: 'y'.repeat(200), createdAt: AT })
    })
    seedWork('wi_titled', { title: 'Stored title', originMessageId: 'msg_1' })
    seedWork('wi_msg', { originMessageId: 'msg_1' })
    seedWork('wi_long', { originMessageId: 'msg_2' })
    seedWork('wi_none')
    const rows = Object.fromEntries((await get('/api/inspect/work')).json().items.map((r: any) => [r.id, r]))
    expect(rows.wi_titled.title).toBe('Stored title')
    expect(rows.wi_msg.title).toBe('Add audit log viewing')
    expect(rows.wi_long.title).toHaveLength(80)
    expect(rows.wi_none.title).toBeNull()
  })

  it('counts tasks by status and links tasks with their attempts and dependencies', async () => {
    seedWork('wi_1', {
      repoId: 'repo_a',
      planRevision: 2,
      originMessageId: 'msg_1',
      mandate: { originMessageId: 'msg_1' },
    })
    store.atomic(() => {
      store.messages.save({ id: 'msg_1', text: 'Build the thing\nin detail', createdAt: AT })
      store.tasks.save({
        id: 'task_a',
        workItemId: 'wi_1',
        localKey: 'a',
        objective: 'First\nsecond line',
        status: 'done',
        dependsOn: [],
        role: 'implementer',
        planRevision: 2,
      })
      store.tasks.save({
        id: 'task_b',
        workItemId: 'wi_1',
        localKey: 'b',
        objective: 'Second',
        status: 'ready',
        dependsOn: ['task_a'],
        role: 'code_reviewer',
        planRevision: 2,
      })
      store.tasks.save({
        id: 'task_c',
        workItemId: 'wi_1',
        localKey: 'c',
        objective: 'Third',
        status: 'ready',
        dependsOn: ['task_a'],
        role: 'implementer',
        planRevision: 1,
      })
      store.attempts.save({
        id: 'att_1',
        taskId: 'task_b',
        workItemId: 'wi_1',
        state: 'queued',
        generation: 1,
      })
    })
    const row = (await get('/api/inspect/work')).json().items[0]
    expect(row.taskCounts).toEqual({ total: 3, byStatus: { done: 1, ready: 2 } })
    const detail = (await get('/api/inspect/work/wi_1')).json()
    expect(detail).toMatchObject({
      originMessageId: 'msg_1',
      goal: 'Build the thing\nin detail',
      planRevision: 2,
      hold: null,
    })
    const b = detail.tasks.find((t: any) => t.id === 'task_b')
    expect(b).toMatchObject({
      localKey: 'b',
      title: 'Second',
      role: 'code_reviewer',
      status: 'ready',
      dependsOn: ['task_a'],
      planRevision: 2,
      attemptCount: 1,
    })
    expect(detail.tasks.find((t: any) => t.id === 'task_a').title).toBe('First')
    expect(Object.keys(detail.cursors)).toContain('work:wi_1')
    expect((await get('/api/inspect/work/wi_missing')).status).toBe(404)
    expect((await get('/api/inspect/tasks/task_missing')).status).toBe(404)
    // An id of another kind is not found here, not served as the wrong thing.
    expect((await get('/api/inspect/work/msg_1')).status).toBe(404)
    expect((await get('/api/inspect/tasks/wi_1')).status).toBe(404)
  })

  it('finds messages, work, tasks and references', async () => {
    seedWork('wi_1', {
      repoId: 'repo_a',
      originMessageId: 'msg_1',
      delivery: {
        stage: 'pr-open',
        prNumber: 12,
        prUrl: 'https://github.com/acme/alpha/pull/12',
        headSha: 'abcdef1234567890',
      },
    })
    store.atomic(() => {
      store.messages.save({
        id: 'msg_1',
        text: 'Fix the login redirect',
        createdAt: AT,
        workItemId: 'wi_1',
        repoId: 'repo_a',
      })
      store.messages.save({ id: 'msg_2', text: 'Unrelated', createdAt: AT, repoId: 'repo_b' })
      store.tasks.save({
        id: 'task_1',
        workItemId: 'wi_1',
        repoId: 'repo_a',
        localKey: 'login-fix',
        objective: 'Patch redirect',
        status: 'ready',
        dependsOn: [],
      })
      store.attempts.save({ id: 'att_1', taskId: 'task_1', workItemId: 'wi_1', headSha: 'abcdef1234567890' })
    })
    const find = async (q: string, extra = '') =>
      (await get(`/api/inspect/search?q=${encodeURIComponent(q)}${extra}`)).json()
    const login = await find('login')
    expect(login.items.map((h: any) => `${h.kind}:${h.id}`).sort()).toEqual([
      'message:msg_1',
      'task:task_1',
      'work:wi_1',
    ])
    expect(login.items.find((h: any) => h.kind === 'message')).toMatchObject({
      workItemId: 'wi_1',
      repoLabel: 'acme/alpha',
    })
    expect((await find('msg_2')).items.map((h: any) => `${h.kind}:${h.id}`)).toEqual(['message:msg_2'])
    expect((await find('login', '&repoId=repo_b')).items).toEqual([])
    expect((await find('#12')).items.map((h: any) => `${h.kind}:${h.id}`)).toEqual(['reference:wi_1'])
    expect((await find('https://github.com/acme/alpha/pull/12')).items.map((h: any) => h.id)).toEqual([
      'wi_1',
    ])
    expect((await find('abcdef1')).items.map((h: any) => `${h.kind}:${h.id}`).sort()).toEqual([
      'reference:att_1',
      'reference:wi_1',
    ])
    expect((await get('/api/inspect/search')).status).toBe(400)
    expect((await get(`/api/inspect/search?q=${'z'.repeat(300)}`)).status).toBe(400)
    // A wildcard is text, not a pattern.
    expect((await find('%')).items).toEqual([])
  })

  it('snapshot gives repositories, the needs count and cursors read together', async () => {
    const a = await say('repo_a', 'one')
    const snapshot = (await get('/api/inspect/snapshot')).json()
    expect(snapshot.repositories.map((r: any) => ({ id: r.id, label: r.label }))).toEqual([
      { id: 'repo_a', label: 'acme/alpha' },
      { id: 'repo_b', label: 'beta' },
    ])
    expect(snapshot.needsCount).toBe(0)
    expect(snapshot.cursors[`work:${a}`]).toBeGreaterThan(0)
    expect(typeof snapshot.observedAt).toBe('string')
    const one = (await get('/api/inspect/snapshot?repoId=repo_b')).json()
    expect(Object.keys(one.cursors).filter((k) => k.startsWith('work:'))).toEqual([])
  })

  it('leaves the existing routes unchanged', async () => {
    await say('repo_a', 'one')
    const work = (await get('/api/work')).json()
    expect(work[0]).toHaveProperty('taskCounts')
    expect(work[0]).toHaveProperty('stage')
    expect((await get('/api/inspect/nope')).status).toBe(404)
  })
})
