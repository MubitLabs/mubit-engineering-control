import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AlreadyHandledError, HttpError } from '../src/api'
import { DecodeError } from '../src/api-decode'
import { createInspection, type InspectionClient, readFailure } from '../src/live/inspection'
import type {
  ActivityItem,
  CardEvidence,
  NeedItem,
  Page,
  TaskDetail,
  WorkDetail,
  WorkRow,
} from '../src/next/inspection-wire'
import { DENIED, needsList } from '../src/next/work-model'
import {
  activityItems,
  artifactPages,
  cardEvidence,
  needs,
  searchPage,
  taskDetails,
  workDetails,
  workPage,
  workRows,
} from './fixtures/inspection-fixtures'

const OBSERVED = '2026-11-05T10:00:00.000Z'
const needsOf = (items: NeedItem[], nextCursor: string | null = null): Page<NeedItem> => ({
  items,
  nextCursor,
  observedAt: OBSERVED,
})
const workOf = (items: WorkRow[], nextCursor: string | null = null): Page<WorkRow> => ({
  items,
  nextCursor,
  observedAt: OBSERVED,
})
const activityOf = (items: ActivityItem[], nextCursor: string | null = null): Page<ActivityItem> => ({
  items,
  nextCursor,
  observedAt: OBSERVED,
})
const workOfId = (id: string) => workDetails[id as keyof typeof workDetails] as WorkDetail
const taskOfId = (id: string) => taskDetails[id as keyof typeof taskDetails] as TaskDetail

