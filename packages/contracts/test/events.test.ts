import { describe, expect, it } from 'vitest'
import { checkEventStream, EngineEvent, type EngineEventBody } from '../src'
import { FAKE_KEYS } from './fake-keys'
import { SMOKE_EVENTS } from './samples'

const smoke = SMOKE_EVENTS as unknown as EngineEventBody[]
const started = smoke[0]!
const exit = smoke[5]!
const say = (text: string): EngineEventBody => ({ type: 'message', role: 'assistant', text })
const rules = (events: (EngineEventBody & { seq?: number })[]) => checkEventStream(events).map((v) => v.rule)
const withSeq = (events: EngineEventBody[], seqs: number[]) => events.map((e, i) => ({ ...e, seq: seqs[i]! }))

describe('checkEventStream', () => {
  it('accepts the smoke stream as bodies and as enveloped events', () => {
    expect(checkEventStream(smoke)).toEqual([])
    expect(checkEventStream(withSeq(smoke, [0, 1, 2, 3, 4, 5]))).toEqual([])
  })

  it('accepts a crash: session_started then the runtime-synthesised exit', () => {
    expect(checkEventStream([started, { type: 'exit', code: 137, terminal_reason: 'crashed' }])).toEqual([])
  })

  it('requires session_started first', () => {
    expect(rules([say('hi'), started, exit])).toEqual(['session_started_first'])
    expect(rules([say('hi'), exit])).toEqual(['session_started_first'])
  })

  it('allows only one session_started', () => {
    expect(rules([started, started, exit])).toEqual(['single_session_started'])
  })

  it('requires exit last, exactly once', () => {
    expect(rules([started, exit, say('late')])).toEqual(['exit_last'])
    expect(rules([started, exit, exit])).toEqual(['single_exit'])
  })

  it('requires seq strictly increasing', () => {
    expect(rules(withSeq([started, say('a'), exit], [0, 2, 1]))).toEqual(['seq_increasing'])
    expect(rules(withSeq([started, say('a'), exit], [0, 1, 1]))).toEqual(['seq_increasing'])
  })

  it('rejects a key-shaped message', () => {
    for (const key of Object.values(FAKE_KEYS)) {
      expect(rules([started, say(`use ${key} for this`), exit])).toEqual(['no_secret_in_message'])
    }
  })

  it('flags an empty stream', () => {
    expect(rules([])).toEqual(['session_started_first', 'exit_last'])
  })
})

describe('EngineEvent', () => {
  it('requires the envelope', () => {
    expect(EngineEvent.safeParse(exit).success).toBe(false)
    expect(
      EngineEvent.safeParse({
        ...exit,
        seq: 9,
        at: new Date().toISOString(),
        attempt_id: 'att_1',
        generation: 1,
      }).success,
    ).toBe(true)
  })
})
