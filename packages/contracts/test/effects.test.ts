import { describe, expect, it } from 'vitest'
import { EffectJob, EffectKind, EffectState, Later } from '../src/effects'

const AT = '2026-11-03T15:18:57.626Z'

const job = {
  kind: 'deliver',
  key: 'att_01',
  payload: { input_id: 'inp_01' },
  attempts: 0,
  next_run_at: AT,
}

describe('EffectJob', () => {
  it('accepts a fresh job and one that failed once', () => {
    expect(EffectJob.safeParse(job).success).toBe(true)
    expect(
      EffectJob.safeParse({
        kind: 'probe',
        key: 'slot_max-1',
        payload: null,
        attempts: 1,
        next_run_at: AT,
        last_error: 'provider_unreachable',
      }).success,
    ).toBe(true)
  })

  it('rejects an unknown kind and a negative attempt count', () => {
    expect(EffectJob.safeParse({ ...job, kind: 'retry' }).success).toBe(false)
    expect(EffectJob.safeParse({ ...job, attempts: -1 }).success).toBe(false)
  })
})

describe('EffectKind', () => {
  it('is exactly the seven kinds of CONTRACTS §7', () => {
    expect(EffectKind.options).toEqual(['launch', 'deliver', 'relay', 'note', 'reply', 'external', 'probe'])
  })
})

describe('EffectState', () => {
  it('accepts pending and waiting, rejects queued and unknown', () => {
    expect(EffectState.safeParse('pending').success).toBe(true)
    expect(EffectState.safeParse('waiting').success).toBe(true)
    expect(EffectState.safeParse('queued').success).toBe(false)
    expect(EffectState.safeParse('unknown').success).toBe(false)
  })
})

describe('Later', () => {
  it('is an Error a handler throws to defer without counting a failure', () => {
    const later = new Later('slot not healthy yet')
    expect(later instanceof Error).toBe(true)
    expect(later.message).toBe('slot not healthy yet')
  })
})
