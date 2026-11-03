import type { CoreFactName, Report, Slot } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
import { factsOf, MemoryCoreForEngines } from '../src/index'

const AT = '2026-11-03T10:00:00.000Z'
const attempt = { attempt_id: 'att_1', generation: 0 }

const slot: Slot = {
  id: 'slot_1',
  label: 'claude sub',
  engine: 'claude',
  kind: 'claude-sub',
  provider: 'anthropic-sub',
  home: '/tmp/mec/homes/claude-1',
  credential_kind: 'oauth',
  state: 'healthy',
  usage: 'unknown',
  pinning: { roles: ['implementer'] },
  pairs: [],
  concurrency: 1,
}

const table: Array<{ fact: CoreFactName; invoke: (core: MemoryCoreForEngines) => void }> = [
  { fact: 'attemptStarted', invoke: (core) => core.attemptStarted(attempt, 1, 'sess_1', AT) },
  { fact: 'inputsDelivered', invoke: (core) => core.inputsDelivered(attempt, ['inp_1', 'inp_2']) },
  { fact: 'inputsRead', invoke: (core) => core.inputsRead(attempt, ['inp_1']) },
  { fact: 'turnEnded', invoke: (core) => core.turnEnded(attempt, 1) },
  {
    fact: 'reportReceived',
    invoke: (core) => core.reportReceived(attempt, 1, { kind: 'ready', summary: 'done' }),
  },
  {
    fact: 'permissionRequested',
    invoke: (core) =>
      core.permissionRequested(attempt, 'req_1', {
        kind: 'shell',
        summary: 'run tests',
        command: ['pnpm', 'test'],
      }),
  },
  {
    fact: 'rateLimitObserved',
    invoke: (core) =>
      core.rateLimitObserved(attempt, 'slot_1', {
        window: 'five_hour',
        utilization: 0.5,
        observed_at: AT,
        source: 'engine_event',
      }),
  },
  {
    fact: 'usageObserved',
    invoke: (core) => core.usageObserved(attempt, { type: 'usage', input_tokens: 3, output_tokens: 5 }),
  },
  {
    fact: 'attemptExited',
    invoke: (core) => core.attemptExited(attempt, 1, { type: 'exit', code: 0, terminal_reason: 'completed' }),
  },
  {
    fact: 'deliveryFailed',
    invoke: (core) => core.deliveryFailed(attempt, ['inp_9'], new Error('channel closed')),
  },
  { fact: 'slotChanged', invoke: (core) => core.slotChanged(slot) },
]

describe('MemoryCoreForEngines', () => {
  it('records every one of the 11 facts, in order, with a timestamp', () => {
    const core = new MemoryCoreForEngines()
    for (const { invoke } of table) invoke(core)
    expect(core.calls.map((call) => call.fact)).toEqual(table.map((row) => row.fact))
    for (const call of core.calls) {
      expect(call.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
  })

  it('each fact records its positional args', () => {
    const core = new MemoryCoreForEngines()
    core.attemptStarted(attempt, 1, 'sess_1', AT)
    expect(factsOf(core.calls, 'attemptStarted')[0]?.args).toEqual([attempt, 1, 'sess_1', AT])

    core.inputsDelivered(attempt, ['inp_1', 'inp_2'])
    expect(factsOf(core.calls, 'inputsDelivered')[0]?.args).toEqual([attempt, ['inp_1', 'inp_2']])

    core.deliveryFailed(attempt, ['inp_9'], new Error('channel closed'))
    const failure = factsOf(core.calls, 'deliveryFailed')[0]
    if (failure === undefined) throw new Error('deliveryFailed was not recorded')
    expect((failure.args[2] as Error).message).toBe('channel closed')

    core.slotChanged(slot)
    expect(factsOf(core.calls, 'slotChanged')[0]?.args).toEqual([slot])
  })

  it('records a deep copy of the args', () => {
    const core = new MemoryCoreForEngines()
    const report: Report = { kind: 'ready', summary: 'original' }
    core.reportReceived(attempt, 1, report)
    report.summary = 'mutated'
    expect(factsOf(core.calls, 'reportReceived')[0]?.args[2]).toEqual({ kind: 'ready', summary: 'original' })
  })

  it('factsOf filters the recording by fact name', () => {
    const core = new MemoryCoreForEngines()
    core.inputsDelivered(attempt, ['inp_1'])
    core.inputsRead(attempt, ['inp_1'])
    core.inputsDelivered(attempt, ['inp_2'])
    expect(factsOf(core.calls, 'inputsDelivered')).toHaveLength(2)
    expect(factsOf(core.calls, 'inputsRead')).toHaveLength(1)
    expect(factsOf(core.calls, 'turnEnded')).toEqual([])
  })
})
