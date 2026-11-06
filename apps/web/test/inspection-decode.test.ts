import { describe, expect, it } from 'vitest'
import { DecodeError } from '../src/api-decode'
import {
  decodeActivityPage,
  decodeArtifact,
  decodeCardEvidence,
  decodeChatLines,
  decodeNeedsPage,
  decodeSearchPage,
  decodeSnapshot,
  decodeTaskDetail,
  decodeWorkDetail,
  decodeWorkPage,
} from '../src/inspection-decode'
import {
  activityPage,
  artifactPages,
  cardEvidence,
  chatLines,
  needsPage,
  searchPage,
  storedLines,
  taskDetails,
  workDetails,
  workPage,
} from './fixtures/inspection-fixtures'

describe('activity and artifacts', () => {
  it('an activity page survives its decoder unchanged', () => {
    expect(decodeActivityPage(activityPage)).toEqual(activityPage)
  })

  it('an activity line with no seq rejects', () => {
    const { seq: _seq, ...line } = activityPage.items[0] as (typeof activityPage.items)[number]
    expect(() => decodeActivityPage({ ...activityPage, items: [line] })).toThrow(DecodeError)
  })

  it('an activity page with no cursor rejects', () => {
    const { nextCursor: _cursor, ...rest } = activityPage
    expect(() => decodeActivityPage(rest)).toThrow(DecodeError)
  })

  it('a text artifact keeps its size and next cursor', () => {
    expect(
      decodeArtifact('out/run.log', {
        contentType: 'text/plain; charset=utf-8',
        body: 'SAMPLE-ONLY log\n',
        size: '1536',
        next: 'cursor-artifact',
      }),
    ).toEqual(artifactPages.text)
  })

  it('JSON served as text stays text', () => {
    const page = decodeArtifact('a.json', {
      contentType: 'text/plain; charset=utf-8',
      body: '{"binary":true,"size":1}',
      size: '24',
      next: null,
    })
    expect(page).toMatchObject({ kind: 'text', text: '{"binary":true,"size":1}' })
  })

  it('a binary artifact is metadata only', () => {
    expect(
      decodeArtifact('out/image.png', {
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ ref: 'out/image.png', binary: true, size: 2048 }),
        size: null,
        next: null,
      }),
    ).toEqual(artifactPages.binary)
  })

  it('a text artifact with no size rejects', () => {
    expect(() =>
      decodeArtifact('a.txt', { contentType: 'text/plain', body: 'x', size: null, next: null }),
    ).toThrow(DecodeError)
  })

  it('a JSON answer that is not the binary shape rejects', () => {
    expect(() =>
      decodeArtifact('a.txt', { contentType: 'application/json', body: '{}', size: null, next: null }),
    ).toThrow(DecodeError)
  })
})

