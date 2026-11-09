import { writeFileSync } from 'node:fs'
import { loadModelsTable } from '@mec/prompts'
import { resolveModel } from '@mec/runtime'
import { describe, expect, it } from 'vitest'
import { ENGINE_ROWS } from '../src/engine-registry'

/**
 * What a signed-in Codex home offers, through the launch's own probe and listing (§3 rule 2).
 * Spends nothing: `codex login status`, `--version`, then `initialize` and `model/list` on an
 * app-server of its own; no thread starts. It reads no file under the home: the binary does.
 * Runs ONLY with MEC_REAL_CODEX=1, never in CI or the wrappers:
 *
 *   MEC_REAL_CODEX=1 [MEC_CODEX_HOME=<a slot home>] [MEC_CODEX_MODELS_OUT=<file>] \
 *     pnpm exec vitest run apps/desktop/test/codex-models.real.test.ts
 *
 * With MEC_CODEX_HOME unset it is the linked default login (`~/.codex`), as a linked slot runs.
 * MEC_CODEX_MODELS_OUT receives the listed ids, one per line: ids only, nothing of the account.
 */
const REAL = process.env.MEC_REAL_CODEX === '1'

describe.skipIf(!REAL)('a real Codex home lists its models (MEC_REAL_CODEX=1)', () => {
  it('the shipped table resolves every tier to a model the home lists', { timeout: 90_000 }, async () => {
    const row = ENGINE_ROWS.codex
    if (row?.probe === undefined || row.listModels === undefined) throw new Error('no codex listing')
    const binary = 'codex'
    const home = process.env.MEC_CODEX_HOME
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '/tmp',
      ...(home !== undefined && { CODEX_HOME: home }),
    }
    const probe = await row.probe(binary, env)
    expect(probe.auth.logged_in).toBe(true)
    expect(probe.capabilities.engine_version).toBe(row.pinned)
    const listing = await row.listModels(binary, env)
    if (!('listed' in listing)) throw new Error(`no listing: ${listing.failed}`)
    const out = process.env.MEC_CODEX_MODELS_OUT
    if (out !== undefined) writeFileSync(out, `${listing.listed.join('\n')}\n`)
    const { table } = loadModelsTable({ userPath: '/nonexistent/models.yaml' })
    const rows = Object.keys(table.engines.codex.models ?? {})
    const unavailable = new Set(rows.filter((id) => !listing.listed.includes(id)))
    for (const tier of ['fast', 'balanced', 'strong'] as const) {
      const resolved = resolveModel({ tier, reason: 'canary' }, { engine: 'codex' }, table, { unavailable })
      expect(listing.listed, tier).toContain(resolved.model)
    }
  })
})
