import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { EngineId } from '@mec/contracts'
import { loadModelsTable } from '@mec/prompts'
import { resolveModel } from '@mec/runtime'
import { opencodeProbeEnv, probeModelAvailability } from '@mec/slots'
import { describe, expect, it } from 'vitest'

/**
 * Real-models canary (review 2026-11-04 T8) — the tier ladder against REAL engine
 * state, not fixtures. Runs ONLY with MEC_REAL_MODELS=1; never in CI, never from the
 * repo wrappers (the §5.8 never-list applies — the only thing it runs is a local,
 * zero-token `opencode models` listing under the slot's own XDG isolation):
 *
 *   MEC_REAL_MODELS=1 \
 *   MEC_OPENCODE_SLOT=~/.mec/engines/opencode/glm-2 \
 *     pnpm exec vitest run packages/engines/test/model-resolution.real.test.ts
 *
 * What it proves when it runs: the SHIPPED table's zai entries resolve through
 * resolveModel to ids the installed OpenCode actually lists (or are honestly marked
 * unavailable), and the ladder degradations (strong→balanced on zai, frontier→strong
 * on codex) hold against the table the user actually has in ~/.mec/models.yaml.
 * Claude/Codex acceptance probing (`claude --model X -p 'ok'` per alias, the Codex
 * app-server `model/list`) is gated future work and stays OUT of this canary.
 */
const REAL = process.env.MEC_REAL_MODELS === '1'
const OPENCODE_SLOT =
  process.env.MEC_OPENCODE_SLOT ?? join(process.env.HOME ?? '', '.mec/engines/opencode/glm-2')

const runLocal = (cmd: string, args: readonly string[], env?: Record<string, string>) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(cmd, [...args], { env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error) }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })

describe.skipIf(!REAL)('real model resolution (MEC_REAL_MODELS=1)', () => {
  it('the user table (or the shipped default) resolves each tier on every engine it names', () => {
    const { table, provenance } = loadModelsTable()
    expect(table.version).toBe(1)
    const engines: EngineId[] = ['claude', 'codex']
    for (const engine of engines) {
      for (const tier of table.tiers) {
        const resolved = resolveModel(
          { tier, reason: 'canary: every declared tier serves or degrades' },
          { engine },
          table,
        )
        expect(resolved.model, `${engine}/${tier}`).toBeTruthy()
        expect(resolved.argv_additions.length, `${engine}/${tier}`).toBeGreaterThanOrEqual(2)
      }
    }
    // the recorded degradations the design depends on (§3 rule 1)
    const codexFrontier = resolveModel({ tier: 'frontier', reason: 'canary' }, { engine: 'codex' }, table)
    expect(codexFrontier.tier_degraded).toBe('frontier→strong (provider has no frontier)')
    const zaiStrong = resolveModel(
      { tier: 'strong', reason: 'canary' },
      { engine: 'opencode', provider: 'zai-coding-plan' },
      table,
    )
    expect(zaiStrong.tier_degraded).toBe('strong→balanced (provider has no strong)')
    expect(provenance.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the installed opencode lists every zai model the table resolves to (or the probe honestly disagrees)', async () => {
    const { table } = loadModelsTable()
    const zai = table.engines.opencode.providers?.['zai-coding-plan']
    expect(zai).toBeDefined()
    const report = await probeModelAvailability(runLocal, 'opencode', {
      env: opencodeProbeEnv(OPENCODE_SLOT),
    })
    expect(report.note).not.toContain('binary missing')
    for (const id of Object.keys(zai!.models)) {
      const resolved = resolveModel(
        { model: id, reason: 'canary: the listed ids resolve' },
        { engine: 'opencode', provider: 'zai-coding-plan' },
        table,
      )
      // A table entry the listing omits is a REAL finding: report it, do not paper over it.
      expect(
        report.availability[`zai-coding-plan/${id}`],
        `zai-coding-plan/${id} listed by opencode models`,
      ).toBe('available')
      expect(resolved.model).toBe(`zai-coding-plan/${id}`)
    }
  })
})
