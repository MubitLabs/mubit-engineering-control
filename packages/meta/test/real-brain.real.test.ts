import { join } from 'node:path'
import { BUILTIN_ROLE_NAMES, validateGraph } from '@mec/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RealClaudeBrain } from '../src/real-brain'

/**
 * R1.4's real-engine gate — the REAL meta brain: one real `claude -p --restricted`
 * run with the platform tool set through a live mec-tools server. Runs ONLY with
 * MEC_REAL_ENGINE=1 and a logged-in dedicated slot (one meta turn, cents of usage):
 *   MEC_REAL_ENGINE=1 MEC_META_SLOT=~/.mec/engines/claude/meta-a \
 *     pnpm exec vitest run packages/meta/test/real-brain.real.test.ts
 */
const REAL = process.env.MEC_REAL_ENGINE === '1'
const SLOT =
  process.env.MEC_META_SLOT ??
  process.env.MEC_H1_SLOT ??
  join(process.env.HOME ?? '', '.mec/engines/claude/preflight-a')

describe.skipIf(!REAL)('RealClaudeBrain on the real binary', () => {
  let brain: RealClaudeBrain | undefined

  beforeAll(() => {
    brain = new RealClaudeBrain({ slotDir: SLOT, toolsSecret: 'meta-real-secret' })
  })

  afterAll(async () => {
    await brain?.close()
  })

  it('decides a real turn: ack text, a validateGraph-clean plan', async () => {
    const decision = await brain!.decide({
      messageText: 'Add a README section about installation with one command example',
      liveWork: [],
    })

    expect(typeof decision.ack).toBe('string')
    expect(decision.ack.length).toBeGreaterThan(0)

    if ('plan' in decision && decision.plan !== undefined) {
      expect(decision.plan.tasks.length).toBeGreaterThanOrEqual(1)
      const issues = validateGraph(
        decision.plan.tasks.map((task) => ({
          id: task.taskId,
          dependsOn: [...task.dependsOn],
          ownedPaths: [],
          acceptanceChecks: ['manual-review'],
          maxAttempts: 3,
          basePolicy: 'integration',
          role: task.role,
        })),
        { knownChecks: ['manual-review'], knownRoles: BUILTIN_ROLE_NAMES },
      )
      expect(issues).toEqual([])
      for (const task of decision.plan.tasks) {
        expect(BUILTIN_ROLE_NAMES).toContain(task.role)
      }
    }

    // The tool side really ran: the protocol's calls were mirrored.
    const tools = brain!.calls.map((entry) => entry.tool)
    if (tools.length === 0) {
      // Diagnostic for the operator: what the engine actually did this turn.
      console.log('BRAIN-DIAG calls:', JSON.stringify(brain!.calls))
      console.log('BRAIN-DIAG decision:', JSON.stringify(decision).slice(0, 500))
      console.log(
        'BRAIN-DIAG lastEvents:',
        JSON.stringify(
          brain!.lastEvents?.map(
            (e) =>
              e.type +
              (e.type === 'tool_call' ? `:${e.tool}` : '') +
              (e.type === 'message' ? `:${(e as { text?: string }).text?.slice(0, 120) ?? ''}` : ''),
          ),
        ).slice(0, 800),
      )
    }
    expect(tools.some((tool) => tool === 'acknowledge' || tool === 'report_result')).toBe(true)
  }, 240_000)
})
