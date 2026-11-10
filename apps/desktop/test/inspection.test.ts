import type { HealthBoard, HealthClaim, HealthName, StoreDoc } from '@mec/contracts'
import { fakeBrain, MetaAgentService, type MetaDecision } from '@mec/meta'
import { InspectionReads, MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openPushCard } from '../src/release'
import { buildServer } from '../src/server'
import { ownerApproval, ownerHeaders } from './approval-rig'

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
    approval: ownerApproval(),
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
    headers: ownerHeaders,
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

/** The real card opener: only what git and gh would answer comes from here. */
const openPushCardFor = async (workItemId: string): Promise<string> => {
  const viewed = { url: 'https://github.com/acme/alpha', defaultBranchRef: { name: 'main' } }
  const card = await openPushCard(
    {
      store,
      effects: store.effects,
      now: () => new Date(AT),
      run: async () => ({ code: 0, stdout: JSON.stringify(viewed), stderr: '' }),
      git: async () => ({ code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }),
      pushSource: () => ({ gitDir: '/cache.git' }),
    },
    { repoId: 'repo_a', branch: 'mec/w/integration', workItemId },
  )
  return card.confirmationId
}

describe('the chat holds what was said (§12.7)', () => {
  it('a wake kept quiet stays off the chat, and a spoken one stays on', async () => {
    store.atomic(() => {
      const saved = { routing: 'new_work', createdAt: AT, repoId: 'repo_a', tasksCreated: 0 }
      store.messages.save({
        id: 'msg_wake_quiet',
        text: 'report ready',
        ackText: 'Noted.',
        quiet: true,
        ...saved,
      })
      store.messages.save({ id: 'msg_wake_spoken', text: 'report blocked', ackText: 'Blocked.', ...saved })
    })

    const ids = (await get('/api/chat/messages?repoId=repo_a')).json().map((row: any) => row.id)

    expect(ids).toEqual(['msg_wake_spoken'])
  })
})

describe('delivery cards reach their work (§10)', () => {
  it('a push card opened for work reads Needs your approval, and Needs you lists it there', async () => {
    seedWork('wi_1', { repoId: 'repo_a', state: 'integrating' })
    const opened = await openPushCardFor('wi_1')

    const row = (await get('/api/inspect/work?repoId=repo_a'))
      .json()
      .items.find((item: any) => item.id === 'wi_1')
    expect(row.stage).toMatchObject({ key: 'person/decision', label: 'Needs your approval' })
    const need = (await get('/api/inspect/needs?repoId=repo_a'))
      .json()
      .items.find((item: any) => item.id === opened)
    expect(need.workItemId).toBe('wi_1')
  })
})

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
    expect(row.title.length).toBeLessThanOrEqual(500 + '[redacted:anthropic]'.length)
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
    expect(none.usage).toEqual({
      reportedUsd: null,
      missingAttempts: 0,
      mode: 'unknown',
      coverage: 'unknown',
    })
    expect(none.checks).toEqual({ headSha: null, results: [], truncated: 0 })
    expect(none.diff).toEqual({ headSha: null, summary: null, files: [], truncated: 0 })
    expect(none.attempts).toEqual([])
    const work = (await get('/api/inspect/work/wi_1')).json()
    expect(work.coverage.delivery).toBe(false)
    expect(work.delivery).toEqual({ stage: 'none', branch: null, headSha: null, prNumber: null, prUrl: null })
    // A task nothing picked up is still listed: delegation says who holds it, and nobody does yet.
    expect(work.delegation).toMatchObject([{ taskId: 'task_1', latest: null, attempts: 0 }])

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

