import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EngineEvent } from '@mec/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AttemptJournal, SequenceError } from '../src/journal'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mec-journal-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function messageEvent(seq: number): EngineEvent {
  return {
    type: 'message',
    role: 'assistant',
    text: `event ${seq}`,
    seq,
    at: new Date().toISOString(),
    attempt_id: 'att_1',
    generation: 1,
  }
}

function exitEvent(seq: number): EngineEvent {
  return {
    type: 'exit',
    code: 0,
    terminal_reason: 'completed',
    seq,
    at: new Date().toISOString(),
    attempt_id: 'att_1',
    generation: 1,
  }
}

function appendThree(journal: AttemptJournal): void {
  journal.append(messageEvent(1))
  journal.append(messageEvent(2))
  journal.append(exitEvent(3))
}

describe('attempt journal', () => {
  it('create mode makes the directory; existing mode refuses a missing one', () => {
    expect(() => AttemptJournal.open(join(dir, 'attempts', 'att_1'), 'create')).not.toThrow()
    expect(() => AttemptJournal.open(join(dir, 'absent'), 'existing')).toThrow(/does not exist/)
  })

  it('appended events survive a reopen; pending is everything until the first ack', () => {
    const journal = AttemptJournal.open(dir)
    appendThree(journal)
    const reopened = AttemptJournal.open(dir, 'existing')
    expect(reopened.events()).toEqual(journal.events())
    expect(reopened.lastSeq()).toBe(3)
    expect(reopened.ackedSeq()).toBeNull()
    expect(reopened.pending().map((e) => e.seq)).toEqual([1, 2, 3])
    reopened.ack(2)
    expect(reopened.pending().map((e) => e.seq)).toEqual([3])
  })

  it('a seq equal to or lower than the last refuses with SequenceError', () => {
    const journal = AttemptJournal.open(dir)
    journal.append(messageEvent(4))
    expect(() => journal.append(messageEvent(4))).toThrow(SequenceError)
    expect(() => journal.append(messageEvent(3))).toThrow(SequenceError)
    expect(journal.lastSeq()).toBe(4)
    expect(journal.events()).toHaveLength(1)
    // The refusal also holds for events loaded from disk, not just this instance's appends.
    const reopened = AttemptJournal.open(dir, 'existing')
    expect(() => reopened.append(messageEvent(4))).toThrow(SequenceError)
    expect(() => reopened.append(messageEvent(2))).toThrow(SequenceError)
  })

  it('the ack cursor persists across a reopen; a backwards ack refuses', () => {
    const journal = AttemptJournal.open(dir)
    appendThree(journal)
    journal.ack(1)
    const reopened = AttemptJournal.open(dir, 'existing')
    expect(reopened.ackedSeq()).toBe(1)
    expect(reopened.pending().map((e) => e.seq)).toEqual([2, 3])
    expect(() => reopened.ack(0)).toThrow(SequenceError)
    expect(reopened.ackedSeq()).toBe(1)
    reopened.ack(1) // Equal is not backwards.
    expect(reopened.ackedSeq()).toBe(1)
  })

  it('a torn final line is skipped on load and the valid prefix replays', () => {
    const journal = AttemptJournal.open(dir)
    journal.append(messageEvent(1))
    journal.append(messageEvent(2))
    appendFileSync(join(dir, 'events.jsonl'), '{"type":"message","seq":3,"text"')
    const reopened = AttemptJournal.open(dir, 'existing')
    expect(reopened.events().map((e) => e.seq)).toEqual([1, 2])
    expect(reopened.lastSeq()).toBe(2)
  })

  it('events(afterSeq) returns only the events past that seq', () => {
    const journal = AttemptJournal.open(dir)
    appendThree(journal)
    expect(journal.events(1).map((e) => e.seq)).toEqual([2, 3])
    expect(journal.events(3)).toEqual([])
    expect(journal.events()).toHaveLength(3)
  })
})
