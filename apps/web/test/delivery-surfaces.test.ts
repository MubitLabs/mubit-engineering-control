import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '../src/api'
import {
  decodeChatLines,
  decodeNeedsPage,
  decodeTaskDetail,
  decodeWorkDetail,
} from '../src/inspection-decode'
import { createInspection, type InspectionClient } from '../src/live/inspection'
import { createPause, type PauseClient } from '../src/live/pause'
import { connectionLine } from '../src/next/ConnectionsView'
import type { ChatLine, NeedItem, TaskDetail, WorkDetail, WorkRow } from '../src/next/inspection-wire'
import { pausedSince } from '../src/next/Sidebar'
import {
  conversationView,
  deliveryDetail,
  needCard,
  needsCount,
  needsList,
  type Read,
  taskScope,
  type WorkAction,
  workActions,
} from '../src/next/work-model'
import { taskDetails, workDetails, workRows } from './fixtures/inspection-fixtures'

const ALL = { kind: 'all' } as const
const READ_AT = '2026-11-05T10:00:00.000Z'
const HEAD = 'abc1230000000000000000000000000000000002'
const ready = <T>(data: T): Read<T> => ({ status: 'ready', data, readAt: READ_AT })

const base = workDetails[Object.keys(workDetails)[0] as keyof typeof workDetails] as WorkDetail
const detail = (delivery: Partial<WorkDetail['delivery']>, change: Partial<WorkDetail> = {}) =>
  decodeWorkDetail({
    ...base,
    coverage: { ...base.coverage, delivery: true },
    hold: null,
    state: 'integrating',
    stage: { key: 'person/review', label: 'Ready for review', waitingOn: 'person' },
    ...change,
    delivery: {
      stage: 'pr-ready',
      branch: 'mec/1/integration',
      headSha: HEAD,
      prNumber: 7,
      prUrl: 'https://github.com/acme/alpha/pull/7',
      repo: 'acme/alpha',
      ci: 'passing',
      ...delivery,
    },
  })

const blockedNeed: NeedItem = {
  kind: 'work',
  id: 'wi_blocked',
  repoId: 'repo_a',
  repoLabel: 'acme/alpha',
  workItemId: 'wi_blocked',
  title: 'Add audit view',
  stageKey: 'person/blocked',
  stageLabel: 'Blocked',
  reason: 'Blocked: the build broke',
  nextAction: 'Resolve what blocks it',
  status: 'open',
  since: READ_AT,
  readOnly: false,
}

const needsPageOf = (items: NeedItem[]) => ({ items, nextCursor: null, observedAt: READ_AT })

describe('merge is offered on a ready pull request, through its card (§14)', () => {
  const merge = (work: WorkDetail) =>
    workActions(work, ALL, work.hold, null, work.delivery).find((action) => action.kind === 'merge')

  it('offers merge with the pull request it would act on', () => {
    expect(merge(detail({}))).toMatchObject({
      kind: 'merge',
      label: expect.stringContaining('Merge pull request #7'),
      workItemId: base.id,
      repo: 'acme/alpha',
      prNumber: 7,
    })
  })

  it('never before the pull request is ready', () => {
    expect(merge(detail({ stage: 'pr-open' }))).toBeUndefined()
    expect(merge(detail({ stage: 'merged' }))).toBeUndefined()
  })

  it('never without the repository and number the card must bind', () => {
    expect(merge(detail({ repo: null }))).toBeUndefined()
    expect(merge(detail({ prNumber: null }))).toBeUndefined()
  })

  it('never twice: an open card is the question already asked', () => {
    expect(merge(detail({ mergeCardId: 'conf_1' }))).toBeUndefined()
  })

  it('never on held work, whose card would wait anyway', () => {
    expect(merge(detail({}, { hold: { since: READ_AT, reason: null } }))).toBeUndefined()
  })

  it('the detail offers both of the slot beside Hold: a retry from the store, and merge', () => {
    const work = detail({}, { retry: { kind: 'push', reason: 'The push failed' } })
    expect(deliveryDetail(work, ALL).actions.map((action) => action.kind)).toEqual([
      'retry',
      'merge',
      'hold',
      'stop',
    ])
  })

  it('leaves Hold and Stop where they were, with merge first', () => {
    const work = detail({})
    expect(workActions(work, ALL, work.hold, null, work.delivery).map((action) => action.kind)).toEqual([
      'merge',
      'hold',
      'stop',
    ])
  })
})