describe('inspection decoders', () => {
  it('every fixture survives its decoder unchanged', () => {
    expect(decodeWorkPage(workPage)).toEqual(workPage)
    expect(decodeNeedsPage(needsPage)).toEqual(needsPage)
    expect(decodeSearchPage(searchPage)).toEqual(searchPage)
    expect(decodeChatLines(chatLines)).toEqual(chatLines)
    for (const detail of Object.values(workDetails)) expect(decodeWorkDetail(detail)).toEqual(detail)
    for (const detail of Object.values(taskDetails)) expect(decodeTaskDetail(detail)).toEqual(detail)
    for (const detail of Object.values(cardEvidence)) expect(decodeCardEvidence(detail)).toEqual(detail)
  })

  it('a stored message with no kind keeps its acknowledgement and guard', () => {
    expect(decodeChatLines(storedLines)).toEqual(storedLines)
  })

  it('a detail without its truncation count rejects, because a cut would read as complete', () => {
    const { work_working } = workDetails
    const { tasksTruncated: _tasks, ...noTasks } = work_working
    expect(() => decodeWorkDetail(noTasks)).toThrow(DecodeError)
    const { cursorsTruncated: _cursors, ...noCursors } = work_working
    expect(() => decodeWorkDetail(noCursors)).toThrow(DecodeError)
    const { attemptsTruncated: _attempts, ...noAttempts } = taskDetails.task_done
    expect(() => decodeTaskDetail(noAttempts)).toThrow(DecodeError)
    const { dependsOnTruncated: _depends, ...noDepends } = taskDetails.task_done
    expect(() => decodeTaskDetail(noDepends)).toThrow(DecodeError)
  })

  it('an absent card detail stays marked absent', () => {
    expect(decodeCardEvidence({ ...cardEvidence.card_pending, absent: true }).absent).toBe(true)
    expect('absent' in decodeCardEvidence(cardEvidence.card_pending)).toBe(false)
  })

  it('a snapshot needs its cursors', () => {
    const snapshot = {
      observedAt: 'now',
      repositories: [{ id: 'repo_a', label: 'sample', needsCount: 1 }],
      repositoriesTruncated: 0,
      needsCount: 1,
      cursors: { repositories: 3 },
    }
    expect(decodeSnapshot(snapshot)).toEqual(snapshot)
    expect(() => decodeSnapshot({ ...snapshot, cursors: undefined })).toThrow(DecodeError)
  })

  it('malformed work page rejects', () => {
    expect(() => decodeWorkPage(null)).toThrow(DecodeError)
    expect(() => decodeWorkPage({ ...workPage, items: 'rows' })).toThrow(DecodeError)
    const [first] = workPage.items
    expect(() => decodeWorkPage({ ...workPage, items: [{ ...first, stage: 'working' }] })).toThrow(
      DecodeError,
    )
    expect(() =>
      decodeWorkPage({ ...workPage, items: [{ ...first, taskCounts: { total: 'three', byStatus: {} } }] }),
    ).toThrow(DecodeError)
    expect(() =>
      decodeWorkPage({
        ...workPage,
        items: [{ ...first, stage: { key: 'x', label: 'X', waitingOn: 'nobody' } }],
      }),
    ).toThrow(DecodeError)
  })

  it('unknown stage key still renders its label', () => {
    const [first] = workPage.items
    const stage = { key: 'a-stage-from-the-future', label: 'Later label', waitingOn: 'none' }
    expect(decodeWorkPage({ ...workPage, items: [{ ...first, stage }] }).items[0]?.stage).toEqual(stage)
  })

  it('missing cursor rejects', () => {
    const { nextCursor: _dropped, ...withoutCursor } = workPage
    expect(() => decodeWorkPage(withoutCursor)).toThrow(/nextCursor/)
    expect(() => decodeNeedsPage({ items: [], observedAt: 'now' })).toThrow(/nextCursor/)
    expect(decodeWorkPage({ ...workPage, nextCursor: 'abc' }).nextCursor).toBe('abc')
  })

  it('an unknown need kind or status rejects instead of guessing', () => {
    expect(() => decodeNeedsPage({ ...needsPage, items: [{ kind: 'mystery', id: 'x' }] })).toThrow(
      DecodeError,
    )
    const [first] = needsPage.items
    expect(() => decodeNeedsPage({ ...needsPage, items: [{ ...first, status: 'done' }] })).toThrow(
      DecodeError,
    )
  })

  it('a task detail with a missing evidence block rejects', () => {
    const { checks: _dropped, ...partial } = taskDetails.task_done
    expect(() => decodeTaskDetail(partial)).toThrow(/checks/)
  })

  it('card evidence as the release route serves it: no verb, no note, no mono', () => {
    const { verb: _dropped, ...rest } = cardEvidence.card_pending
    const decoded = decodeCardEvidence({
      ...rest,
      findings: [],
      checks: [{ name: 'a', state: 'none' }],
      facts: [{ label: 'a', value: 'b' }],
    })
    expect(decoded.verb).toBeNull()
    expect(decoded.checks[0]?.note).toBeNull()
    expect(decoded.facts[0]?.mono).toBe(false)
  })

  it('a chat line with no kind or work item decodes to null, not a guess', () => {
    expect(decodeChatLines([{ id: 'a', text: 'b', createdAt: 'c' }])).toEqual([
      { id: 'a', text: 'b', createdAt: 'c', kind: null, workItemId: null },
    ])
  })
})