function rig(over: Partial<InspectionClient> = {}) {
  const calls: string[] = []
  const client: InspectionClient = {
    work: async () => workPage as Page<WorkRow>,
    needs: async () => needsOf([needs.pending, needs.question]),
    workDetail: async (id) => workOfId(id),
    taskDetail: async (id) => taskOfId(id),
    evidence: async (id) => cardEvidence[id as keyof typeof cardEvidence] as CardEvidence,
    search: async () => searchPage,
    hold: async (id) => {
      calls.push(`hold ${id}`)
      return { id, status: 'held' }
    },
    lift: async (id) => {
      calls.push(`lift ${id}`)
      return { id, status: 'lifted' }
    },
    stop: async (id) => {
      calls.push(`stop ${id}`)
      return { id, status: 'stopped' }
    },
    resolve: async (id, answer) => {
      calls.push(`${answer} ${id}`)
      return { status: answer === 'approve' ? 'approved' : 'denied' }
    },
    answer: async (id, text) => {
      calls.push(`answer ${id} ${text}`)
    },
    activity: async (id, cursor) => {
      calls.push(`activity ${id} ${cursor}`)
      return activityOf([])
    },
    artifact: async (id, ref, cursor) => {
      calls.push(`artifact ${id} ${ref} ${cursor}`)
      return artifactPages.text
    },
    ...over,
  }
  return { inspection: createInspection(client), calls, settle: () => vi.advanceTimersByTimeAsync(0) }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(OBSERVED))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('activity', () => {
  const ACTIVE = 'attempt_active'
  const STREAM = `attempt:${ACTIVE}`
  const line = (seq: number): ActivityItem => ({ ...activityItems.tool, seq })
  const activityCalls = (calls: string[]) => calls.filter((call) => call.startsWith('activity'))
  const shownSeqs = (inspection: ReturnType<typeof rig>['inspection']) => {
    const { read } = inspection.getState().activity
    return read.status === 'loading' ? null : (read.data?.items.map((item) => item.seq) ?? null)
  }

  it('a task’s latest attempt is read from the start', async () => {
    const { inspection, calls, settle } = rig()
    inspection.selectTask('task_active')
    await settle()
    expect(activityCalls(calls)).toEqual([`activity ${ACTIVE} null`])
    expect(inspection.getState().activity.attemptId).toBe(ACTIVE)
  })

  it('coverage false reads no activity', async () => {
    const { inspection, calls, settle } = rig()
    inspection.selectTask('task_partial')
    await settle()
    expect(activityCalls(calls)).toEqual([])
    expect(inspection.getState().activity.attemptId).toBeNull()
  })

  it('a frame for the attempt on show rereads the last page, and a repeat is applied once', async () => {
    const asked: (string | null)[] = []
    const { inspection, settle } = rig({
      activity: async (_id, cursor) => {
        asked.push(cursor)
        return cursor === null ? activityOf([line(1), line(2)]) : activityOf([])
      },
    })
    inspection.selectTask('task_active')
    await settle()
    inspection.invalidate(STREAM)
    await settle()
    expect(asked).toEqual([null, null])
    expect(shownSeqs(inspection)).toEqual([1, 2])
  })

  it('a frame for another stream reads nothing', async () => {
    const { inspection, calls, settle } = rig()
    inspection.selectTask('task_active')
    await settle()
    inspection.invalidate('attempt:other')
    inspection.invalidate('work:work_working')
    await settle()
    expect(activityCalls(calls)).toHaveLength(1)
  })

  it('more follows the cursor and keeps what was read', async () => {
    const asked: (string | null)[] = []
    const { inspection, settle } = rig({
      activity: async (_id, cursor) => {
        asked.push(cursor)
        return cursor === null ? activityOf([line(1)], 'c1') : activityOf([line(2)], 'c2')
      },
    })
    inspection.selectTask('task_active')
    await settle()
    inspection.moreActivity()
    await settle()
    expect(asked).toEqual([null, 'c1'])
    expect(shownSeqs(inspection)).toEqual([1, 2])
    inspection.invalidate(STREAM)
    await settle()
    expect(asked).toEqual([null, 'c1', 'c1'])
    expect(shownSeqs(inspection)).toEqual([1, 2])
  })

  it('a frame during more waits for it instead of cancelling it', async () => {
    const asked: (string | null)[] = []
    let finish: (page: Page<ActivityItem>) => void = () => {}
    const { inspection, settle } = rig({
      activity: async (_id, cursor) => {
        asked.push(cursor)
        if (cursor === null) return activityOf([line(1)], 'c1')
        if (asked.length === 2) return new Promise((resolve) => (finish = resolve))
        return activityOf([line(3)])
      },
    })
    inspection.selectTask('task_active')
    await settle()
    inspection.moreActivity()
    inspection.invalidate(STREAM)
    await settle()
    expect(asked).toEqual([null, 'c1'])
    finish(activityOf([line(2)]))
    await settle()
    expect(asked).toEqual([null, 'c1', 'c1'])
    expect(shownSeqs(inspection)).toEqual([1, 2, 3])
  })

  it('a failed reread keeps the lines and when they were read', async () => {
    let up = true
    const { inspection, settle } = rig({
      activity: async () => {
        if (!up) throw new Error('down')
        return activityOf([line(1)])
      },
    })
    inspection.selectTask('task_active')
    await settle()
    up = false
    inspection.invalidate(STREAM)
    await settle()
    const { read } = inspection.getState().activity
    expect(read.status).toBe('failed')
    expect(shownSeqs(inspection)).toEqual([1])
    expect(read).toMatchObject({ readAt: OBSERVED })
  })

  it('choosing an attempt reads that attempt, and a refresh stays on it', async () => {
    const detail = taskOfId('task_active')
    const first = detail.attempts[0] as TaskDetail['attempts'][number]
    const { inspection, calls, settle } = rig({
      taskDetail: async () => ({
        ...detail,
        attempts: [{ ...first, id: 'attempt_old', generation: 0 }, first],
      }),
    })
    inspection.selectTask('task_active')
    await settle()
    inspection.selectAttempt('attempt_old')
    await settle()
    inspection.refresh()
    await settle()
    expect(inspection.getState().activity.attemptId).toBe('attempt_old')
    expect(activityCalls(calls)).toEqual([
      `activity ${ACTIVE} null`,
      'activity attempt_old null',
      'activity attempt_old null',
    ])
  })

  it('a newer attempt takes over unless one was chosen', async () => {
    const detail = taskOfId('task_active')
    const first = detail.attempts[0] as TaskDetail['attempts'][number]
    let attempts = [first]
    const { inspection, settle } = rig({ taskDetail: async () => ({ ...detail, attempts }) })
    inspection.selectTask('task_active')
    await settle()
    attempts = [first, { ...first, id: 'attempt_new', generation: 2 }]
    inspection.refresh()
    await settle()
    expect(inspection.getState().activity.attemptId).toBe('attempt_new')
  })

  it('another task starts clean: nothing of the last one stays', async () => {
    const { inspection, settle } = rig({ activity: async () => activityOf([line(1)]) })
    inspection.selectTask('task_active')
    await settle()
    inspection.openArtifact(ACTIVE, 'out/run.log')
    await settle()
    inspection.selectTask('task_done')
    expect(inspection.getState().activity).toEqual({ attemptId: null, read: { status: 'loading' } })
    expect(inspection.getState().artifact).toBeNull()
    await settle()
    expect(inspection.getState().activity.attemptId).toBe('attempt_done')
  })

  it('a late answer for the last attempt is dropped', async () => {
    let finish: (page: Page<ActivityItem>) => void = () => {}
    const { inspection, settle } = rig({
      activity: (id) =>
        id === ACTIVE ? new Promise((resolve) => (finish = resolve)) : Promise.resolve(activityOf([line(9)])),
    })
    inspection.selectTask('task_active')
    await settle()
    inspection.selectTask('task_done')
    await settle()
    finish(activityOf([line(1)]))
    await settle()
    expect(shownSeqs(inspection)).toEqual([9])
  })
})

