/**
 * What the inspection routes say about blocked work, a finished planner turn, delivery failures,
 * CI and an accepted head's diff (§10, §14, §18). A real `buildServer` over a real `SqliteStore`,
 * and real git for the diff. Nothing here mocks its own unit.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HealthBoard, HealthClaim, HealthName, Json } from '@mec/contracts'
import { fakeBrain, integrationDocId, MetaAgentService, type MetaDecision } from '@mec/meta'
import { InspectionReads, MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliveryDocId } from '../src/delivery'
import { buildServer, type ServerDeps } from '../src/server'
import { ownerApproval, ownerHeaders } from './approval-rig'

const AT = '2026-11-05T12:00:00.000Z'
const LATER = '2026-11-05T12:05:00.000Z'
const FUTURE = '2999-01-01T00:00:00.000Z'

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
let scratch: string[] = []

const serverWith = (decision: MetaDecision, extra: Partial<ServerDeps> = {}) =>
  buildServer({
    store,
    effects: store.effects,
    health: quietHealth,
    policyText: '{"preAuthorised":{}}',
    now: () => new Date(AT),
    inspection: new InspectionReads(db),
    metaAgent: new MetaAgentService({
      store,
      effects: store.effects,
      brain: fakeBrain(decision),
      now: () => AT,
      policyText: '{"preAuthorised":{}}',
    }),
    approval: ownerApproval(),
    ...extra,
  })

const get = async (url: string) => (await app.inject({ method: 'GET', url })).json() as any

const say = async (text: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/chat/messages',
    headers: ownerHeaders,
    payload: { text, repoId: 'repo_a' },
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { workItemId: string }).workItemId
}

const seedWork = (id: string, extra: Record<string, Json> = {}): void => {
  store.atomic(() => {
    store.workItems.save({ id, repoId: 'repo_a', state: 'executing', createdAt: AT, updatedAt: AT, ...extra })
  })
}

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
  })
  app = serverWith({ ack: 'I will answer that here.' })
})

afterEach(async () => {
  await app.close()
  db.close()
  delete process.env.MEC_FAKE_ENGINE
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch = []
})

describe('Needs you lists work a person must act on (§18.2)', () => {
  it('blocked work is listed, with the count from the same list', async () => {
    seedWork('wi_blocked', { state: 'blocked', blockedReason: 'the build broke' })
    seedWork('wi_running')
    const needs = (await get('/api/inspect/needs')).items
    expect(needs).toEqual([
      expect.objectContaining({
        kind: 'work',
        id: 'wi_blocked',
        workItemId: 'wi_blocked',
        repoId: 'repo_a',
        repoLabel: 'acme/alpha',
        status: 'open',
        stageKey: 'person/blocked',
        stageLabel: 'Blocked',
        reason: 'Blocked: the build broke',
        nextAction: 'Resolve what blocks it',
      }),
    ])
    const snapshot = await get('/api/inspect/snapshot')
    expect(snapshot.needsCount).toBe(1)
    expect(snapshot.repositories[0].needsCount).toBe(1)
  })

  it('unassigned blocked work is listed and left out of every count: it cannot be cleared here', async () => {
    seedWork('wi_blocked', { state: 'blocked', blockedReason: 'the build broke' })
    store.atomic(() => {
      store.workItems.save({
        id: 'wi_legacy',
        state: 'blocked',
        blockedReason: 'an old block',
        createdAt: AT,
        updatedAt: AT,
      })
    })
    const items = (await get('/api/inspect/needs')).items
    expect(items.map((item: any) => [item.id, item.readOnly])).toEqual([
      ['wi_blocked', false],
      ['wi_legacy', true],
    ])
    const snapshot = await get('/api/inspect/snapshot')
    expect(snapshot.needsCount).toBe(1)
    expect(snapshot.repositories[0].needsCount).toBe(1)
  })

  it('agreeing wakes the launches that waited, once', async () => {
    const wakeLaunches = vi.fn()
    await app.close()
    app = serverWith({ ack: 'Noted.' }, { approval: ownerApproval(), wakeLaunches })
    const res = await app.inject({
      method: 'POST',
      url: '/api/repositories/repo_a/host-run/agree',
      headers: { 'x-mec-client': '1', ...ownerHeaders },
    })
    expect(res.statusCode).toBe(200)
    expect(wakeLaunches).toHaveBeenCalledTimes(1)
  })

  it('a repository waiting for its agreement has one row, however many items wait', async () => {
    for (const id of ['wi_one', 'wi_two']) {
      seedWork(id)
      store.atomic(() => {
        store.tasks.save({ id: `task_${id}`, workItemId: id, repoId: 'repo_a', status: 'ready' })
      })
    }
    const items = (await get('/api/inspect/needs')).items
    expect(items).toEqual([expect.objectContaining({ kind: 'agreement', repoId: 'repo_a', waiting: 2 })])
    expect((await get('/api/inspect/snapshot')).needsCount).toBe(1)
    const rows = (await get('/api/inspect/work')).items
    expect(rows.map((row: any) => row.stage.key)).toEqual(['person/agreement', 'person/agreement'])
    const [meta] = (await get('/api/inspect/meta')).repositories
    expect(meta).toMatchObject({ state: 'waiting_you', line: 'Waiting for your agreement' })
  })

  it('a pull request ready for review is a person stage, so it is listed too', async () => {
    seedWork('wi_ready', { state: 'integrating' })
    store.atomic(() => {
      store.engines.save({
        id: deliveryDocId('wi_ready'),
        workItemId: 'wi_ready',
        stage: 'ready',
        prNumber: 3,
      })
    })
    expect((await get('/api/inspect/needs')).items).toEqual([
      expect.objectContaining({ kind: 'work', id: 'wi_ready', stageKey: 'person/review' }),
    ])
  })

  it('work whose own question or card is listed is not listed twice', async () => {
    seedWork('wi_blocked', { state: 'blocked' })
    store.atomic(() => {
      store.engines.save({
        id: 'question/q1',
        questionId: 'q1',
        question: 'Which?',
        options: [],
        workItemId: 'wi_blocked',
        status: 'open',
        askedAt: AT,
      })
    })
    expect((await get('/api/inspect/needs')).items.map((item: any) => item.kind)).toEqual(['question'])
    expect((await get('/api/inspect/snapshot')).needsCount).toBe(1)
  })

  it('held, ended and running work is not listed: none is a person stage', async () => {
    seedWork('wi_held', { hold: { at: AT } })
    seedWork('wi_done', { state: 'done' })
    seedWork('wi_stopped', { state: 'stopped' })
    seedWork('wi_running')
    expect((await get('/api/inspect/needs')).items).toEqual([])
    expect((await get('/api/inspect/snapshot')).needsCount).toBe(0)
  })

  it('a repository filter applies, and a page cursor walks past the work rows', async () => {
    store.atomic(() => {
      store.engines.save({ id: 'repo_b', url: '/x/beta', bootstrap: [], checks: [], trust: true })
    })
    seedWork('wi_blocked', { state: 'blocked' })
    seedWork('wi_other', { state: 'blocked', repoId: 'repo_b' })
    expect((await get('/api/inspect/needs?repoId=repo_a')).items.map((i: any) => i.id)).toEqual([
      'wi_blocked',
    ])
    const first = await get('/api/inspect/needs?limit=1')
    expect(first.items).toHaveLength(1)
    const next = await get(`/api/inspect/needs?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)
    expect(next.items.map((i: any) => i.id)).toEqual(['wi_other'])
  })

  it('a stage still reads its own cards after work rows join the list', async () => {
    seedWork('wi_card')
    store.atomic(() => {
      store.confirmations.save({
        id: 'conf_1',
        cls: 'install',
        status: 'pending',
        operationHash: 'h',
        createdAt: AT,
        expiresAt: FUTURE,
        workItemId: 'wi_card',
      })
    })
    const row = (await get('/api/inspect/work')).items[0]
    expect(row.stage.label).toBe('Needs your approval')
  })
})

describe('a blocked row names the way forward the server offers (§11 Retry)', () => {
  const agreed = (): void => {
    store.atomic(() => {
      store.engines.save({
        ...(store.engines.get('repo_a') as Record<string, Json>),
        id: 'repo_a',
        hostRunAgreedAt: AT,
      })
    })
  }

  it('a retry on offer is the Next line, in the row and in Needs you', async () => {
    agreed()
    seedWork('wi_retry', { state: 'blocked', blockedReason: 'integration: the merge was refused' })
    store.atomic(() => {
      store.tasks.save({
        id: 'task_1',
        workItemId: 'wi_retry',
        repoId: 'repo_a',
        status: 'accepted',
        createdAt: AT,
        updatedAt: AT,
      })
    })
    expect((await get('/api/inspect/work/wi_retry')).retry).toMatchObject({ kind: 'integration' })
    const row = (await get('/api/inspect/work')).items.find((entry: any) => entry.id === 'wi_retry')
    expect(row.nextAction).toBe('Retry integration')
    const need = (await get('/api/inspect/needs')).items.find((entry: any) => entry.id === 'wi_retry')
    expect(need.nextAction).toBe('Retry integration')
  })

  it('commands changed since admission: no retry on offer, and the row says why and what to do (§14, #41)', async () => {
    agreed()
    seedWork('wi_stale', {
      state: 'blocked',
      blockedReason: 'integration: the merge was refused',
      pin: { repoId: 'repo_a', profileHash: 'admitted-under-other-commands' },
    })
    store.atomic(() => {
      store.tasks.save({
        id: 'task_1',
        workItemId: 'wi_stale',
        repoId: 'repo_a',
        status: 'accepted',
        createdAt: AT,
        updatedAt: AT,
      })
    })
    const words =
      'The repository’s setup or check commands changed since this work was planned, so MEC will not deliver it under the old ones'
    expect((await get('/api/inspect/work/wi_stale')).retry).toBeNull()
    const row = (await get('/api/inspect/work')).items.find((entry: any) => entry.id === 'wi_stale')
    expect(row.reason).toBe(`Blocked: ${words}`)
    expect(row.nextAction).toBe('Stop this work and ask again')
    const need = (await get('/api/inspect/needs')).items.find((entry: any) => entry.id === 'wi_stale')
    expect(need.reason).toBe(`Blocked: ${words}`)
    expect(need.nextAction).toBe('Stop this work and ask again')
  })

  it('with nothing on offer, the Next line stays the general one', async () => {
    seedWork('wi_plain', { state: 'blocked', blockedReason: 'integration: the merge was refused' })
    const row = (await get('/api/inspect/work')).items.find((entry: any) => entry.id === 'wi_plain')
    expect(row.nextAction).toBe('Resolve what blocks it')
  })

  it('changed repository commands say so in words, with stop-and-ask-again as the way forward', async () => {
    agreed()
    seedWork('wi_profile', {
      state: 'blocked',
      blockedReason: 'repo_profile_changed: this work was admitted under other commands',
    })
    const words =
      'The repository’s setup or check commands changed since this work was planned, so MEC will not deliver it under the old ones'
    const need = (await get('/api/inspect/needs')).items.find((entry: any) => entry.id === 'wi_profile')
    expect(need.reason).toBe(`Blocked: ${words}`)
    expect(need.nextAction).toBe('Stop this work and ask again')
    const detail = await get('/api/inspect/work/wi_profile')
    expect(detail.delivery.failure).toBe(words)
    expect(JSON.stringify(detail)).not.toContain('repo_profile_changed')
  })

  it.each([
    [
      'bootstrap_failed: pnpm install: no lockfile',
      'The repository’s setup command failed: pnpm install: no lockfile',
    ],
    ['policy_changed', 'The policy changed since this work was admitted'],
    ['engine_missing: claude is not on PATH', 'An engine is not installed: claude is not on PATH'],
    ['auth_required: max-1', 'A connection needs signing in again: max-1'],
    ['model_refused: no model', 'No model could be chosen for this task: no model'],
    [
      'no_commit_identity: the repository sets no user.name/email',
      'The repository sets no commit name or email',
    ],
    ['some_new_code: detail', 'some new code: detail'],
  ])('a coded reason reads in words: %s', async (blockedReason, words) => {
    seedWork('wi_coded', { state: 'blocked', blockedReason })
    const row = (await get('/api/inspect/work')).items.find((entry: any) => entry.id === 'wi_coded')
    expect(row.reason).toBe(`Blocked: ${words}`)
    expect(row.reason).not.toMatch(/\b[a-z]+_[a-z_]+:/)
  })
})

describe('a planner turn that ended with no plan (§10)', () => {
  it('is not left Working: nothing runs, and the row says so', async () => {
    const id = await say('What does the audit view do?')
    const row = (await get('/api/inspect/work')).items.find((entry: any) => entry.id === id)
    expect(row.state).toBe('planning')
    // An acknowledgement with no report: the planner stopped, and no trigger is on its way.
    expect(row.stage).toEqual({ key: 'ended/no-answer', label: 'No answer', waitingOn: 'none' })
    expect(row.reason).toBe('The meta agent stopped without answering')
    expect(row.nextAction).toBe('Ask again')
  })

  it('a turn still running stays Working', async () => {
    seedWork('wi_planning', { state: 'planning' })
    store.atomic(() => {
      store.messages.save({ id: 'msg_1', text: 'x', workItemId: 'wi_planning', routing: 'new_work' })
    })
    const row = (await get('/api/inspect/work')).items[0]
    expect(row.stage.key).toBe('working')
    expect(row.reason).toBe('Planning')
  })

  it('an answered question whose wake has not landed stays Working', async () => {
    seedWork('wi_planning', { state: 'planning' })
    store.atomic(() => {
      store.messages.save({
        id: 'msg_1',
        text: 'x',
        workItemId: 'wi_planning',
        routing: 'new_work',
        ackText: 'Asked.',
        createdAt: AT,
        updatedAt: AT,
      })
      store.engines.save({
        id: 'question/q1',
        questionId: 'q1',
        question: 'Which?',
        options: [],
        workItemId: 'wi_planning',
        status: 'answered',
        answer: 'That one',
        askedAt: AT,
        answeredAt: LATER,
      })
    })
    expect((await get('/api/inspect/work')).items[0].stage.key).toBe('working')
  })

  it('an open planner question is a decision, not idle', async () => {
    await app.close()
    app = serverWith({
      ack: 'One question first.',
      questions: [{ id: 'q1', question: 'Which?', options: [], at: AT }],
    })
    await say('Do the thing')
    expect((await get('/api/inspect/work')).items[0].stage.label).toBe('Needs your answer')
  })
})

describe('delivery says what happened (§14)', () => {
  it('an integration failure is served, with no delivery record', async () => {
    seedWork('wi_failed')
    store.atomic(() => {
      store.engines.save({
        id: integrationDocId('wi_failed'),
        workItemId: 'wi_failed',
        head: 'a'.repeat(40),
        integrated: {},
        failed: {
          taskId: 'task_1',
          reason: 'checks_failed',
          sha: 'b'.repeat(40),
          failing: [{ name: 'unit', logTail: 'boom' }],
          repairing: false,
        },
      })
    })
    const detail = await get('/api/inspect/work/wi_failed')
    expect(detail.coverage.delivery).toBe(true)
    expect(detail.delivery.failure).toBe('Combined checks failed on bbbbbbb: unit.')
  })

  it('a merge conflict names its paths, and an open repair says so', async () => {
    seedWork('wi_conflict')
    store.atomic(() => {
      store.engines.save({
        id: integrationDocId('wi_conflict'),
        workItemId: 'wi_conflict',
        head: 'a'.repeat(40),
        integrated: {},
        failed: { taskId: 'task_1', reason: 'conflict', conflictedPaths: ['src/a.ts'], repairing: true },
      })
    })
    expect((await get('/api/inspect/work/wi_conflict')).delivery.failure).toBe(
      'Merging a task conflicted in src/a.ts. A repair is open.',
    )
  })

  it('a repair whose attempts are used up is not called open', async () => {
    seedWork('wi_spent')
    store.atomic(() => {
      store.engines.save({
        id: integrationDocId('wi_spent'),
        workItemId: 'wi_spent',
        head: 'a'.repeat(40),
        integrated: {},
        failed: { taskId: 'task_1', reason: 'checks_failed', sha: 'b'.repeat(40), repairing: true },
      })
      store.tasks.save({
        id: 'task_r',
        workItemId: 'wi_spent',
        repoId: 'repo_a',
        repairOf: 'task_1',
        status: 'blocked',
        blockedReason: 'repairs used up (2 of 2). What remains: docs',
        createdAt: AT,
        updatedAt: AT,
      })
    })
    expect((await get('/api/inspect/work/wi_spent')).delivery.failure).toBe(
      'Combined checks failed on bbbbbbb. Its repairs are used up.',
    )
  })

  it('work blocked by the integration step serves that reason', async () => {
    seedWork('wi_boot', {
      state: 'blocked',
      blockedReason: 'bootstrap_failed: pnpm install: no lockfile',
    })
    const detail = await get('/api/inspect/work/wi_boot')
    expect(detail.coverage.delivery).toBe(true)
    expect(detail.delivery.failure).toBe('The repository’s setup command failed: pnpm install: no lockfile')
  })

  it.each(['checks failed on abc1234: unit', 'could not run pnpm test'])(
    'every reason a retry answers is a delivery failure too: %s',
    async (blockedReason) => {
      seedWork('wi_int', { state: 'blocked', blockedReason })
      expect((await get('/api/inspect/work/wi_int')).delivery.failure).toBe(blockedReason)
    },
  )

  it('an integration with no failure is a record: it is not "not recorded"', async () => {
    seedWork('wi_quiet')
    store.atomic(() => {
      store.engines.save({
        id: integrationDocId('wi_quiet'),
        workItemId: 'wi_quiet',
        head: 'a'.repeat(40),
        integrated: {},
      })
    })
    const detail = await get('/api/inspect/work/wi_quiet')
    expect(detail.coverage.delivery).toBe(true)
    expect(detail.delivery.failure).toBeUndefined()
  })

  it('a failed push on the record is served', async () => {
    seedWork('wi_push')
    store.atomic(() => {
      store.engines.save({
        id: deliveryDocId('wi_push'),
        workItemId: 'wi_push',
        stage: 'failed',
        error: 'remote rejected',
      })
    })
    expect((await get('/api/inspect/work/wi_push')).delivery).toMatchObject({
      stage: 'local-complete',
      failure: 'remote rejected.',
    })
  })

  it('a refused step that will be tried again says so', async () => {
    seedWork('wi_hold')
    store.atomic(() => {
      store.engines.save({
        id: deliveryDocId('wi_hold'),
        workItemId: 'wi_hold',
        stage: 'local_complete',
        error: 'remote_unreadable: origin',
        retryAt: LATER,
      })
    })
    expect((await get('/api/inspect/work/wi_hold')).delivery.failure).toBe(
      'The repository’s remote could not be read: origin. MEC tries this step again.',
    )
  })

  it('other blocked work has no delivery failure, and healthy delivery fields stay out', async () => {
    seedWork('wi_plain', { state: 'blocked', blockedReason: 'needs a person' })
    const detail = await get('/api/inspect/work/wi_plain')
    expect(detail.coverage.delivery).toBe(false)
    expect(detail.delivery).toEqual({
      stage: 'none',
      branch: null,
      headSha: null,
      prNumber: null,
      prUrl: null,
    })
  })

  it('CI is what the last read saw, and the repository a card would act on is served', async () => {
    seedWork('wi_ci', { state: 'integrating' })
    const save = (fields: Record<string, Json>) =>
      store.atomic(() => {
        store.engines.save({
          id: deliveryDocId('wi_ci'),
          workItemId: 'wi_ci',
          repo: 'acme/alpha',
          prNumber: 7,
          ...fields,
        })
      })
    save({ stage: 'ready', ci: 'green', ciAt: AT })
    expect((await get('/api/inspect/work/wi_ci')).delivery).toMatchObject({
      repo: 'acme/alpha',
      ci: 'passing',
      ciReadAt: AT,
    })
    save({ stage: 'ready', limit: 'no_required_checks', ci: 'no_required_checks', ciAt: AT })
    expect((await get('/api/inspect/work/wi_ci')).delivery.ci).toBe('none-required')
    save({ stage: 'pr_open', ci: 'ci_failed', ciAt: AT })
    expect((await get('/api/inspect/work/wi_ci')).delivery.ci).toBe('failing')
    save({ stage: 'pr_open', ci: 'ci_pending', ciAt: AT })
    expect((await get('/api/inspect/work/wi_ci')).delivery.ci).toBe('running')
    save({ stage: 'pr_open', ci: 'ci_unreadable', ciAt: AT })
    expect((await get('/api/inspect/work/wi_ci')).delivery.ci).toBe('unreadable')
  })

  it('a ready record from before CI was stored still reads as what made it ready', async () => {
    seedWork('wi_old', { state: 'integrating' })
    store.atomic(() => {
      store.engines.save({ id: deliveryDocId('wi_old'), workItemId: 'wi_old', stage: 'ready' })
    })
    expect((await get('/api/inspect/work/wi_old')).delivery.ci).toBe('passing')
    store.atomic(() => {
      store.engines.save({
        id: deliveryDocId('wi_old'),
        workItemId: 'wi_old',
        stage: 'ready',
        limit: 'no_required_checks',
      })
    })
    expect((await get('/api/inspect/work/wi_old')).delivery.ci).toBe('none-required')
  })

  it('an open pull request nothing has read has no CI state', async () => {
    seedWork('wi_unread', { state: 'integrating' })
    store.atomic(() => {
      store.engines.save({ id: deliveryDocId('wi_unread'), workItemId: 'wi_unread', stage: 'pr_open' })
    })
    expect((await get('/api/inspect/work/wi_unread')).delivery.ci).toBeUndefined()
  })

  it('an open merge card for the work is named, so the action is not offered twice', async () => {
    seedWork('wi_card', { state: 'integrating' })
    store.atomic(() => {
      store.confirmations.save({
        id: 'conf_merge',
        cls: 'pr_merge',
        status: 'pending',
        operationHash: 'h',
        createdAt: AT,
        expiresAt: FUTURE,
        workItemId: 'wi_card',
        payload: { repo: 'acme/alpha', prNumber: 7 },
      })
    })
    expect((await get('/api/inspect/work/wi_card')).delivery.mergeCardId).toBe('conf_merge')
  })
})

describe('the diff of a recorded head (§15)', () => {
  const repo = (): { dir: string; base: string; head: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'mec-diff-'))
    scratch.push(dir)
    const run = (...args: string[]) =>
      execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@e.st', ...args], {
        encoding: 'utf8',
      }).trim()
    run('init', '-q')
    writeFileSync(join(dir, 'kept.txt'), 'one\ntwo\n')
    writeFileSync(join(dir, 'pic.bin'), Buffer.from([0, 1, 2]))
    run('add', '.')
    run('commit', '-qm', 'base')
    const base = run('rev-parse', 'HEAD')
    writeFileSync(join(dir, 'kept.txt'), 'one\nchanged\nthree\n')
    writeFileSync(join(dir, 'pic.bin'), Buffer.from([0, 9, 9, 9]))
    writeFileSync(join(dir, 'we ird.txt'), 'new\n')
    run('add', '.')
    run('commit', '-qm', 'change')
    return { dir, base, head: run('rev-parse', 'HEAD') }
  }

  const seedTask = (attempt: Record<string, Json>, gitDir: string | null): void => {
    seedWork('wi_diff', { ...(gitDir !== null && { git_dir: gitDir }) })
    store.atomic(() => {
      store.tasks.save({
        id: 'task_1',
        workItemId: 'wi_diff',
        objective: 'Change it',
        status: 'accepted',
        createdAt: AT,
        updatedAt: AT,
      })
      store.attempts.save({
        id: 'att_1',
        taskId: 'task_1',
        workItemId: 'wi_diff',
        generation: 1,
        state: 'succeeded',
        ...attempt,
      })
    })
  }

  it('reads the real changed files between the attempt base and its head', async () => {
    const { dir, base, head } = repo()
    seedTask({ base_sha: base, head_sha: head }, dir)
    const detail = await get('/api/inspect/tasks/task_1')
    expect(detail.coverage.diff).toBe(true)
    expect(detail.diff.headSha).toBe(head)
    expect(detail.diff.files).toEqual([
      { path: 'kept.txt', added: 2, removed: 1 },
      { path: 'pic.bin', added: 0, removed: 0, binary: true },
      { path: 'we ird.txt', added: 1, removed: 0 },
    ])
    expect(detail.diff.summary).toBe(`3 files changed, +3 -1, ${base.slice(0, 7)} to ${head.slice(0, 7)}`)
  })

  it('a head git cannot read serves no invented files', async () => {
    const { dir, base } = repo()
    seedTask({ base_sha: base, head_sha: 'f'.repeat(40) }, dir)
    const detail = await get('/api/inspect/tasks/task_1')
    expect(detail.coverage.diff).toBe(false)
    expect(detail.diff).toMatchObject({ headSha: null, summary: null, files: [] })
    expect(detail.attempts[0].headSha).toBe('f'.repeat(40))
  })

  it('a stored ref that is not a commit id never reaches git', async () => {
    const { dir, head } = repo()
    seedTask({ base_sha: '--output=/tmp/mec-should-not-exist', head_sha: head }, dir)
    const detail = await get('/api/inspect/tasks/task_1')
    expect(detail.coverage.diff).toBe(false)
  })

  it('a stored diff still wins', async () => {
    const { dir, base, head } = repo()
    seedTask(
      {
        base_sha: base,
        head_sha: head,
        diff: { summary: 'Stored', files: [{ path: 'a', added: 1, removed: 0 }] },
      },
      dir,
    )
    const detail = await get('/api/inspect/tasks/task_1')
    expect(detail.diff).toMatchObject({ summary: 'Stored', files: [{ path: 'a', added: 1, removed: 0 }] })
  })
})
