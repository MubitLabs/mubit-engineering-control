// M3.3 Stage B, §5.10: what parked work shows comes from the attempt's own park record.
import { afterEach, describe, expect, it } from 'vitest'
import { type ConfigServer, makeConfigServer } from './config-server'

const AT = '2026-11-06T10:00:00.000Z'
const RESET = '2026-11-06T16:30:00.000Z'

let ctx: ConfigServer | undefined
afterEach(async () => {
  await ctx?.close()
  ctx = undefined
})

const SEAM = { switchSlot: async () => ({ status: 200, body: {} }), resumeNow: () => [] }

function seed(server: ConfigServer, id: string, attempt: Record<string, unknown>): void {
  server.store.slots.save({ id: 'slot_a', label: 'first', state: 'degraded', updatedAt: AT })
  server.store.messages.save({ id: 'msg_1', text: 'Fix login\nand the logout too', updatedAt: AT })
  server.store.workItems.save({ id: 'work_1', state: 'running', originMessageId: 'msg_1', updatedAt: AT })
  server.store.attempts.save({
    id,
    workItemId: 'work_1',
    taskId: 'task_1',
    slotId: 'slot_a',
    updatedAt: AT,
    ...attempt,
  })
}

const quota = (resets?: string) => ({
  state: 'quota_wait',
  worktree: '/scratch/wt',
  parked: {
    state: 'quota_wait',
    reason: 'rate limit',
    at: AT,
    ...(resets !== undefined && { resets_at: resets }),
  },
})

describe('GET /api/parked', () => {
  it('names the slot, the reason, the reported reset and the kept worktree', async () => {
    ctx = makeConfigServer({ parked: SEAM })
    seed(ctx, 'att_1', quota(RESET))
    expect((await ctx.get('/api/parked')).json()).toEqual({
      rows: [
        {
          workItemId: 'work_1',
          workTitle: 'Fix login',
          attemptId: 'att_1',
          slotId: 'slot_a',
          slotLabel: 'first',
          state: 'quota_wait',
          reason: 'rate limit',
          resetAt: RESET,
          worktreeKept: true,
        },
      ],
    })
  })

  it('an unreported reset is null, never a guess', async () => {
    ctx = makeConfigServer({ parked: SEAM })
    seed(ctx, 'att_1', quota('unknown'))
    const [row] = (await ctx.get('/api/parked')).json().rows
    expect(row.resetAt).toBeNull()
  })

  it('work that moved, or never parked, is not listed', async () => {
    ctx = makeConfigServer({ parked: SEAM })
    seed(ctx, 'att_1', { ...quota(), switched_to: 'att_2' })
    seed(ctx, 'att_2', { state: 'running' })
    expect((await ctx.get('/api/parked')).json().rows).toEqual([])
  })

  it('a key-shaped reason is redacted before it leaves', async () => {
    ctx = makeConfigServer({ parked: SEAM })
    const shaped = 'sk-ant-api03-mec-test-fixture-000000000000abcd'
    seed(ctx, 'att_1', { state: 'provider_down', parked: { reason: `failed with ${shaped}` } })
    expect((await ctx.get('/api/parked')).body).not.toContain(shaped)
  })
})

describe('capabilities.switchWork', () => {
  const flags = async (server: ConfigServer) =>
    ((await server.get('/api/status')).json() as { capabilities: { switchWork: boolean; drain: boolean } })
      .capabilities

  it('is on when the switch route is wired, and Drain stays off', async () => {
    ctx = makeConfigServer({ parked: SEAM })
    expect(await flags(ctx)).toMatchObject({ switchWork: true, drain: false })
  })

  it('stays off without it', async () => {
    ctx = makeConfigServer()
    expect((await flags(ctx)).switchWork).toBe(false)
  })
})