describe('artifacts', () => {
  const ATT = 'attempt_active'

  it('opens, follows the cursor and appends', async () => {
    const asked: (string | null)[] = []
    const { inspection, settle } = rig({
      artifact: async (_id, _ref, cursor) => {
        asked.push(cursor)
        return cursor === null
          ? artifactPages.text
          : { ...artifactPages.text, text: 'second', nextCursor: null }
      },
    })
    inspection.openArtifact(ATT, 'out/run.log')
    await settle()
    inspection.moreArtifact()
    await settle()
    expect(asked).toEqual([null, 'cursor-artifact'])
    expect(inspection.getState().artifact?.read).toMatchObject({
      status: 'ready',
      data: { kind: 'text', text: 'SAMPLE-ONLY log\nsecond', nextCursor: null },
    })
  })

  it('a second open of the same file closes it', async () => {
    const { inspection, settle } = rig()
    inspection.openArtifact(ATT, 'out/run.log')
    await settle()
    inspection.openArtifact(ATT, 'out/run.log')
    expect(inspection.getState().artifact).toBeNull()
  })

  it('a refused or missing file has its own words, and retry reads again', async () => {
    let status = 403
    const { inspection, settle } = rig({
      artifact: async () => {
        throw new HttpError('/x', status)
      },
    })
    inspection.openArtifact(ATT, '.mec/x')
    await settle()
    expect(inspection.getState().artifact?.read).toMatchObject({
      status: 'failed',
      message: 'The workbench does not serve this file.',
    })
    status = 404
    inspection.retryArtifact()
    await settle()
    expect(inspection.getState().artifact?.read).toMatchObject({
      status: 'failed',
      message: 'This file is not there any more.',
    })
  })

  it('a late answer for a closed file is dropped', async () => {
    let finish: (page: typeof artifactPages.text) => void = () => {}
    const { inspection, settle } = rig({
      artifact: () => new Promise((resolve) => (finish = resolve)),
    })
    inspection.openArtifact(ATT, 'out/run.log')
    inspection.openArtifact(ATT, 'out/run.log')
    finish(artifactPages.text)
    await settle()
    expect(inspection.getState().artifact).toBeNull()
  })
})

