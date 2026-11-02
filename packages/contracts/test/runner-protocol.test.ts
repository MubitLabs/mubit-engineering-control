import { describe, expect, it } from 'vitest'
import { RunnerEventEnvelope } from '../src'

const pdfExample = {
  schemaVersion: 1,
  eventId: 'runner-local-unique-id',
  runnerId: 'runner_a',
  attemptId: 'attempt_17',
  generation: 3,
  sequence: 84,
  type: 'approval.requested',
  occurredAt: '2026-11-02T12:00:00Z',
  payload: { nativeRequestRef: 'req_9' },
}

describe('RunnerEventEnvelope', () => {
  it('accepts the envelope from the build plan', () => {
    expect(RunnerEventEnvelope.parse(pdfExample)).toEqual(pdfExample)
  })

  it('rejects an unknown schema version', () => {
    expect(RunnerEventEnvelope.safeParse({ ...pdfExample, schemaVersion: 2 }).success).toBe(false)
  })

  it('rejects negative generation and sequence', () => {
    expect(RunnerEventEnvelope.safeParse({ ...pdfExample, generation: -1 }).success).toBe(false)
    expect(RunnerEventEnvelope.safeParse({ ...pdfExample, sequence: -1 }).success).toBe(false)
  })

  it('rejects a timestamp that is not ISO 8601', () => {
    expect(RunnerEventEnvelope.safeParse({ ...pdfExample, occurredAt: 'yesterday' }).success).toBe(false)
  })
})
