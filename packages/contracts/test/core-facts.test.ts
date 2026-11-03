import { describe, expect, it } from 'vitest'
import type { AttemptRef } from '../src/common'
import { CoreFactName, type CoreForEngines, type ExitPayload } from '../src/core-facts'

const AT = '2026-11-03T15:18:57.626Z'
const ATTEMPT: AttemptRef = { attempt_id: 'att_01', generation: 0 }

describe('CoreFactName', () => {
  it('accepts two past-tense fact names', () => {
    expect(CoreFactName.safeParse('attemptStarted').success).toBe(true)
    expect(CoreFactName.safeParse('slotChanged').success).toBe(true)
  })

  it('rejects the snake_case and future-tense spellings', () => {
    expect(CoreFactName.safeParse('attempt_started').success).toBe(false)
    expect(CoreFactName.safeParse('attemptStart').success).toBe(false)
  })
})

/** The recording stub shape `packages/testkit` ships as `MemoryCoreForEngines`: every fact appends. */
class RecordingCore implements CoreForEngines {
  readonly facts: CoreFactName[] = []

  attemptStarted(): void {
    this.facts.push('attemptStarted')
  }

  inputsDelivered(): void {
    this.facts.push('inputsDelivered')
  }

  inputsRead(): void {
    this.facts.push('inputsRead')
  }

  turnEnded(): void {
    this.facts.push('turnEnded')
  }

  reportReceived(): void {
    this.facts.push('reportReceived')
  }

  permissionRequested(): void {
    this.facts.push('permissionRequested')
  }

  rateLimitObserved(): void {
    this.facts.push('rateLimitObserved')
  }

  usageObserved(): void {
    this.facts.push('usageObserved')
  }

  attemptExited(): void {
    this.facts.push('attemptExited')
  }

  deliveryFailed(): void {
    this.facts.push('deliveryFailed')
  }

  slotChanged(): void {
    this.facts.push('slotChanged')
  }
}

/** Typed as the contract, so the calls below are checked against `CoreForEngines`, not the stub. */
const asContract = (core: RecordingCore): CoreForEngines => core

describe('CoreForEngines', () => {
  it('keeps exactly the eleven CONTRACTS §6 facts, matching CoreFactName', () => {
    const surface: (keyof CoreForEngines)[] = [
      'attemptStarted',
      'inputsDelivered',
      'inputsRead',
      'turnEnded',
      'reportReceived',
      'permissionRequested',
      'rateLimitObserved',
      'usageObserved',
      'attemptExited',
      'deliveryFailed',
      'slotChanged',
    ]
    expect(surface).toHaveLength(11)
    expect([...surface].sort()).toEqual([...CoreFactName.options].sort())
  })

  it('records a delivery round in the past tense', () => {
    const core = new RecordingCore()
    const facts = asContract(core)
    facts.attemptStarted(ATTEMPT, 0, 'f5fdd8dd-5fb7-49ed-80cb-9eec8412c6e3', AT)
    facts.inputsDelivered(ATTEMPT, ['inp_01'])
    facts.reportReceived(ATTEMPT, 0, { kind: 'progress', summary: 'Turn done; audit table sketched.' })
    facts.inputsRead(ATTEMPT, ['inp_01'])
    facts.turnEnded(ATTEMPT, 0)
    expect(core.facts).toEqual([
      'attemptStarted',
      'inputsDelivered',
      'reportReceived',
      'inputsRead',
      'turnEnded',
    ])
  })

  it('takes the exit event payload as the exit fact', () => {
    const exit: ExitPayload = { type: 'exit', code: 0, terminal_reason: 'completed' }
    const core = new RecordingCore()
    asContract(core).attemptExited(ATTEMPT, 0, exit)
    expect(core.facts).toEqual(['attemptExited'])
  })
})