describe('reads', () => {
  it('walks every page, so a list is whole before it is counted', async () => {
    const asked: (string | null)[] = []
    const { inspection, settle } = rig({
      needs: async (cursor) => {
        asked.push(cursor)
        return cursor === null ? needsOf([needs.pending], 'next') : needsOf([needs.question])
      },
    })
    inspection.refresh()
    await settle()
    expect(asked).toEqual([null, 'next'])
    expect(needsList(inspection.getState().needs, [], { kind: 'all' }).count).toBe(2)
  })

  it('a walk that stops at its cap keeps the cursor, so the list says it is partial', async () => {
    const { inspection, settle } = rig({ needs: async () => needsOf([needs.pending], 'next') })
    inspection.refresh()
    await settle()
    expect(needsList(inspection.getState().needs, [], { kind: 'all' })).toMatchObject({
      count: null,
      partial: true,
    })
  })

  it('a failure keeps the last good list and when it was read', async () => {
    let fail = false
    const { inspection, settle } = rig({
      work: async () => {
        if (fail) throw new Error('down')
        return workPage as Page<WorkRow>
      },
    })
    inspection.refresh()
    await settle()
    fail = true
    vi.setSystemTime(new Date('2026-11-05T10:05:00.000Z'))
    inspection.refresh()
    await settle()
    expect(inspection.getState().work).toMatchObject({
      status: 'failed',
      data: workPage,
      readAt: OBSERVED,
    })
  })

  it('still rereads an open card’s evidence on every refresh', async () => {
    const asked: string[] = []
    const { inspection, settle } = rig({
      needs: async () => needsOf([needs.pending]),
      evidence: async (id) => {
        asked.push(id)
        return cardEvidence.card_pending as CardEvidence
      },
    })
    inspection.refresh()
    await settle()
    inspection.refresh()
    await settle()
    expect(asked).toEqual(['card_pending', 'card_pending'])
  })

  it('an older refresh never overwrites a newer one', async () => {
    const answers: ((page: Page<WorkRow>) => void)[] = []
    const { inspection, settle } = rig({
      work: () => new Promise((resolve) => answers.push(resolve)),
    })
    inspection.refresh()
    inspection.refresh()
    answers[1]?.(workOf([workRows.held]))
    await settle()
    answers[0]?.(workOf([workRows.working]))
    await settle()
    const read = inspection.getState().work
    expect(read.status === 'ready' && read.data.items.map((row) => row.id)).toEqual(['work_held'])
  })

  it('an over-large answer is a recoverable failure with its own words', () => {
    const tooLarge = new HttpError('/api/inspect/work', 500, 'response_too_large')
    expect(readFailure(tooLarge)).toContain('too large')
    expect(readFailure(new HttpError('/x', 500))).toContain('500')
    expect(readFailure(new DecodeError('/x', 'bad'))).toContain('could not be read')
    expect(readFailure(new TypeError('fetch failed'))).toContain('did not answer')
  })

  it('evidence that can no longer be read is not kept as if current', async () => {
    let fail = false
    const { inspection, settle } = rig({
      evidence: async () => {
        if (fail) throw new Error('down')
        return cardEvidence.card_pending
      },
    })
    inspection.refresh()
    await settle()
    expect(inspection.getState().evidence[needs.pending.id]).toBeDefined()
    fail = true
    inspection.refresh()
    await settle()
    expect(inspection.getState().evidence[needs.pending.id]).toBeUndefined()
  })

  it('reads an open card’s evidence, and not a settled one’s', async () => {
    const asked: string[] = []
    const { inspection, settle } = rig({
      needs: async () => needsOf([needs.pending, needs.resolved]),
      evidence: async (id) => {
        asked.push(id)
        return cardEvidence.card_pending
      },
    })
    inspection.refresh()
    await settle()
    expect(asked).toEqual([needs.pending.id])
    expect(inspection.getState().evidence[needs.pending.id]).toBe(cardEvidence.card_pending)
  })

  it('reads the settled cards on show, so a reload does not lose them', async () => {
    const { inspection } = rig()
    await inspection.readSettledEvidence([needs.resolved.id])
    expect(inspection.getState().evidence[needs.resolved.id]).toBe(cardEvidence.card_resolved)
  })

  it('reads a settled card once, one at a time, and skips what it holds', async () => {
    const asked: string[] = []
    let inFlight = 0
    let most = 0
    const { inspection } = rig({
      evidence: async (id) => {
        asked.push(id)
        inFlight += 1
        most = Math.max(most, inFlight)
        await Promise.resolve()
        inFlight -= 1
        return cardEvidence[id as keyof typeof cardEvidence] as CardEvidence
      },
    })
    await inspection.readEvidence(needs.expired.id)
    const ids = [needs.resolved.id, needs.expired.id, needs.pending.id]
    await inspection.readSettledEvidence(ids)
    await inspection.readSettledEvidence(ids)
    expect(asked).toEqual([needs.expired.id, needs.resolved.id, needs.pending.id])
    expect(most).toBe(1)
  })

  it('a settled read that fails waits for its Retry, and never loops', async () => {
    let fail = true
    let reads = 0
    const { inspection } = rig({
      evidence: async () => {
        reads += 1
        if (fail) throw new Error('down')
        return cardEvidence.card_resolved
      },
    })
    await inspection.readSettledEvidence([needs.resolved.id])
    await inspection.readSettledEvidence([needs.resolved.id])
    expect(reads).toBe(1)
    expect(inspection.getState().evidence[needs.resolved.id]).toBeUndefined()
    fail = false
    await inspection.readEvidence(needs.resolved.id)
    expect(inspection.getState().evidence[needs.resolved.id]).toBe(cardEvidence.card_resolved)
  })

  it('a failed evidence read leaves nothing to approve on, then retries', async () => {
    let fail = true
    const { inspection, settle } = rig({
      evidence: async () => {
        if (fail) throw new Error('down')
        return cardEvidence.card_pending
      },
    })
    inspection.refresh()
    await settle()
    expect(inspection.getState().evidence[needs.pending.id]).toBeUndefined()
    fail = false
    inspection.readEvidence(needs.pending.id)
    await settle()
    expect(inspection.getState().evidence[needs.pending.id]).toBe(cardEvidence.card_pending)
  })
})

