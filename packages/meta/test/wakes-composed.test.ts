// M2.2: `classifyWake` in production (§6). What a report does reaches the queue from one place,
// in the report's own transaction, and the wake runs a planner turn only once.
import type { Json, Report, StoreDoc } from '@mec/contracts'
import { MemoryRepositories } from '@mec/testkit'
import { describe, expect, it } from 'vitest'
import { compilePlannerContext, FollowUps, MetaAgentService, type MetaBrain, unreadNotes } from '../src'

const AT = '2026-11-05T12:00:00.000Z'
const REPO = 'repo_a'

function rig() {
  const store = new MemoryRepositories()
  let turns = 0
  const contexts: string[] = []
  const brain: MetaBrain = async (context) => {
    turns += 1
    if (context.snapshot !== undefined) contexts.push(compilePlannerContext(context.snapshot))
    return {
      ack: 'ok',
      reports: [{ workItemId: 'wi_1', summary: 'the meta agent reporting', artifacts: [] }],
      stops: [{ attemptId: 'att_1' }],
    } as never
  }
  store.atomic(() => {
    store.engines.save({ id: REPO, url: 'https://example.test/a', bootstrap: [], checks: [], trust: true })
    store.workItems.save({
      id: 'wi_1',
      state: 'executing',
      repoId: REPO,
      mandate: { originMessageId: 'msg_0', status: 'active' },
    })
    store.attempts.save({ id: 'att_1', taskId: 'task_1', workItemId: 'wi_1', slotId: 's', state: 'running' })
  })
  const followups = new FollowUps({ store, effects: store.effects, now: () => AT })
  const service = new MetaAgentService({ store, effects: store.effects, brain, followups, now: () => AT })
  const rows = (kind: string) =>
    store.snapshot().effects.filter((row) => row.kind === kind) as { key: string; payload: Json }[]
  const report = (kind: Report['kind'], n = 1) => {
    const attempt = store.attempts.get('att_1') as StoreDoc
    store.atomic(() => followups.onReport(attempt, { kind, summary: `${kind} summary` }, n, AT))
  }
  return { store, followups, service, rows, report, contexts, turns: () => turns }
}

describe('reports to wakes (§6)', () => {
  it('progress never wakes', () => {
    const h = rig()
    h.report('progress')
    h.report('waiting', 2)
    expect(h.rows('relay')).toHaveLength(0)
    expect(h.rows('note')).toHaveLength(2)
  })

  it.each(['ready', 'blocked', 'failed', 'dropped'] as const)('%s wakes', (kind) => {
    const h = rig()
    h.report(kind)
    expect(h.rows('relay')).toMatchObject([{ payload: { reason: `report ${kind}`, workItemId: 'wi_1' } }])
    expect(h.rows('note')).toHaveLength(0)
  })

  it('ready wakes once', async () => {
    const h = rig()
    h.report('ready')
    h.report('ready')
    expect(h.rows('relay')).toHaveLength(1)

    const [row] = h.rows('relay')
    await h.service.runRelay(row?.payload as Json)
    await h.service.runRelay(row?.payload as Json)
    expect(h.turns()).toBe(1)
  })

  it('the wake commits with the report: a rollback loses both', () => {
    const h = rig()
    const attempt = h.store.attempts.get('att_1') as StoreDoc
    expect(() =>
      h.store.atomic(() => {
        h.followups.onReport(attempt, { kind: 'ready', summary: 's' }, 1, AT)
        throw new Error('the report did not commit')
      }),
    ).toThrow()
    expect(h.rows('relay')).toHaveLength(0)
  })

  it('the meta agent’s own action never wakes it', async () => {
    const h = rig()
    await h.service.onWake({ causationId: 'first', reason: 'report ready', workItemId: 'wi_1' })
    expect(h.turns()).toBe(1)
    expect(h.rows('relay')).toHaveLength(0)
    expect(h.rows('note')).toHaveLength(0)
  })

  it('a note lands in the next turn’s context once, and only then', async () => {
    const h = rig()
    h.report('progress')
    await h.followups.runNote(h.rows('note')[0]?.payload as Json)

    await h.service.onWake({ causationId: 'first', reason: 'report ready', workItemId: 'wi_1' })
    expect(h.contexts[0]).toContain('att_1 progress: progress summary')
    expect(unreadNotes(h.store, h.store.workItems.get('wi_1') as StoreDoc)).toEqual([])
  })

  it('a specialist question is a wake', () => {
    const h = rig()
    const attempt = h.store.attempts.get('att_1') as StoreDoc
    h.store.atomic(() => h.followups.openQuestion(attempt, { text: 'Which table?' }, AT))
    expect(h.rows('relay')).toMatchObject([{ payload: { reason: 'specialist question' } }])
  })
})