describe('inspection routes: a held group', () => {
  it('says on the attempt that its group is still there, and stops once it has gone', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    store.atomic(() => {
      store.tasks.save({ id: 'task_1', workItemId: 'wi_1', repoId: 'repo_a', status: 'blocked' })
      store.attempts.save({
        id: 'att_1',
        taskId: 'task_1',
        workItemId: 'wi_1',
        state: 'failed',
        generation: 1,
        terminal_reason: 'monitor_error: refused to die',
        held_groups: [{ pid: 4242, started: 'then' }],
      })
    })
    const held = (await get('/api/inspect/tasks/task_1')).json()
    expect(held.attempts[0].processOutcome).toBe(
      'monitor_error: refused to die (process group still running, capacity held)',
    )
    const { held_groups: _gone, ...rest } = store.attempts.get('att_1') as StoreDoc
    store.atomic(() => store.attempts.save(rest))
    const gone = (await get('/api/inspect/tasks/task_1')).json()
    expect(gone.attempts[0].processOutcome).toBe('monitor_error: refused to die')
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

  it('work whose every task ended says so and what to do, never Working (live, 10 November 2026)', async () => {
    const blockedReason =
      'every task ended with no result to deliver: task_1 was cancelled (attempt att_17 dropped it: nothing)'
    seedWork('wi_ended', { repoId: 'repo_a', state: 'blocked', blockedReason })
    const row = (await get('/api/inspect/work')).json().items[0]
    expect(row.stage).toEqual({ key: 'person/blocked', label: 'Blocked', waitingOn: 'person' })
    expect(row.reason).toContain('every task ended with no result to deliver')
    expect(row.nextAction).toBe('Stop this work and ask again')
  })

  it('a reset the park recorded reaches the stage', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    const reset = new Date(2026, 10, 5, 16, 30, 0)
    store.atomic(() => {
      store.attempts.save({
        id: 'att_1',
        workItemId: 'wi_1',
        taskId: 't',
        state: 'quota_wait',
        parked: { state: 'quota_wait', reason: 'rate limit', resets_at: reset.toISOString() },
      })
    })
    const row = (await get('/api/inspect/work')).json().items[0]
    expect(row.stage.label).toBe('Waiting for quota (resets 16:30)')
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

/** An agreement row counts as a need, and these tests count other things. */
const agreeTo = (...repoIds: string[]): void => {
  store.atomic(() => {
    for (const id of repoIds) {
      store.engines.save({ ...store.engines.get(id), id, hostRunAgreedAt: AT })
    }
  })
}

describe('inspection routes: titles, counts, details, search, snapshot', () => {
  it("serves a stored title, else the origin message's first line up to 500, else null", async () => {
    store.atomic(() => {
      store.messages.save({ id: 'msg_1', text: `\n  Add audit log viewing\nmore detail`, createdAt: AT })
      store.messages.save({ id: 'msg_2', text: 'y'.repeat(600), createdAt: AT })
      store.messages.save({ id: 'msg_3', text: `${'word '.repeat(30)}end`, createdAt: AT })
    })
    seedWork('wi_titled', { title: 'Stored title', originMessageId: 'msg_1' })
    seedWork('wi_msg', { originMessageId: 'msg_1' })
    seedWork('wi_long', { originMessageId: 'msg_2' })
    seedWork('wi_whole', { originMessageId: 'msg_3' })
    seedWork('wi_stored', { title: 'z'.repeat(120) })
    seedWork('wi_none')
    const rows = Object.fromEntries((await get('/api/inspect/work')).json().items.map((r: any) => [r.id, r]))
    expect(rows.wi_titled.title).toBe('Stored title')
    expect(rows.wi_msg.title).toBe('Add audit log viewing')
    expect(rows.wi_long.title).toHaveLength(500)
    expect(rows.wi_whole.title).toBe(`${'word '.repeat(30)}end`)
    expect(rows.wi_stored.title).toHaveLength(120)
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
    agreeTo('repo_a', 'repo_b')
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

describe('inspection routes: honest counts and bounded needs (fix wave)', () => {
  const seedQuestions = (n: number, workItemId: string, prefix: string, heavy = false): void => {
    store.atomic(() => {
      for (let i = 0; i < n; i++) {
        store.engines.save({
          id: `question/${prefix}${i}`,
          questionId: `${prefix}${i}`,
          question: heavy ? 'q'.repeat(2000) : `q ${i}`,
          options: heavy ? Array.from({ length: 20 }, () => 'o'.repeat(200)) : [],
          workItemId,
          status: 'open',
          askedAt: AT,
        })
      }
    })
  }

  it('needs is paged: 230 heavy open questions all arrive, each page under 1 MiB and 50 rows by default', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    seedQuestions(230, 'wi_1', 'h', true)
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const res = await get(`/api/inspect/needs${cursor === null ? '' : `?cursor=${cursor}`}`)
      expect(res.body.length).toBeLessThanOrEqual(1024 * 1024)
      const page = res.json()
      expect(page.items.length).toBeLessThanOrEqual(50)
      seen.push(...page.items.map((i: any) => i.id))
      cursor = page.nextCursor
      pages += 1
      expect(pages).toBeLessThanOrEqual(50)
    } while (cursor !== null)
    expect(pages).toBeGreaterThan(1)
    expect(new Set(seen).size).toBe(230)
    expect((await get('/api/inspect/snapshot')).json().needsCount).toBe(230)
    expect((await get('/api/inspect/needs?limit=1000')).json().items.length).toBeLessThanOrEqual(100)
    expect((await get('/api/inspect/needs?cursor=!!')).status).toBe(400)
  })

  it('a fresh question on another repository is not lost behind 235 older open ones', async () => {
    seedWork('wi_a', { repoId: 'repo_a' })
    seedWork('wi_late', { repoId: 'repo_b' })
    seedQuestions(235, 'wi_a', 'a')
    seedQuestions(1, 'wi_late', 'late')
    const beta = (await get('/api/inspect/needs?repoId=repo_b')).json()
    expect(beta.items.map((i: any) => i.id)).toEqual(['late0'])
    const snap = (await get('/api/inspect/snapshot')).json()
    expect(snap.needsCount).toBe(236)
    expect(snap.repositories.find((r: any) => r.id === 'repo_b').needsCount).toBe(1)
    const work = (await get('/api/inspect/work/wi_late')).json()
    expect(work.stage.key).toBe('person/decision')
  })

  it('200 expired pending cards do not hide a fresh one', async () => {
    seedWork('wi_fresh', { repoId: 'repo_a' })
    store.atomic(() => {
      for (let i = 0; i < 200; i++) {
        store.confirmations.save({
          id: `conf_old${i}`,
          cls: 'install',
          status: 'pending',
          operationHash: 'h',
          createdAt: AT,
          expiresAt: '2000-01-01T00:00:00.000Z',
          workItemId: 'wi_fresh',
        })
      }
      store.confirmations.save({
        id: 'conf_fresh',
        cls: 'install',
        status: 'pending',
        operationHash: 'h',
        createdAt: AT,
        expiresAt: '2999-01-01T00:00:00.000Z',
        workItemId: 'wi_fresh',
      })
    })
    expect((await get('/api/inspect/snapshot')).json().needsCount).toBe(1)
    expect((await get('/api/inspect/needs')).json().items.map((i: any) => i.id)).toEqual(['conf_fresh'])
    expect((await get('/api/inspect/work/wi_fresh')).json().stage.key).toBe('person/decision')
  })

  it("recent needs for a repository are not sliced away by other repositories' newer items", async () => {
    seedWork('wi_a', { repoId: 'repo_a' })
    seedWork('wi_b', { repoId: 'repo_b' })
    store.atomic(() => {
      store.engines.save({
        id: 'question/beta_old',
        questionId: 'beta_old',
        question: 'beta',
        options: [],
        workItemId: 'wi_b',
        status: 'answered',
        answer: 'yes',
        askedAt: AT,
      })
      for (let i = 0; i < 60; i++) {
        store.engines.save({
          id: `question/alpha${i}`,
          questionId: `alpha${i}`,
          question: 'alpha',
          options: [],
          workItemId: 'wi_a',
          status: 'answered',
          answer: 'yes',
          askedAt: AT,
        })
      }
    })
    const beta = (await get('/api/inspect/needs?repoId=repo_b&recent=1')).json()
    expect(beta.items.map((i: any) => i.id)).toEqual(['beta_old'])
  })

  it('a task with 20,000 diff files, checks and attempts answers under 1 MiB and says what it cut', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    const head = 'a'.repeat(40)
    store.atomic(() => {
      store.tasks.save({
        id: 'task_big',
        workItemId: 'wi_1',
        repoId: 'repo_a',
        localKey: 'k',
        objective: 'Do it',
        status: 'ready',
        dependsOn: [],
      })
      for (let g = 1; g <= 300; g++) {
        store.attempts.save({
          id: `att_${g}`,
          taskId: 'task_big',
          workItemId: 'wi_1',
          generation: g,
          state: 'done',
          ...(g === 300 && {
            headSha: head,
            diff: {
              summary: 's',
              files: Array.from({ length: 20_000 }, (_, i) => ({
                path: `src/dir${i}/${'f'.repeat(60)}.ts`,
                added: 1,
                removed: 1,
              })),
            },
            checks: Array.from({ length: 2_000 }, (_, i) => ({
              name: `check ${i}`,
              state: 'passed',
              headSha: head,
              detail: 'd'.repeat(500),
            })),
          }),
        })
      }
    })
    const res = await get('/api/inspect/tasks/task_big')
    expect(res.status).toBe(200)
    expect(res.body.length).toBeLessThanOrEqual(1024 * 1024)
    const task = res.json()
    expect(task.diff.files.length).toBeLessThan(20_000)
    expect(task.diff.truncated).toBe(20_000 - task.diff.files.length)
    expect(task.checks.results.length).toBeLessThan(2_000)
    expect(task.checks.truncated).toBe(2_000 - task.checks.results.length)
    expect(task.attempts.length).toBeLessThan(300)
    expect(task.attemptsTruncated).toBe(300 - task.attempts.length)
    expect(task.attempts.at(-1).id).toBe('att_300')
  })
})

describe('inspection routes: every response stays under 1 MiB (second fix round)', () => {
  const MIB = 1024 * 1024
  const bytes = (body: string): number => Buffer.byteLength(body)
  const WIDE = '語'

  const ids = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `task_${String(i).padStart(23, '0')}`)

  it('tasks/:id with 60,000 dependsOn ids answers under 1 MiB and counts the cut', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    store.atomic(() => {
      store.tasks.save({
        id: 'task_x',
        workItemId: 'wi_1',
        objective: 'o',
        status: 'ready',
        dependsOn: ids(60_000),
      })
    })
    const res = await get('/api/inspect/tasks/task_x')
    expect(res.status).toBe(200)
    expect(bytes(res.body)).toBeLessThanOrEqual(MIB)
    const task = res.json()
    expect(task.dependsOn.length).toBeGreaterThan(0)
    expect(task.dependsOn.length).toBeLessThan(60_000)
    expect(task.dependsOnTruncated).toBe(60_000 - task.dependsOn.length)
  })

  it('work/:id with 60,000 dependsOn ids answers under 1 MiB and counts the cut', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    store.atomic(() => {
      store.tasks.save({
        id: 'task_x',
        workItemId: 'wi_1',
        objective: 'o',
        status: 'ready',
        dependsOn: ids(60_000),
      })
    })
    const res = await get('/api/inspect/work/wi_1')
    expect(bytes(res.body)).toBeLessThanOrEqual(MIB)
    const [task] = res.json().tasks
    expect(task.dependsOnTruncated).toBe(60_000 - task.dependsOn.length)
  })

  it('a short dependsOn is served whole with a zero count', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    store.atomic(() => {
      store.tasks.save({
        id: 'task_x',
        workItemId: 'wi_1',
        objective: 'o',
        status: 'ready',
        dependsOn: ids(3),
      })
    })
    const task = (await get('/api/inspect/tasks/task_x')).json()
    expect(task.dependsOn).toEqual(ids(3))
    expect(task.dependsOnTruncated).toBe(0)
  })

  it('work/:id bounds its cursors, keeps the work stream, and counts what it cut', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    store.atomic(() => {
      for (let i = 0; i < 3_000; i++) {
        store.attempts.save({
          id: `att_${i}_${'a'.repeat(600)}`,
          taskId: 't',
          workItemId: 'wi_1',
          state: 'done',
        })
      }
    })
    const res = await get('/api/inspect/work/wi_1')
    expect(bytes(res.body)).toBeLessThanOrEqual(MIB)
    const work = res.json()
    const shown = Object.keys(work.cursors)
    expect(shown).toContain('work:wi_1')
    expect(shown.length).toBeLessThan(3_001)
    expect(work.cursorsTruncated).toBe(3_001 - shown.length)
  })

  it('work/:id says how many tasks it left out', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    store.atomic(() => {
      for (let i = 0; i < 230; i++) {
        store.tasks.save({
          id: `task_${i}`,
          workItemId: 'wi_1',
          objective: 'o',
          status: 'ready',
          dependsOn: ids(1_000),
        })
      }
    })
    const res = await get('/api/inspect/work/wi_1')
    expect(bytes(res.body)).toBeLessThanOrEqual(MIB)
    const work = res.json()
    expect(work.tasks.length).toBeLessThan(230)
    expect(work.tasksTruncated).toBe(230 - work.tasks.length)
  })

  it('tasks/:id stays under 1 MiB in real bytes when every capped list is full of wide or long text', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    const head = 'b'.repeat(40)
    store.atomic(() => {
      store.tasks.save({
        id: 'task_wide',
        workItemId: 'wi_1',
        localKey: 'k'.repeat(2 * MIB),
        role: 'r'.repeat(2 * MIB),
        status: 's'.repeat(2 * MIB),
        objective: WIDE.repeat(30_000),
        dependsOn: [],
      })
      for (let g = 1; g <= 60; g++) {
        store.attempts.save({
          id: `att_${g}`,
          taskId: 'task_wide',
          workItemId: 'wi_1',
          generation: g,
          state: 'done',
          model: WIDE.repeat(20_000),
          ...(g === 60 && {
            headSha: head,
            diff: {
              summary: WIDE.repeat(5_000),
              files: Array.from({ length: 2_000 }, (_, i) => ({
                path: `${i}${WIDE.repeat(600)}`,
                added: 1,
                removed: 1,
              })),
            },
            checks: Array.from({ length: 400 }, (_, i) => ({
              name: `${i}${WIDE.repeat(300)}`,
              state: 'passed',
              headSha: head,
              detail: WIDE.repeat(800),
              artifactRef: `artifacts/${'x'.repeat(5_000)}`,
            })),
          }),
        })
      }
    })
    const res = await get('/api/inspect/tasks/task_wide')
    expect(res.status).toBe(200)
    expect(bytes(res.body)).toBeLessThanOrEqual(MIB)
    const task = res.json()
    expect(task.attemptsTruncated).toBe(60 - task.attempts.length)
    expect(task.checks.truncated).toBe(400 - task.checks.results.length)
    expect(task.diff.truncated).toBe(2_000 - task.diff.files.length)
    expect(task.diff.files.length).toBeGreaterThan(0)
  })

  it('oversized scalars on a work item cannot push its row or detail past 1 MiB', async () => {
    const big = 'z'.repeat(2 * MIB)
    seedWork('wi_big', {
      repoId: 'repo_a',
      state: big,
      updatedAt: big,
      hold: { at: big, reason: big },
      delivery: { stage: 'pr-open', branch: big, headSha: big, prUrl: big },
    })
    const detail = await get('/api/inspect/work/wi_big')
    expect(bytes(detail.body)).toBeLessThanOrEqual(MIB)
    const page = await get('/api/inspect/work')
    expect(bytes(page.body)).toBeLessThanOrEqual(MIB)
    expect(page.json().items).toHaveLength(1)
  })
})