describe('one selected detail', () => {
  it('a late answer for the last selection never paints', async () => {
    const answers: (() => void)[] = []
    const { inspection, settle } = rig({
      taskDetail: (id) =>
        new Promise((resolve) => {
          answers.push(() => resolve(taskOfId(id)))
        }),
    })
    inspection.selectTask('task_done')
    inspection.selectTask('task_active')
    answers[1]?.()
    await settle()
    answers[0]?.()
    await settle()
    const { task } = inspection.getState()
    expect(task.id).toBe('task_active')
    expect(task.read.status === 'ready' && task.read.data.id).toBe('task_active')
  })

  it('selecting nothing reads nothing', async () => {
    let reads = 0
    const { inspection, settle } = rig({
      workDetail: async (id) => {
        reads += 1
        return workOfId(id)
      },
    })
    inspection.refresh()
    await settle()
    expect(reads).toBe(0)
    inspection.selectWork('work_held')
    await settle()
    expect(reads).toBe(1)
    inspection.selectWork(null)
    inspection.refresh()
    await settle()
    expect(reads).toBe(1)
  })

  it('a failed detail keeps what it had for that id only', async () => {
    let fail = false
    const { inspection, settle } = rig({
      workDetail: async (id) => {
        if (fail) throw new Error('down')
        return workOfId(id)
      },
    })
    inspection.selectWork('work_held')
    await settle()
    fail = true
    inspection.refresh()
    await settle()
    expect(inspection.getState().delivery.read).toMatchObject({
      status: 'failed',
      data: workDetails.work_held,
    })
    inspection.selectWork('work_working')
    await settle()
    expect(inspection.getState().delivery.read).toMatchObject({ status: 'failed', data: null })
  })
})