describe('the delivery section says what is true (§14, §18 honest state)', () => {
  const view = (work: WorkDetail) => deliveryDetail(work, ALL).delivery

  it('passing CI says GitHub passed it, with when it was read', () => {
    expect(view(detail({ ci: 'passing', ciReadAt: READ_AT })).ci).toMatch(
      /^GitHub reports the required checks passed\. Read /,
    )
  })

  it('no required checks never reads as passing, and says the card stays held (#34)', () => {
    const line = view(detail({ ci: 'none-required' })).ci
    expect(line).toContain('no required checks')
    expect(line).toContain('stays held')
    expect(line).not.toContain('passed')
  })

  it('failing, running and unreadable each say so', () => {
    expect(view(detail({ stage: 'pr-open', ci: 'failing' })).ci).toContain('failed')
    expect(view(detail({ stage: 'pr-open', ci: 'running' })).ci).toContain('still running')
    expect(view(detail({ stage: 'pr-open', ci: 'unreadable' })).ci).toContain('could not be read')
  })

  it('no reading stays no reading', () => {
    expect(view(detail({ stage: 'pr-open', ci: null })).ci).toBe('GitHub’s checks have not been read yet.')
    expect(view(detail({ stage: 'local-complete', ci: null, prNumber: null })).ci).toBeNull()
  })

  it('an open card is said, and the link is the served one', () => {
    const shown = view(detail({ mergeCardId: 'conf_1' }))
    expect(shown.waiting).toBe('The merge card is waiting in Needs you. Nothing merges until you approve it.')
    expect(shown.prUrl).toBe('https://github.com/acme/alpha/pull/7')
  })

  it('a link that is not https never becomes one', () => {
    expect(view(detail({ prUrl: 'javascript:alert(1)' })).prUrl).toBeNull()
  })

  it('a failure replaces "not recorded", and the plan footnote names it', () => {
    const work = detail(
      { stage: 'none', ci: null, prNumber: null, failure: 'Combined checks failed on bbbbbbb: unit.' },
      { stage: { key: 'working', label: 'Working', waitingOn: 'none' } },
    )
    const shown = deliveryDetail(work, ALL)
    expect(shown.delivery.failure).toBe('Combined checks failed on bbbbbbb: unit.')
    expect(shown.plan.footnote).toBe('Delivery failed: Combined checks failed on bbbbbbb: unit.')
  })

  it('with truly nothing recorded it still says so', () => {
    const work = decodeWorkDetail({ ...base, coverage: { ...base.coverage, delivery: false } })
    expect(deliveryDetail(work, ALL).plan.footnote).toBe('Delivery is not recorded yet')
  })
})

describe('Needs you lists blocked work and the count agrees (§18)', () => {
  const list = (items: NeedItem[], rows: WorkRow[] = []) => needsList(ready(needsPageOf(items)), rows, ALL)

  it('decodes a work need, and refuses an unknown kind', () => {
    expect(decodeNeedsPage(needsPageOf([blockedNeed])).items).toEqual([blockedNeed])
    expect(() =>
      decodeNeedsPage(needsPageOf([{ ...blockedNeed, kind: 'other' } as unknown as NeedItem])),
    ).toThrow()
  })

  it('counts it', () => {
    const needed = list([blockedNeed])
    expect(needed.waiting).toHaveLength(1)
    expect(needsCount(needed)).toBe(1)
  })

  it('a repository filter scopes it', () => {
    const other = needsList(ready(needsPageOf([blockedNeed])), [], { kind: 'repo', repoId: 'repo_b' })
    expect(needsCount(other)).toBe(0)
  })

  it('becomes a card that names the work, why, and what to do', () => {
    const card = needCard(
      blockedNeed,
      () => null,
      () => null,
      () => null,
    )
    expect(card).toEqual({
      kind: 'work',
      view: {
        id: 'wi_blocked',
        title: 'Add audit view: Blocked',
        body: 'Blocked: the build broke. Next: Resolve what blocks it.',
        repository: 'acme/alpha',
        workItemId: 'wi_blocked',
        actionable: true,
      },
    })
  })

  it('unassigned blocked work is on the page and not in the count: it cannot be cleared here', () => {
    const legacy = { ...blockedNeed, id: 'wi_old', repoId: null, repoLabel: null, readOnly: true }
    const shown = list([blockedNeed, legacy])
    expect(shown.waiting.map((item) => item.id)).toEqual([blockedNeed.id, 'wi_old'])
    expect(shown.count).toBe(1)
  })

  it('read-only work is shown and offers no way in', () => {
    const card = needCard(
      { ...blockedNeed, repoId: null, repoLabel: null, readOnly: true },
      () => null,
      () => null,
      () => null,
    )
    expect(card.kind === 'work' && card.view.actionable).toBe(false)
  })

  it('no reason recorded says the label alone, never a guess', () => {
    const card = needCard(
      { ...blockedNeed, reason: null, nextAction: null },
      () => null,
      () => null,
      () => null,
    )
    expect(card.kind === 'work' && card.view.body).toBe('No reason was recorded.')
  })
})

