import type { AttemptRef, Evidence, Operation } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
import { BridgeImpl } from '../src/permission-bridge'

const attempt: AttemptRef = { attempt_id: 'att_1', generation: 0 }
const operation: Operation = {
  kind: 'shell',
  summary: 'run the test suite',
  command: ['pnpm', 'test'],
}
const evidence: Evidence = { raw: { attempt: 'att_1' }, worktree: '/tmp/mec-worktree' }

const deadline = () => new Date(Date.now() + 60_000).toISOString()

describe('BridgeImpl', () => {
  it('passes allow and deny through untouched', async () => {
    const allow = new BridgeImpl(async () => 'allow')
    await expect(allow.request(attempt, operation, evidence, deadline())).resolves.toBe('allow')
    const deny = new BridgeImpl(async () => 'deny')
    await expect(deny.request(attempt, operation, evidence, deadline())).resolves.toBe('deny')
  })

  it('expires when the decider does not answer within the deadline', async () => {
    const bridge = new BridgeImpl(() => new Promise<'allow' | 'deny'>(() => {}), 10)
    await expect(bridge.request(attempt, operation, evidence, deadline())).resolves.toBe('expired')
  })

  it('also expires at the caller deadline when it comes before the cap', async () => {
    const bridge = new BridgeImpl(() => new Promise<'allow' | 'deny'>(() => {}), 60_000)
    const past = new Date(Date.now() - 1_000).toISOString()
    await expect(bridge.request(attempt, operation, evidence, past)).resolves.toBe('expired')
  })

  it('asks the decider once for a repeated identical request', async () => {
    let decideCalls = 0
    const bridge = new BridgeImpl(async () => {
      decideCalls += 1
      return 'allow'
    })
    const first = bridge.request(attempt, operation, evidence, deadline())
    // Different key order in the evidence must not count as a different request.
    const second = bridge.request(attempt, operation, { ...evidence }, deadline())
    expect(second).toBe(first) // the recorded promise, not a second card
    await Promise.all([first, second])
    expect(decideCalls).toBe(1)
  })

  it('a different operation, evidence or generation is a new request', async () => {
    let decideCalls = 0
    const bridge = new BridgeImpl(async () => {
      decideCalls += 1
      return 'deny'
    })
    await bridge.request(attempt, operation, evidence, deadline())
    await bridge.request(attempt, { ...operation, summary: 'run the linter' }, evidence, deadline())
    await bridge.request(attempt, operation, { ...evidence, raw: null }, deadline())
    await bridge.request({ ...attempt, generation: 1 }, operation, evidence, deadline())
    expect(decideCalls).toBe(4)
  })

  it('answers deny when the decider errors', async () => {
    const bridge = new BridgeImpl(async () => {
      throw new Error('card service down')
    })
    await expect(bridge.request(attempt, operation, evidence, deadline())).resolves.toBe('deny')
  })
})
