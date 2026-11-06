import { describe, expect, it } from 'vitest'
import { decodeChatLines, decodeMeta, decodeWorkDetail, decodeWorkPage } from '../src/inspection-decode'
import { createInspection, type InspectionClient } from '../src/live/inspection'
import type { DelegationRow, MetaAnswer, WorkRow } from '../src/next/inspection-wire'
import {
  conversationView,
  deliveryDetail,
  metaStatus,
  sentAlready,
  workActions,
} from '../src/next/work-model'
import { workDetails, workRows } from './fixtures/inspection-fixtures'

const AT = '2026-11-06T12:00:00.000Z'

const row = (extra: Partial<WorkRow> = {}): WorkRow =>
  ({
    ...decodeWorkPage({ items: [workRows.working], nextCursor: null, observedAt: AT }).items[0],
    ...extra,
  }) as WorkRow

const answer = (extra: Partial<MetaAnswer['repositories'][number]> = {}): MetaAnswer => ({
  observedAt: AT,
  connection: { slotLabel: 'preflight-a', engine: 'claude', model: 'claude-opus-5-5', modelAt: AT },
  repositories: [
    {
      repoId: 'repo_a',
      state: 'idle',
      line: 'Nothing is running',
      workItemId: null,
      running: false,
      at: AT,
      ...extra,
    },
  ],
})

const ready = (data: MetaAnswer) => ({ status: 'ready' as const, data, readAt: AT })

const delegated: DelegationRow = {
  taskId: 'task_active',
  title: 'Add wave.js',
  role: 'implementer',
  status: 'active',
  requested: { tier: 'fast', model: null },
  attempts: 2,
  latest: {
    id: 'att_1',
    generation: 2,
    state: 'running',
    role: 'implementer',
    requested: { tier: 'fast', model: null },
    actual: { model: 'claude-haiku-5-5', engine: 'claude', slotLabel: 'preflight-a' },
    baseSha: null,
    headSha: null,
    processOutcome: 'unknown',
    lastActivityAt: AT,
    placement: 'pinned to slot_a by the plan',
  },
  waiting: null,
  activity: { summary: 'Bash', at: AT },
}

describe('the live line', () => {
  it('says what is happening, on which model and connection, and when it last moved', () => {
    const view = metaStatus(ready(answer()), 'repo_a', false)
    expect(view).toMatchObject({
      headline: 'Nothing is running',
      connection: 'claude-opus-5-5 on preflight-a (claude)',
      active: false,
    })
    expect(view?.when).toMatch(/^Last event /)
  })

  it('a running turn says when it started, and asks to be read again', () => {
    const view = metaStatus(ready(answer({ state: 'reading', running: true })), 'repo_a', false)
    expect(view?.when).toMatch(/^Started /)
    expect(view?.active).toBe(true)
  })

  it('an unknown model and a missing connection are said', () => {
    const data = answer()
    const unknown = { ...data, connection: { ...data.connection!, model: null, modelAt: null } }
    expect(metaStatus(ready(unknown), 'repo_a', false)?.connection).toBe(
      'preflight-a (claude), model not recorded yet',
    )
    expect(metaStatus(ready({ ...data, connection: null }), 'repo_a', false)?.connection).toBe(
      'No meta connection chosen',
    )
  })

  it('no time is shown when there is no event, rather than a made-up one', () => {
    expect(metaStatus(ready(answer({ at: null })), 'repo_a', false)?.when).toBe('No events yet')
  })

  it('a send shows at once, before any read has seen it', () => {
    expect(metaStatus(ready(answer()), 'repo_a', true)).toMatchObject({
      headline: 'Sending your request',
      active: true,
    })
    expect(metaStatus({ status: 'loading' }, 'repo_a', true)?.headline).toBe('Sending your request')
  })

  it('a running turn outranks the send that started it', () => {
    const view = metaStatus(
      ready(answer({ state: 'reading', line: 'Reading your request', running: true })),
      'repo_a',
      true,
    )
    expect(view?.headline).toBe('Reading your request')
  })

  it('a failed read never reads as idle', () => {
    const failed = { status: 'failed' as const, message: 'Down', data: answer(), readAt: AT }
    expect(metaStatus(failed, 'repo_a', false)?.headline).toBe('Could not read what the meta agent is doing')
    expect(metaStatus({ status: 'loading' }, 'repo_a', false)).toBeNull()
  })

  it('another repository’s line is not shown here', () => {
    expect(metaStatus(ready(answer()), 'repo_b', false)).toBeNull()
  })
})

describe('delegation in the work detail', () => {
  const base = decodeWorkDetail({ ...workDetails.work_working, delegation: [delegated] })

  it('shows who, why, attempts and activity without opening the task', () => {
    const [view] = deliveryDetail(base, null).delegation
    expect(view).toMatchObject({
      taskId: 'task_active',
      title: 'Add wave.js',
      who: 'implementer on preflight-a (claude), asked for fast, ran claude-haiku-5-5',
      why: 'Why here: pinned to slot_a by the plan',
      attempts: '2 attempts, latest running',
    })
    expect(view?.activity).toMatch(/^Last step: Bash, /)
  })

  it('a task nothing picked up says why, and invents no connection', () => {
    const waiting = { ...delegated, latest: null, attempts: 0, activity: null, waiting: 'no capacity' }
    const [view] = deliveryDetail({ ...base, delegation: [waiting] }, null).delegation
    expect(view).toMatchObject({
      who: 'implementer, no connection yet, asked for fast',
      why: 'Waiting: no capacity',
      attempts: 'Not started',
      activity: null,
    })
  })

  it('a task with no tier asks for nothing, and an unrecorded model is unknown', () => {
    const latest = { ...delegated.latest!, actual: { model: null, engine: null, slotLabel: 'preflight-a' } }
    const bare = { ...delegated, requested: { tier: null, model: null }, latest }
    const [view] = deliveryDetail({ ...base, delegation: [bare] }, null).delegation
    expect(view?.who).toBe('implementer on preflight-a, model not recorded yet')
  })
})

