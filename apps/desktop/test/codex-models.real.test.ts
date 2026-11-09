import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type EngineEvent, matchesSecret } from '@mec/contracts'
import { CodexAdapter } from '@mec/engines'
import { loadModelsTable } from '@mec/prompts'
import {
  CODEX_PROFILE,
  codexAttemptArgs,
  codexOtherServers,
  defaultDenyRead,
  modelRefusalOf,
  ownedSpawn,
  resolveModel,
  Supervisor,
  startCodexClient,
} from '@mec/runtime'
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

/**
 * The refusal itself, as the sign-in sends it: one turn asked of `gpt-6-luna`, which the listing
 * above does not name. Codex refuses before any generation (0.3.4 saw a 400), so it should spend
 * nothing; if the account ever accepts it, it is one tiny turn. Gated twice:
 *
 *   MEC_REAL_CODEX=1 MEC_REAL_CODEX_REFUSAL=1 [MEC_CODEX_REFUSAL_OUT=<file>] \
 *     pnpm exec vitest run apps/desktop/test/codex-models.real.test.ts
 *
 * MEC_CODEX_REFUSAL_OUT receives the error events, after a check that no key shape is in them.
 */
describe.skipIf(!REAL || process.env.MEC_REAL_CODEX_REFUSAL !== '1')(
  'a real refusal (MEC_REAL_CODEX_REFUSAL=1)',
  () => {
    it('is read as a model refusal naming the model', { timeout: 150_000 }, async () => {
      const home = process.env.MEC_CODEX_HOME
      const env = {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '/tmp',
        ...(home !== undefined && { CODEX_HOME: home }),
      }
      const supervisor = new Supervisor()
      const owner = { attemptId: 'refusal', generation: 1 }
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'mec-codex-refusal-')))
      const worktree = join(root, 'work', 'att_refusal')
      const tempDir = join(root, 'tmp', 'att_refusal')
      const sharedClone = join(root, 'repos', 'r.git')
      for (const dir of [worktree, tempDir, sharedClone]) mkdirSync(dir, { recursive: true })
      // The launch's own argv: the profile, the home's other MCP servers fenced, the token kept out.
      const listing = execFileSync('codex', ['mcp', 'list', '--json'], { env, encoding: 'utf8' })
      const args = codexAttemptArgs({
        worktree,
        tempDir,
        sharedClone,
        denyRead: defaultDenyRead(env.HOME, root),
        toolsUrl: 'http://127.0.0.1:9/mcp',
        otherServers: codexOtherServers(listing),
        readOnly: true,
      })
      try {
        const adapter = new CodexAdapter({
          profile: CODEX_PROFILE,
          connect: async () =>
            startCodexClient({
              binary: 'codex',
              args,
              cwd: worktree,
              env,
              spawn: ownedSpawn(supervisor, owner, { stdin: true }),
            }),
        })
        const handle = await adapter.launch({
          brief: {
            attempt_id: 'att_refusal',
            generation: 1,
            worktree,
            objective: 'Reply with the single word ok.',
            isolation: { read_only: true, permission_mode: 'none' },
          },
          env: {},
          cwd: worktree,
          model: { id: 'gpt-6-luna' },
          bridge: { request: async () => 'deny' },
        } as never)
        const events: EngineEvent[] = []
        for await (const event of adapter.events(handle)) {
          events.push(event)
          if (event.type === 'exit') break
        }
        const errors = events.filter((event) => event.type === 'error')
        const text = JSON.stringify(errors)
        expect(matchesSecret(text)).toBe(false)
        const out = process.env.MEC_CODEX_REFUSAL_OUT
        if (out !== undefined)
          writeFileSync(out, `${JSON.stringify({ errors, exit: events.at(-1) }, null, 2)}\n`)
        expect(modelRefusalOf(events)).toContain('gpt-6-luna')
      } finally {
        await supervisor.stop(owner.attemptId, owner.generation).catch(() => {})
        rmSync(root, { recursive: true, force: true })
      }
    })
  },
)