describe('inspection routes: needs cursor and byte cap (second fix round)', () => {
  const MIB = 1024 * 1024
  const WIDE = '語'

  const question = (id: string, status: string, workItemId = 'wi_1'): Record<string, any> => ({
    id: `question/${id}`,
    questionId: id,
    question: `q ${id}`,
    options: [],
    workItemId,
    status,
    askedAt: AT,
    ...(status === 'answered' && { answer: 'yes' }),
  })
  const card = (id: string, status: string, extra: Record<string, any> = {}): Record<string, any> => ({
    id,
    cls: 'install',
    status,
    operationHash: 'h',
    createdAt: AT,
    expiresAt: '2999-01-01T00:00:00.000Z',
    workItemId: 'wi_1',
    ...extra,
  })
  const walk = async (
    query: string,
    between: (page: number) => void = () => {},
  ): Promise<{ ids: string[]; pages: number }> => {
    const ids: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const res = await get(`/api/inspect/needs?${query}${cursor === null ? '' : `&cursor=${cursor}`}`)
      expect(res.status).toBe(200)
      expect(Buffer.byteLength(res.body)).toBeLessThanOrEqual(MIB)
      const page = res.json()
      ids.push(...page.items.map((item: any) => item.id))
      cursor = page.nextCursor
      pages += 1
      // A cursor that never ends must fail here; left unbounded it hangs the run and no test reports it.
      expect(pages).toBeLessThanOrEqual(50)
      between(pages)
    } while (cursor !== null)
    return { ids, pages }
  }

  it('no row is skipped when an earlier row is answered between pages', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    const all = Array.from({ length: 100 }, (_, i) => `a${i}`)
    store.atomic(() => {
      for (const id of all) store.engines.save(question(id, 'open') as any)
    })
    const { ids } = await walk('limit=48', (page) => {
      if (page === 1) {
        store.atomic(() => {
          store.engines.save(question('a0', 'answered') as any)
          store.engines.save(question('a1', 'answered') as any)
        })
      }
    })
    expect(ids).toEqual(all)
  })

  it('a card and a question share one oldest-first order and the cursor is a rowid', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    store.atomic(() => {
      store.engines.save(question('q1', 'open') as any)
      store.confirmations.save(card('conf_1', 'pending') as any)
      store.engines.save(question('q2', 'open') as any)
    })
    const first = (await get('/api/inspect/needs?limit=2')).json()
    expect(first.items.map((i: any) => i.id)).toEqual(['q1', 'conf_1'])
    const rowid = (db.prepare('SELECT rowid AS r FROM docs WHERE id = ?').get('conf_1') as { r: number }).r
    expect(JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'))).toEqual({
      v: 1,
      r: rowid,
    })
    const second = (await get(`/api/inspect/needs?limit=2&cursor=${first.nextCursor}`)).json()
    expect(second.items.map((i: any) => i.id)).toEqual(['q2'])
    expect(second.nextCursor).toBeNull()
  })

  it('recent=1 pages the open rows, then the recent rows newest first, each once', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    store.atomic(() => {
      for (let i = 0; i < 5; i++) store.engines.save(question(`open${i}`, 'open') as any)
      for (let i = 0; i < 30; i++) store.engines.save(question(`done${i}`, 'answered') as any)
    })
    const { ids, pages } = await walk('recent=1&limit=3')
    const newest = Array.from({ length: 20 }, (_, i) => `done${29 - i}`)
    expect(ids).toEqual(['open0', 'open1', 'open2', 'open3', 'open4', ...newest])
    expect(pages).toBeGreaterThan(5)
  })

  it('a recent row is not skipped when newer rows settle between pages', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    store.atomic(() => {
      for (let i = 0; i < 10; i++) store.engines.save(question(`done${i}`, 'answered') as any)
    })
    const { ids } = await walk('recent=1&limit=3', (page) => {
      if (page === 1) {
        store.atomic(() => {
          store.engines.save(question('late', 'answered') as any)
        })
      }
    })
    expect(ids).toEqual(Array.from({ length: 10 }, (_, i) => `done${9 - i}`))
  })

  it('a newer settled card is not pushed out by twenty settled questions', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    store.atomic(() => {
      for (let i = 0; i < 25; i++) store.engines.save(question(`done${i}`, 'answered') as any)
      store.confirmations.save(card('conf_late', 'denied') as any)
    })
    const { ids } = await walk('recent=1')
    expect(ids[0]).toBe('conf_late')
    expect(ids).toHaveLength(20)
  })

  const later = (seconds: number): string => new Date(Date.parse(AT) + seconds * 1000).toISOString()

  it('a just-answered old question leads recently settled, ahead of newer rows that settled earlier', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    store.atomic(() => {
      store.engines.save({ ...question('old', 'answered'), answeredAt: later(100) } as any)
      for (let i = 0; i < 25; i++) {
        store.engines.save({ ...question(`done${i}`, 'answered'), answeredAt: later(i) } as any)
      }
    })
    const { ids } = await walk('recent=1')
    expect(ids).toHaveLength(20)
    expect(ids[0]).toBe('old')
    expect(ids[1]).toBe('done24')
  })

  it('a question answered long after 2,100 newer rows were written is still found', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    store.atomic(() => {
      store.engines.save({ ...question('old', 'answered'), answeredAt: later(100) } as any)
      for (let i = 0; i < 2_100; i++) store.engines.save(question(`done${i}`, 'answered') as any)
      store.engines.save({ ...question('young', 'answered'), answeredAt: later(200) } as any)
    })
    const { ids } = await walk('recent=1')
    expect(ids.slice(0, 2)).toEqual(['young', 'old'])
  })

  it('questions and cards share one settle-time order, with a lapsed card at its expiry', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    store.atomic(() => {
      store.confirmations.save(card('conf_denied', 'denied', { resolvedAt: later(50) }) as any)
      store.engines.save({ ...question('q_late', 'answered'), answeredAt: later(40) } as any)
      store.confirmations.save(card('conf_lapsed', 'pending', { expiresAt: later(-20) }) as any)
      store.engines.save({ ...question('q_early', 'answered'), answeredAt: later(-30) } as any)
      store.engines.save({ ...question('q_mid', 'answered'), answeredAt: later(-10) } as any)
    })
    const { ids } = await walk('recent=1&limit=1')
    expect(ids).toEqual(['conf_denied', 'q_late', 'q_mid', 'conf_lapsed', 'q_early'])
  })

  it('a walk still reaches its twenty when newer rows settle mid-walk, and never more', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    store.atomic(() => {
      for (let i = 0; i < 30; i++) {
        store.engines.save({ ...question(`done${i}`, 'answered'), answeredAt: later(i) } as any)
      }
    })
    const { ids } = await walk('recent=1&limit=3', (page) => {
      if (page === 1) {
        store.atomic(() => {
          for (let i = 0; i < 5; i++) {
            store.engines.save({ ...question(`late${i}`, 'answered'), answeredAt: later(100 + i) } as any)
          }
        })
      }
    })
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => `done${29 - i}`))
  })

  it('a row served as open and answered mid-walk is not served twice and skips no other', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    store.atomic(() => {
      store.engines.save(question('old', 'open') as any)
      for (let i = 0; i < 6; i++) {
        store.engines.save({ ...question(`done${i}`, 'answered'), answeredAt: later(i) } as any)
      }
    })
    const seen = await walk('recent=1&limit=3', (page) => {
      if (page === 1) {
        store.atomic(() => {
          store.engines.save({ ...question('old', 'answered'), answeredAt: later(100) } as any)
        })
      }
    })
    expect(seen.ids).toEqual(['old', 'done5', 'done4', 'done3', 'done2', 'done1', 'done0'])
  })

  it('the recent cursor carries the settle time and rowid, and a bad one is a 400', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    store.atomic(() => {
      store.engines.save({ ...question('a', 'answered'), answeredAt: later(1) } as any)
      store.engines.save({ ...question('b', 'answered'), answeredAt: later(2) } as any)
      for (let i = 1; i <= 4; i++) {
        store.engines.save({ ...question(`older${i}`, 'answered'), answeredAt: later(-i) } as any)
      }
    })
    const first = (await get('/api/inspect/needs?recent=1&limit=1')).json()
    const rowid = (db.prepare('SELECT rowid AS r FROM docs WHERE id = ?').get('question/b') as { r: number })
      .r
    expect(JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'))).toEqual({
      v: 1,
      r: rowid,
      p: 'recent',
      t: later(2),
      n: 1,
    })
    const bad = Buffer.from(JSON.stringify({ v: 1, r: 1, p: 'recent', t: 7, n: 1 })).toString('base64url')
    expect((await get(`/api/inspect/needs?recent=1&cursor=${bad}`)).status).toBe(400)
    const spent = Buffer.from(JSON.stringify({ v: 1, r: rowid, p: 'recent', t: later(2), n: 21 }))
    const past = (await get(`/api/inspect/needs?recent=1&cursor=${spent.toString('base64url')}`)).json()
    expect(past.items).toEqual([])
    expect(past.nextCursor).toBeNull()
  })

  it('a key-shaped settle time cannot leave through the recent cursor', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    store.atomic(() => {
      store.engines.save({ ...question('a', 'answered'), answeredAt: KEY } as any)
      store.engines.save({ ...question('b', 'answered'), answeredAt: AT } as any)
    })
    const first = (await get('/api/inspect/needs?recent=1&limit=1')).json()
    expect(Buffer.from(first.nextCursor, 'base64url').toString('utf8')).not.toContain(KEY)
  })

  it('100 cards with long wide cls end the page at the byte cap and all still arrive', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    const all = Array.from({ length: 100 }, (_, i) => `conf_${i}`)
    store.atomic(() => {
      for (const id of all) store.confirmations.save(card(id, 'pending', { cls: WIDE.repeat(10_000) }) as any)
    })
    const first = await get('/api/inspect/needs?limit=100')
    expect(Buffer.byteLength(first.body)).toBeLessThanOrEqual(MIB)
    expect(first.json().items.length).toBeLessThan(100)
    expect(first.json().nextCursor).not.toBeNull()
    const { ids, pages } = await walk('limit=100')
    expect(ids).toEqual(all)
    expect(pages).toBeGreaterThan(1)
  })

  it('one oversized card cannot exceed 1 MiB alone', async () => {
    seedWork('wi_1', { repoId: 'repo_a' })
    const big = 'c'.repeat(2 * MIB)
    store.atomic(() => {
      store.confirmations.save(
        card('conf_big', 'pending', {
          cls: big,
          workItemId: undefined,
          expiresAt: `2999${big}`,
          payload: { repo: big, branch: 'main' },
        }) as any,
      )
    })
    const res = await get('/api/inspect/needs')
    expect(Buffer.byteLength(res.body)).toBeLessThanOrEqual(MIB)
    const [item] = res.json().items
    expect(item.id).toBe('conf_big')
    expect(item.cls.length).toBeLessThan(big.length)
    expect(item.repoLabel.length).toBeLessThanOrEqual(80)
  })
})

