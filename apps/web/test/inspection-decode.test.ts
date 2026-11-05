import { describe, expect, it } from 'vitest'
import { DecodeError } from '../src/api-decode'
import {
  decodeCardEvidence,
  decodeChatLines,
  decodeNeedsPage,
  decodeSearchPage,
  decodeTaskDetail,
  decodeWorkDetail,
  decodeWorkPage,
} from '../src/inspection-decode'
import {
  cardEvidence,
  chatLines,
  needsPage,
  searchPage,
  taskDetails,
  workDetails,
  workPage,
} from './fixtures/inspection-fixtures'

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