describe('what cannot apply is not shown', () => {
  const question = decodeWorkDetail({
    ...workDetails.work_working,
    state: 'planning',
    tasks: [],
    delegation: [],
    stage: { key: 'ended/answered', label: 'Answered', waitingOn: 'none' },
    turnOutcome: 'answered',
    answer: 'It exports wave(name).',
  })

  it('an answered question shows its answer, and no plan, Hold or Stop', () => {
    const view = deliveryDetail(question, null)
    expect(view.outcome).toEqual({ kind: 'answered', text: 'It exports wave(name).' })
    expect(view.plan.footnote).toBe('')
    expect(view.actions).toEqual([])
    expect(workActions(question, { kind: 'all' }, null)).toEqual([])
  })

  it('a turn with no answer says so', () => {
    const lost = { ...question, turnOutcome: 'no-answer' as const, answer: null }
    expect(deliveryDetail(lost, null).outcome?.kind).toBe('no-answer')
  })

  it('real work has no outcome and keeps its delivery line', () => {
    const view = deliveryDetail(decodeWorkDetail(workDetails.work_working), null)
    expect(view.outcome).toBeNull()
    expect(view.plan.footnote).not.toBe('')
  })
})

describe('the conversation', () => {
  const line = {
    id: 'msg_q',
    text: 'why?',
    createdAt: AT,
    workItemId: 'wi_q',
    kind: null,
    ackText: 'I will check.',
  }

  it('the heading is the repository, whatever was asked last', () => {
    const view = conversationView({ row: row(), detail: null, messages: [], repository: 'mec-sandbox' })
    expect(view.title).toBe('mec-sandbox')
  })

  it('shows the answer a turn reported, after its acknowledgement', () => {
    const view = conversationView({
      row: null,
      detail: null,
      messages: [{ ...line, replyText: 'Because the merge failed.' }],
    })
    expect(view.entries.map((entry) => [entry.kind, entry.text])).toEqual([
      ['user', 'why?'],
      ['agent', 'I will check.'],
      ['agent', 'Because the merge failed.'],
    ])
  })

  it('an acknowledgement that is the answer’s first sentence is not said twice', () => {
    const view = conversationView({
      row: null,
      detail: null,
      messages: [{ ...line, ackText: 'Because it failed.', replyText: 'Because it failed. Retry it.' }],
    })
    expect(view.entries.filter((entry) => entry.kind === 'agent').map((entry) => entry.text)).toEqual([
      'Because it failed. Retry it.',
    ])
  })

  it('a turn that gave no answer says so in the thread', () => {
    const lost = row({ id: 'wi_q', turnOutcome: 'no-answer', lastActivityAt: AT })
    const view = conversationView({ row: null, detail: null, messages: [line], work: [lost] })
    expect(view.entries.at(-1)).toMatchObject({ kind: 'note' })
    expect(view.entries.at(-1)?.text).toMatch(/^The meta agent stopped without answering\./)
  })

  it('lists other open work with its state, so blocked work never drops out of sight', () => {
    const blocked = row({
      id: 'wi_b',
      title: 'wave.js',
      stage: { key: 'person/blocked', label: 'Blocked', waitingOn: 'person' },
      reason: 'Blocked: merge failed',
    })
    const view = conversationView({ row: null, detail: null, messages: [], work: [blocked], open: [blocked] })
    expect(view.open).toEqual([
      {
        id: 'wi_b',
        title: 'wave.js',
        stageLabel: 'Blocked',
        tone: 'attention',
        reason: 'Blocked: merge failed',
      },
    ])
  })

  it('the plan names who got each task', () => {
    const detail = decodeWorkDetail({
      ...workDetails.work_working,
      delegation: [delegated],
    })
    const view = conversationView({ row: null, detail, messages: [] })
    const task = view.plan?.tasks.find((entry) => entry.id === 'task_active')
    expect(task?.detail).toBe('implementer on preflight-a (claude), asked for fast, ran claude-haiku-5-5')
  })
})

describe('a send shows once', () => {
  it('finds the stored message by its key', () => {
    const lines = decodeChatLines([{ id: 'm', text: 'hi', createdAt: AT, idempotencyKey: 'k1' }])
    expect(sentAlready(lines, 'k1')).toBe(true)
    expect(sentAlready(lines, 'k2')).toBe(false)
  })
})

describe('the meta read', () => {
  it('decodes, and refuses a body it cannot read', () => {
    expect(decodeMeta(answer())).toEqual(answer())
    expect(() => decodeMeta({ observedAt: AT })).toThrow()
  })

  it('stays out of the way of the work read, and keeps its last answer on failure', async () => {
    const pageOf = { items: [], nextCursor: null, observedAt: AT }
    let fail = false
    const client = {
      work: async () => pageOf,
      needs: async () => pageOf,
      meta: async () => {
        if (fail) throw new Error('down')
        return answer()
      },
    } as unknown as InspectionClient
    const inspection = createInspection(client)
    inspection.refresh()
    await new Promise((resolve) => setTimeout(resolve))
    expect(inspection.getState().meta.status).toBe('ready')
    fail = true
    inspection.refreshMeta()
    await new Promise((resolve) => setTimeout(resolve))
    const { meta } = inspection.getState()
    expect(meta.status).toBe('failed')
    expect(meta.status === 'failed' && meta.data).toEqual(answer())
    expect(inspection.getState().work.status).toBe('ready')
  })
})