describe('decisions', () => {
  it('a deny reads as denied, not as describeApproval’s fall-through', async () => {
    const { inspection, calls, settle } = rig()
    inspection.settle('card_pending', 'deny')
    await settle()
    expect(calls).toEqual(['deny card_pending'])
    expect(inspection.getState().outcomes.card_pending).toEqual(DENIED)
  })

  it('a hold keeps the card open and names why', async () => {
    const { inspection, settle } = rig({
      resolve: async () => ({ status: 'pending', reason: 'ci_pending' }),
    })
    inspection.settle('card_pending', 'approve')
    await settle()
    expect(inspection.getState().outcomes.card_pending).toMatchObject({ closes: false })
    expect(inspection.getState().outcomes.card_pending?.toast).toContain('still running')
  })

  it('a double confirm sends once', async () => {
    const { inspection, calls, settle } = rig()
    inspection.settle('card_pending', 'approve')
    inspection.settle('card_pending', 'approve')
    await settle()
    expect(calls).toEqual(['approve card_pending'])
  })

  it('someone answering first closes the card and says so', async () => {
    const { inspection, settle } = rig({
      resolve: async () => {
        throw new AlreadyHandledError()
      },
    })
    inspection.settle('card_pending', 'approve')
    await settle()
    expect(inspection.getState().outcomes.card_pending).toMatchObject({
      closes: true,
      note: 'Already handled',
    })
  })

  it('a click that never answered keeps the card open and claims nothing ran', async () => {
    const { inspection, settle } = rig({
      resolve: async () => {
        throw new TypeError('fetch failed')
      },
    })
    inspection.settle('card_pending', 'approve')
    await settle()
    const outcome = inspection.getState().outcomes.card_pending
    expect(outcome?.closes).toBe(false)
    expect(outcome?.toast).toContain('may not have')
  })

  it('a 409 on an answer is already answered', async () => {
    const { inspection, settle } = rig({
      answer: async () => {
        throw new HttpError('/api/questions/q/answer', 409, 'already_answered')
      },
    })
    inspection.answer('q', 'yes')
    await settle()
    expect(inspection.getState().answers.q).toEqual({ kind: 'already-answered' })
  })

  it('an answer that did not land stays open and says so', async () => {
    const { inspection, settle } = rig({
      answer: async () => {
        throw new TypeError('fetch failed')
      },
    })
    inspection.answer('q', 'yes')
    await settle()
    expect(inspection.getState().answers.q).toMatchObject({ kind: 'failed' })
  })

  it('a landed answer re-reads the list', async () => {
    let reads = 0
    const { inspection, settle } = rig({
      needs: async () => {
        reads += 1
        return needsOf([needs.question])
      },
    })
    inspection.answer('q', 'yes')
    await settle()
    expect(inspection.getState().answers.q).toEqual({ kind: 'answered', answer: 'yes' })
    expect(reads).toBe(1)
  })
})

describe('owner commands', () => {
  const stop = { kind: 'stop', label: 'Stop', workItemId: 'work_x', repoId: 'repo_b' } as const

  it('acts on the item’s own id', async () => {
    const { inspection, calls, settle } = rig()
    inspection.act(stop)
    await settle()
    expect(calls).toEqual(['stop work_x'])
    expect(inspection.getState().notice).toMatchObject({ kind: 'done' })
  })

  it('a refused command says the server’s reason', async () => {
    const { inspection, settle } = rig({
      lift: async () => {
        throw new HttpError('/api/work/x/lift', 409, 'no_planner')
      },
    })
    inspection.act({ ...stop, kind: 'lift' })
    await settle()
    expect(inspection.getState().notice).toMatchObject({ kind: 'failed' })
    expect(inspection.getState().notice?.text).toContain('no_planner')
  })

  it('a lift on free work says it was not held', async () => {
    const { inspection, settle } = rig({ lift: async () => ({ id: 'x', status: 'free' }) })
    inspection.act({ ...stop, kind: 'lift' })
    await settle()
    expect(inspection.getState().notice?.text).toContain('was not held')
  })
})

describe('search', () => {
  it('debounces, and an empty query reads nothing', async () => {
    const asked: string[] = []
    const { inspection } = rig({
      search: async (q) => {
        asked.push(q)
        return searchPage
      },
    })
    inspection.setQuery('a')
    inspection.setQuery('ab')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(asked).toEqual(['ab'])
    inspection.setQuery('  ')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(asked).toEqual(['ab'])
    expect(inspection.getState().search).toMatchObject({ status: 'ready', data: { items: [] } })
  })

  it('a late answer to an older query is dropped', async () => {
    const answers: (() => void)[] = []
    const { inspection, settle } = rig({
      search: (q) =>
        new Promise((resolve) => {
          answers.push(() => resolve({ ...searchPage, items: q === 'new' ? [] : searchPage.items }))
        }),
    })
    inspection.setQuery('old')
    await vi.advanceTimersByTimeAsync(1_000)
    inspection.setQuery('new')
    await vi.advanceTimersByTimeAsync(1_000)
    answers[1]?.()
    await settle()
    answers[0]?.()
    await settle()
    expect(inspection.getState().search).toMatchObject({ status: 'ready', data: { items: [] } })
  })
})
