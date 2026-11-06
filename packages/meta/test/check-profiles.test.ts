// M2.3 (§14, §15): plans name the repository's real checks, and only those.
import { MemoryRepositories } from '@mec/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MetaAgentService, type MetaBrain, type MetaDecision, type MetaPlanTask, workResultOf } from '../src'
import type { PlannerTools } from '../src/tools'

const NOW = () => '2026-11-05T12:00:00.000Z'
const REPO = 'repo_a'
const CHECKS = [
  { name: 'unit', cmd: 'pnpm test' },
  { name: 'lint', cmd: 'pnpm lint' },
]

const task = (over: Partial<MetaPlanTask> = {}): MetaPlanTask => ({
  taskId: 'a',
  objective: 'do a',
  dependsOn: [],
  role: 'implementer',
  ...over,
})

function rig(checks: { name: string; cmd: string }[], decision: MetaDecision | { next: MetaDecision }) {
  const store = new MemoryRepositories()
  store.atomic(() => {
    store.engines.save({ id: REPO, url: 'https://example.test/a', bootstrap: [], checks, trust: true })
  })
  const seen: { tools?: PlannerTools } = {}
  const brain: MetaBrain = async (input) => {
    seen.tools = (input as { tools?: PlannerTools }).tools as PlannerTools
    return 'next' in decision ? decision.next : decision
  }
  const service = new MetaAgentService({ store, effects: store.effects, brain, now: NOW })
  return { store, service, seen }
}

const planned = (tasks: MetaPlanTask[]): MetaDecision => ({ ack: 'On it', plan: { tasks } })

beforeEach(() => {
  process.env.MEC_FAKE_ENGINE = '1'
})
afterEach(() => {
  delete process.env.MEC_FAKE_ENGINE
})

describe('check profiles (§14, §15)', () => {
  it('an unknown check is refused by name', async () => {
    const { store, service } = rig(CHECKS, planned([task({ acceptanceChecks: ['unit', 'made-up'] })]))
    const outcome = await service.onUserMessage({ messageId: 'msg_1', text: 'go', repoId: REPO })
    expect(outcome.tasksCreated).toBe(0)
    expect(outcome.acknowledged).toContain('made-up')
    expect(store.tasks.list()).toEqual([])
  })

  it('a registered check is accepted', async () => {
    const { store, service } = rig(CHECKS, planned([task({ acceptanceChecks: ['lint'] })]))
    await service.onUserMessage({ messageId: 'msg_1', text: 'go', repoId: REPO })
    expect(store.tasks.list()[0]?.acceptanceChecks).toEqual(['lint'])
  })

  it('a task that names no check gets the registered ones, and the marker only with none', async () => {
    const real = rig(CHECKS, planned([task()]))
    await real.service.onUserMessage({ messageId: 'msg_1', text: 'go', repoId: REPO })
    expect(real.store.tasks.list()[0]?.acceptanceChecks).toEqual(['unit', 'lint'])

    const none = rig([], planned([task()]))
    await none.service.onUserMessage({ messageId: 'msg_1', text: 'go', repoId: REPO })
    expect(none.store.tasks.list()[0]?.acceptanceChecks).toEqual(['manual-review'])
  })

  it('the marker is not a check a plan may name where real ones exist', async () => {
    const { service } = rig(CHECKS, planned([task({ acceptanceChecks: ['manual-review'] })]))
    const outcome = await service.onUserMessage({ messageId: 'msg_1', text: 'go', repoId: REPO })
    expect(outcome.tasksCreated).toBe(0)
  })

  it("the planner's tools validate against the real names", async () => {
    const { service, seen } = rig(CHECKS, { ack: 'noted' })
    await service.onUserMessage({ messageId: 'msg_1', text: 'go', repoId: REPO })
    const propose = (check: string) =>
      seen.tools?.execute('propose_plan', {
        work_item: 'wi_turn',
        tasks: [
          {
            id: 'a',
            objective: 'do a',
            role: 'implementer',
            acceptance_checks: [check],
            model_request: { tier: 'fast', reason: 'small' },
          },
        ],
      }) as { ok: boolean; issues?: string[] }
    expect(propose('made-up').issues?.join(' ')).toContain('made-up')
    expect(propose('unit').issues?.join(' ')).not.toContain('unit')
  })

  it('a sensitive flag on a plan task survives to the stored task', async () => {
    const { store, service } = rig(CHECKS, planned([task({ sensitive: true })]))
    await service.onUserMessage({ messageId: 'msg_1', text: 'go', repoId: REPO })
    expect(store.tasks.list()[0]?.sensitive).toBe(true)
  })
})

describe('what the meta agent reports (§12.7, §15)', () => {
  it('report_result carries the reducer output, so a claim cannot stand alone', async () => {
    const script = { next: planned([task()]) }
    const { store, service } = rig(CHECKS, script)
    const outcome = await service.onUserMessage({ messageId: 'msg_1', text: 'go', repoId: REPO })
    const workItemId = outcome.workItemId as string
    script.next = {
      ack: 'Reporting',
      plan: { tasks: [task()] },
      reports: [{ workItemId, summary: 'All done and shipped!', artifacts: [] }],
    }
    await service.onWake({ causationId: 'report/x', reason: 'report ready', workItemId })
    const events = store.events.read(`work:${workItemId}`).filter((event) => event.type === 'result_reported')
    expect(events).toHaveLength(1)
    const body = events[0]?.body as { summary: string; result: { complete: boolean } }
    expect(body.summary).toBe('All done and shipped!')
    expect(body.result.complete).toBe(false)
    expect(workResultOf(store, workItemId).remaining.length).toBeGreaterThan(0)
  })
})