describe('Conversation shows that its work blocked (§18.1)', () => {
  const row = workRows[Object.keys(workRows)[0] as keyof typeof workRows] as WorkRow
  const blocked: WorkRow = {
    ...row,
    id: 'wi_b',
    title: 'Add audit view',
    repoId: 'repo_a',
    state: 'blocked',
    stage: { key: 'person/blocked', label: 'Blocked', waitingOn: 'person' },
    reason: 'Blocked: the build broke',
    nextAction: 'Resolve what blocks it',
  }
  const quiet: WorkRow = {
    ...row,
    id: 'wi_q',
    repoId: 'repo_a',
    stage: { key: 'working', label: 'Working', waitingOn: 'none' },
  }
  const foreign: WorkRow = { ...blocked, id: 'wi_f', repoId: 'repo_b' }

  it('names the blocked work in this repository, even when newer work leads', () => {
    const view = conversationView({ row: quiet, detail: null, messages: [], work: [blocked, quiet, foreign] })
    expect(view.blocked).toEqual([
      {
        id: 'wi_b',
        title: 'Add audit view is blocked',
        body: 'Blocked: the build broke. Next: Resolve what blocks it.',
      },
    ])
  })

  it('says nothing when nothing is blocked', () => {
    expect(conversationView({ row: quiet, detail: null, messages: [], work: [quiet] }).blocked).toEqual([])
  })
})

describe('an answer and a paused message show in the thread (§12.2, #27)', () => {
  const line: ChatLine = {
    id: 'msg_1',
    text: 'What does it do?',
    createdAt: READ_AT,
    workItemId: 'wi_1',
    kind: null,
    ackText: 'I will answer that here.',
  }

  it('decodes the held acknowledgement', () => {
    expect(decodeChatLines([{ ...line, pausedAck: 'Recorded.' }])[0]).toMatchObject({
      pausedAck: 'Recorded.',
    })
  })

  it('a paused message shows its acknowledgement while paused', () => {
    const { ackText: _ack, ...stored } = line
    const paused = { ...stored, pausedAck: 'Recorded. Processing is paused.' }
    const shown = (isPaused: boolean) =>
      conversationView({ row: null, detail: null, messages: [paused], paused: isPaused }).entries
    expect(shown(true).map((entry) => entry.text)).toEqual([
      'What does it do?',
      'Recorded. Processing is paused.',
    ])
    expect(shown(false).map((entry) => entry.text)).toEqual(['What does it do?'])
  })

  it('a real receipt replaces it', () => {
    const { entries } = conversationView({
      row: null,
      detail: null,
      messages: [{ ...line, pausedAck: 'Recorded.' }],
      paused: true,
    })
    expect(entries.map((entry) => entry.text)).toEqual(['What does it do?', 'I will answer that here.'])
  })
})

describe('the Diff tab shows the real diff or the truth (§15)', () => {
  const accepted = taskDetails[Object.keys(taskDetails)[0] as keyof typeof taskDetails] as TaskDetail
  const task = (change: Partial<TaskDetail>) =>
    taskScope(decodeTaskDetail({ ...accepted, status: 'accepted', attempts: [], ...change }), 'Work').diff
  const covered = { ...accepted.coverage, diff: true }
  const uncovered = { ...accepted.coverage, diff: false }

  it('lists real files, and a binary one says so instead of +0 -0', () => {
    expect(
      task({
        coverage: covered,
        diff: {
          headSha: HEAD,
          summary: '2 files changed',
          files: [
            { path: 'a.ts', added: 2, removed: 1 },
            { path: 'b.png', added: 0, removed: 0, binary: true },
          ],
          truncated: 0,
        },
      }).files,
    ).toEqual([
      { path: 'a.ts', lines: ['+2 -1'] },
      { path: 'b.png', lines: ['Binary file'] },
    ])
  })

  it('a head with no readable diff names the head, not "not recorded"', () => {
    const { summary } = task({
      coverage: uncovered,
      attempts: [
        {
          id: 'attempt_1',
          generation: 1,
          state: 'succeeded',
          role: null,
          requested: { tier: null, model: null },
          actual: null,
          baseSha: null,
          headSha: HEAD,
          processOutcome: 'exit 0',
          lastActivityAt: null,
        },
      ],
      diff: { headSha: null, summary: null, files: [], truncated: 0 },
    })
    expect(summary).toBe('Commit abc1230 is on record, but its file changes could not be read.')
  })

  it('with no head there is nothing to name', () => {
    const { summary } = task({
      coverage: uncovered,
      diff: { headSha: null, summary: null, files: [], truncated: 0 },
    })
    expect(summary).toBe('Not recorded yet')
  })
})

