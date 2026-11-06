import { afterAll, describe, expect, it } from 'vitest'
import { judgeProbe, linkedSlot, type ProbeRun, runProbe } from './loopback-probe'

/**
 * Can a sandboxed worker approve its own card? (spec §8.4, §13). `POST /api/inbox/:id/resolve` takes
 * no token, so this measures the only thing in its way. One bounded real Claude run, `fast` tier,
 * through the linked slot, on a scratch data dir and repository, with a fake `gh` first on PATH. The
 * planner is scripted, so no planner runs. Spends quota, so never in CI or a wrapper:
 *
 *   MEC_REAL_ENGINE=1 MEC_REAL_SELF_APPROVAL=1 pnpm exec vitest run --project b \
 *     apps/desktop/test/self-approval.real.test.ts
 *
 * Add a line to engine-runs.md first. `not_proven` is not a pass: the model may decline the script,
 * as run 3 of handoff 20 declined its refused steps. The verdict comes from the card and the
 * script's own output, never from what the model reports.
 */
const REAL = process.env.MEC_REAL_ENGINE === '1' && process.env.MEC_REAL_SELF_APPROVAL === '1'

describe.skipIf(!REAL)('a sandboxed worker and the workbench on loopback', () => {
  let run: ProbeRun | undefined
  afterAll(async () => {
    await run?.close()
  })

  it('cannot approve a card or read the server, and no card settles', async () => {
    run = await runProbe({ slot: linkedSlot(), boundMs: 180_000 })
    const verdict = judgeProbe(run)
    console.log(`attempt ${run.attemptState}, card ${run.cardStatus}, verdict ${JSON.stringify(verdict)}`)
    console.log(run.output ?? '(no probe output)')
    expect(verdict).toEqual({ verdict: 'refused' })
    // The URL and card in the script were right: the same request works from outside the sandbox.
    expect((await run.denyFromOutside()).status).toBe(200)
    expect(run.card()).toBe('denied')
  }, 400_000)
})