describe('inspection routes: the hard ceiling and the repository cap (final fix round)', () => {
  const MIB = 1_048_576
  const seedRepo = (id: string): void => {
    store.atomic(() => {
      store.engines.save({ id, url: '/Users/me/code/x', bootstrap: [], checks: [], trust: true })
    })
  }

  it('an answer over 1 MiB in bytes is refused whole, however few characters it has', async () => {
    seedRepo(`repo_${'語'.repeat(400_000)}`)
    const res = await app.inject({ method: 'GET', url: '/api/inspect/snapshot' })
    expect(res.statusCode).toBe(500)
    expect(res.headers['content-type']).toMatch(/^application\/json/)
    expect(Buffer.byteLength(res.body)).toBeLessThan(200)
    expect(res.json().error).toBe('response_too_large')
  })

  it('an answer of exactly 1 MiB is served as JSON and one byte more is not', async () => {
    const base = Buffer.byteLength((await get('/api/inspect/snapshot')).body)
    const emptyEntry = Buffer.byteLength(',{"id":"repo_","label":"x","needsCount":0}')
    seedRepo(`repo_${'x'.repeat(MIB - base - emptyEntry)}`)
    const exact = await app.inject({ method: 'GET', url: '/api/inspect/snapshot' })
    expect(exact.statusCode).toBe(200)
    expect(exact.headers['content-type']).toMatch(/^application\/json/)
    expect(Buffer.byteLength(exact.body)).toBe(MIB)
    expect(exact.json().repositories).toHaveLength(3)
    seedRepo('repo_y')
    expect((await get('/api/inspect/snapshot')).status).toBe(500)
  })

  it('snapshot counts the repositories past its cap of 100', async () => {
    expect((await get('/api/inspect/snapshot')).json().repositoriesTruncated).toBe(0)
    store.atomic(() => {
      for (let i = 0; i < 130; i++) {
        store.engines.save({
          id: `repo_many${i}`,
          url: '/Users/me/code/x',
          bootstrap: [],
          checks: [],
          trust: true,
        })
      }
    })
    const snapshot = (await get('/api/inspect/snapshot')).json()
    expect(snapshot.repositories).toHaveLength(100)
    expect(snapshot.repositoriesTruncated).toBe(32)
  })
})