describe('the merge command (§13)', () => {
  const action: Extract<WorkAction, { kind: 'merge' }> = {
    kind: 'merge',
    label: 'Merge pull request #7',
    workItemId: 'wi_1',
    repoId: 'repo_a',
    repo: 'acme/alpha',
    prNumber: 7,
  }
  const rig = (merge: InspectionClient['merge']) => {
    const client = {
      work: async () => ({ items: [], nextCursor: null, observedAt: READ_AT }),
      needs: async () => ({ items: [], nextCursor: null, observedAt: READ_AT }),
      meta: async () => ({ observedAt: READ_AT, connection: null, repositories: [] }),
      merge,
    } as unknown as InspectionClient
    return createInspection(client)
  }

  afterEach(() => vi.useRealTimers())

  it('opens the card and says nothing merged', async () => {
    const calls: unknown[] = []
    const inspection = rig(async (input) => {
      calls.push(input)
      return { id: 'conf_1', status: 'card_open' }
    })
    inspection.act(action)
    await vi.waitFor(() => expect(inspection.getState().notice).not.toBeNull())
    expect(calls).toEqual([{ repo: 'acme/alpha', prNumber: 7, workItemId: 'wi_1' }])
    expect(inspection.getState().notice).toEqual({
      kind: 'done',
      text: 'The merge card is in Needs you. Nothing merges until you approve it.',
    })
  })

  it('a double press asks once', async () => {
    let count = 0
    const inspection = rig(async () => {
      count += 1
      return { id: 'conf_1', status: 'card_open' }
    })
    inspection.act(action)
    inspection.act(action)
    await vi.waitFor(() => expect(inspection.getState().notice).not.toBeNull())
    expect(count).toBe(1)
  })

  it('a refusal says why', async () => {
    const inspection = rig(async () => {
      throw new HttpError(409, 'conflict', 'delivery_not_ready')
    })
    inspection.act(action)
    await vi.waitFor(() => expect(inspection.getState().notice).not.toBeNull())
    expect(inspection.getState().notice).toEqual({
      kind: 'failed',
      text: 'The workbench refused this: delivery_not_ready.',
    })
  })
})

describe('Pause (§20)', () => {
  const OLD = { paused: false }
  const rig = (over: Partial<PauseClient> = {}) => {
    const client: PauseClient = {
      read: async () => OLD,
      pause: async () => ({ status: 'paused', pausedAt: READ_AT }),
      resume: async () => ({ status: 'running' }),
      ...over,
    }
    return createPause(client)
  }

  it('shows the server’s answer to the press, before any further read', async () => {
    let answered = false
    const pause = rig({
      read: () => new Promise(() => {}),
      pause: async () => {
        answered = true
        return { status: 'paused', pausedAt: READ_AT }
      },
    })
    await pause.toggle(false)
    expect(answered).toBe(true)
    expect(pause.getState().processing).toEqual({ paused: true, pausedAt: READ_AT })
  })

  it('a read that started before the press cannot undo it', async () => {
    const reads: ((value: { paused: boolean }) => void)[] = []
    const pause = rig({
      read: () =>
        new Promise((resolve) => {
          reads.push(resolve)
        }),
    })
    const before = pause.refresh()
    await pause.toggle(false)
    reads[0]?.(OLD)
    await before
    expect(pause.getState().processing?.paused).toBe(true)
  })

  it('the read after a press still lands', async () => {
    const reads: ((value: { paused: boolean; pausedAt?: string }) => void)[] = []
    const pause = rig({
      read: () =>
        new Promise((resolve) => {
          reads.push(resolve)
        }),
      pause: async () => ({ status: 'paused' }),
    })
    await pause.toggle(false)
    reads[0]?.({ paused: true, pausedAt: READ_AT })
    await vi.waitFor(() => expect(pause.getState().processing?.pausedAt).toBe(READ_AT))
  })

  it('a refused press keeps the state and says so', async () => {
    const pause = rig({
      pause: async () => {
        throw new Error('no')
      },
    })
    await pause.refresh()
    await pause.toggle(false)
    expect(pause.getState()).toMatchObject({
      processing: OLD,
      error: 'Could not pause. Still running.',
      busy: false,
    })
  })

  it('the banner time is a person’s, never ISO', () => {
    expect(pausedSince(READ_AT)).not.toContain('T10:00')
    expect(pausedSince(READ_AT)).not.toContain('Z')
    expect(pausedSince('not a time')).toBe('')
  })
})

describe('Connections line (§18.4)', () => {
  it('has no trailing comma with no provider', () => {
    expect(connectionLine('Claude Code', '2.1.318', '')).toBe('Claude Code 2.1.318')
    expect(connectionLine('Claude Code', '2.1.318', undefined)).toBe('Claude Code 2.1.318')
  })

  it('names what it knows', () => {
    expect(connectionLine('Claude Code', '2.1.318', 'anthropic')).toBe('Claude Code 2.1.318, anthropic')
    expect(connectionLine('Claude Code', undefined, 'anthropic')).toBe('Claude Code, anthropic')
  })
})
