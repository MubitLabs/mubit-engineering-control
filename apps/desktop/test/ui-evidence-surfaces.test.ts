/**
 * §15 on the surfaces: a task held back for screenshots reads as a stage in words on Work and in
 * Needs you, a capture that could not be taken offers "Take the screenshots again" through the
 * same retry route as every other retry, and the PR body names the captures by revision. A real
 * `buildServer` over a real `SqliteStore`; the retry runs `Delivery.retry` itself.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HealthBoard, Json } from '@mec/contracts'
import { evidenceDocId, repoFields } from '@mec/meta'
import { InspectionReads, MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Delivery } from '../src/delivery'
import { buildPrBody } from '../src/release'
import { buildServer } from '../src/server'
import { prEvidenceLines } from '../src/ui-evidence'
import { ownerApproval, ownerHeaders } from './approval-rig'

const AT = '2026-11-10T12:00:00.000Z'
const POLICY = '{"preAuthorised":{}}'
const BASE = 'b'.repeat(40)
const HEAD = 'a'.repeat(40)

const quietHealth = {
  claim: () => ({ starting: () => {}, ready: () => {}, paused: () => {}, error: () => {} }),
  names: () => [],
  entry: () => undefined,
} as unknown as HealthBoard

let db: Database.Database
let store: SqliteStore
let app: ReturnType<typeof buildServer>
let dataDir: string

const get = async (url: string) => (await app.inject({ method: 'GET', url })).json() as any
const row = async () => (await get('/api/inspect/work')).items.find((entry: any) => entry.id === 'wi_1')

function seed(uiEvidence: Json, evidence?: Record<string, Json>): void {
  store.atomic(() => {
    store.engines.save({
      id: 'repo_a',
      url: 'https://github.com/acme/site.git',
      bootstrap: [],
      checks: [{ name: 'unit', cmd: 'true' }],
      trust: false,
      hostRunAgreedAt: AT,
      uiEvidence,
    })
    store.workItems.save({
      id: 'wi_1',
      state: 'executing',
      mandate: { originMessageId: 'msg_1', status: 'active' },
      createdAt: AT,
      updatedAt: AT,
      ...repoFields(store, 'repo_a', POLICY),
    })
    store.tasks.save({
      id: 'task_a',
      localKey: 'a',
      workItemId: 'wi_1',
      repoId: 'repo_a',
      status: 'active',
      dependsOn: [],
      createdAt: AT,
      updatedAt: AT,
    })
    store.attempts.save({
      id: 'att_1',
      taskId: 'task_a',
      workItemId: 'wi_1',
      slotId: 'slot_a',
      state: 'succeeded',
      base_sha: BASE,
      head_sha: HEAD,
      changed_paths: ['index.html'],
      checks: ['unit'],
      createdAt: AT,
    })
    store.engines.save({
      id: 'check/att_1/unit',
      attemptId: 'att_1',
      name: 'unit',
      status: 'passed',
      sha: HEAD,
    })
    if (evidence !== undefined) {
      store.engines.save({
        id: evidenceDocId('att_1'),
        attemptId: 'att_1',
        taskId: 'task_a',
        workItemId: 'wi_1',
        repoId: 'repo_a',
        ...evidence,
      })
    }
  })
}

const COULD_NOT = {
  state: 'could_not',
  before: {
    sha: BASE,
    status: 'captured',
    shots: [{ path: '/', file: 'before-1.png', bytes: 9, at: AT, status: 200 }],
  },
  after: { sha: HEAD, status: 'could_not', reason: 'the page / did not load: net::ERR_CONNECTION_REFUSED' },
}

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db, MIGRATIONS_v1)
  store = new SqliteStore(db, { now: () => new Date(AT) })
  dataDir = mkdtempSync(join(tmpdir(), 'mec-uiev-surfaces-'))
  const delivery = new Delivery({ store, effects: store.effects, dataDir, policyText: POLICY })
  app = buildServer({
    store,
    effects: store.effects,
    health: quietHealth,
    policyText: POLICY,
    now: () => new Date(AT),
    inspection: new InspectionReads(db),
    approval: ownerApproval(),
    keystoreRoot: dataDir,
    retryWork: (id) => delivery.retry(id),
  })
})

afterEach(async () => {
  await app.close()
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('UI evidence on Work (§10, §15)', () => {
  it('waiting for the captures is a stage in words, not Working', async () => {
    seed({ required: true })
    expect(await row()).toMatchObject({
      stage: {
        key: 'waiting/screenshots',
        label: 'Waiting for before and after screenshots',
        waitingOn: 'system',
      },
      reason: 'MEC is taking the before and after screenshots of the change',
    })
  })

  it('flag off: the same row as before', async () => {
    seed({ required: false })
    const read = await row()
    expect(read.stage.key).toBe('working')
    expect((await get('/api/inspect/work/wi_1')).retry).toBeNull()
  })

  it('a capture that could not be taken says which and why, and offers to take them again', async () => {
    seed({ required: true }, COULD_NOT)
    const reason = "Couldn't take the after screenshot: the page / did not load: net::ERR_CONNECTION_REFUSED"
    expect(await row()).toMatchObject({
      stage: { key: 'person/screenshots', label: "Couldn't take the after screenshot", waitingOn: 'person' },
      reason,
      nextAction: 'Take the screenshots again',
    })
    expect((await get('/api/inspect/work/wi_1')).retry).toEqual({ kind: 'screenshots', reason })
    const need = (await get('/api/inspect/needs')).items.find((entry: any) => entry.id === 'wi_1')
    expect(need?.nextAction).toBe('Take the screenshots again')

    const retried = await app.inject({
      method: 'POST',
      url: '/api/work/wi_1/retry',
      headers: ownerHeaders,
      payload: {},
    })
    expect(retried.json()).toMatchObject({ status: 'retrying', kind: 'screenshots' })
    expect(store.engines.get(evidenceDocId('att_1'))).toMatchObject({ state: 'requested' })
    expect((await row()).stage.key).toBe('waiting/screenshots')
    const again = await app.inject({
      method: 'POST',
      url: '/api/work/wi_1/retry',
      headers: ownerHeaders,
      payload: {},
    })
    expect(again.statusCode).not.toBe(200)
  })

  it('the work view lists the captures by short revision', async () => {
    seed({ required: true }, COULD_NOT)
    const { items } = await get('/api/work/wi_1/screenshots')
    expect(items).toMatchObject([
      {
        taskId: 'task_a',
        state: 'could_not',
        before: { short: BASE.slice(0, 7), status: 'captured' },
        after: { short: HEAD.slice(0, 7), status: 'could_not', reason: COULD_NOT.after.reason },
      },
    ])
  })
})

describe('UI evidence in the PR body (§14, §15)', () => {
  const TAKEN = {
    state: 'taken',
    viewport: { width: 1280, height: 800 },
    before: COULD_NOT.before,
    after: {
      sha: HEAD,
      status: 'captured',
      shots: [{ path: '/', file: 'after-1.png', bytes: 9, at: AT, status: 200 }],
    },
  }

  it('names each accepted task’s captures by revision, as text', () => {
    seed({ required: true }, TAKEN)
    store.atomic(() =>
      store.tasks.save({
        ...(store.tasks.get('task_a') as Record<string, Json>),
        status: 'integrated',
        acceptedHead: HEAD,
      }),
    )
    const lines = prEvidenceLines(store, 'wi_1')
    expect(lines).toEqual([
      `a: before \`${BASE.slice(0, 7)}\` and after \`${HEAD.slice(0, 7)}\` of / at 1280x800, taken by MEC in Chromium from the real application. The images are kept on the machine that ran the work.`,
    ])
    const body = buildPrBody({
      request: 'r',
      tasks: [],
      integrationSha: HEAD,
      checks: [],
      findings: [],
      decisions: [],
      uiEvidence: lines,
    })
    expect(body).toContain(`## UI evidence\n\n- ${lines[0]}`)
    expect(body).not.toContain('.png')
  })

  it('a capture of another head is not this task’s evidence; none means no section', () => {
    seed({ required: true }, TAKEN)
    store.atomic(() =>
      store.tasks.save({ ...(store.tasks.get('task_a') as Record<string, Json>), acceptedHead: BASE }),
    )
    expect(prEvidenceLines(store, 'wi_1')).toEqual([])
    const body = buildPrBody({
      request: 'r',
      tasks: [],
      integrationSha: HEAD,
      checks: [],
      findings: [],
      decisions: [],
    })
    expect(body).not.toContain('UI evidence')
  })
})
