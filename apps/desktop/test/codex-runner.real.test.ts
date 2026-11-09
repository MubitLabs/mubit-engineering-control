import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoFields } from '@mec/meta'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { startServer } from '../src/composition'

/**
 * One fast Codex task through the real launch path, on a real signed-in home (§3 rule 2 end to
 * end). A seeded queued attempt and launch row, the real server and queue, the real codex-cli on
 * PATH; no planner, no delivery, no gh. The launch lists the home's models (zero tokens), resolves
 * `fast` against that listing and the shipped table, and runs one small turn: that turn spends.
 * Runs ONLY with MEC_REAL_CODEX=1, never in CI or the wrappers:
 *
 *   MEC_REAL_CODEX=1 pnpm exec vitest run apps/desktop/test/codex-runner.real.test.ts
 *
 * The slot is a linked default (`linkedDefault: true`, CODEX_HOME unset), so the engine signs in
 * from `~/.codex` itself; nothing here reads a file under it.
 */
const REAL = process.env.MEC_REAL_CODEX === '1'
const POLICY = '{"preAuthorised":{}}'
const BOUND_MS = 240_000

const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

describe.skipIf(!REAL)('a fast Codex task on a real signed-in home (MEC_REAL_CODEX=1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'mec-codex-real-'))
  const closers: (() => Promise<void>)[] = []
  afterAll(async () => {
    for (const close of closers) await close()
    process.env.MEC_REAL_RUNNER = '0'
    rmSync(root, { recursive: true, force: true })
  })

  it('runs on a model the home lists, and the attempt says which', {
    timeout: BOUND_MS + 60_000,
  }, async () => {
    const dataDir = join(root, 'state')
    mkdirSync(dataDir)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    gitIn(repo, 'init', '--quiet', '-b', 'main')
    gitIn(repo, 'config', 'user.name', 'Scratch Owner')
    gitIn(repo, 'config', 'user.email', 'scratch@example.com')
    gitIn(repo, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(repo, 'README.md'), 'scratch\n')
    gitIn(repo, 'add', '--all')
    gitIn(repo, 'commit', '--quiet', '-m', 'baseline')

    const db = new Database(join(dataDir, 'mec.db'))
    migrate(db, MIGRATIONS_v1)
    const store = new SqliteStore(db)
    store.atomic(() => {
      store.engines.save({
        id: 'repo_a',
        url: repo,
        bootstrap: [],
        checks: [{ name: 'made', cmd: 'test -f made.txt' }],
        trust: false,
        hostRunAgreedAt: '2026-11-09T08:00:00.000Z',
      })
      store.messages.save({ id: 'msg_1', text: 'create made.txt containing the word made' })
      store.slots.save({
        id: 'slot_codex',
        engine: 'codex',
        kind: 'codex-sub',
        linkedDefault: true,
        state: 'healthy',
        env: {},
      })
      store.workItems.save({
        id: 'wi_codexmodels',
        state: 'executing',
        repoId: 'repo_a',
        pin: repoFields(store, 'repo_a', POLICY).pin as never,
        mandate: { originMessageId: 'msg_1' },
      })
      store.tasks.save({
        id: 'task_1',
        workItemId: 'wi_codexmodels',
        repoId: 'repo_a',
        status: 'ready',
        role: 'implementer',
        objective:
          'Create a file made.txt at the repository root containing the single word made. Then report ready.',
        originalRequestRef: 'msg_1',
        acceptanceChecks: ['made'],
        modelRequest: { tier: 'fast', reason: 'a one-file change' },
        budget: { turns: 8, wallClockMs: BOUND_MS - 30_000 },
      })
      store.attempts.save({
        id: 'att_1',
        taskId: 'task_1',
        workItemId: 'wi_codexmodels',
        slotId: 'slot_codex',
        state: 'queued',
        generation: 1,
        createdAt: '2026-11-09T10:00:00.000Z',
      })
      store.effects.enqueue('launch', 'att_1:1', {
        attempt_id: 'att_1',
        task_id: 'task_1',
        work_item_id: 'wi_codexmodels',
        slot_id: 'slot_codex',
        generation: 1,
      })
    })
    db.close()

    process.env.MEC_REAL_RUNNER = '1'
    const server = await startServer({ dataDir, policyText: POLICY, closeBoundMs: 4000 })
    closers.push(server.close)
    const read = <T>(fn: (s: SqliteStore) => T): T => {
      const handle = new Database(join(dataDir, 'mec.db'))
      try {
        return fn(new SqliteStore(handle))
      } finally {
        handle.close()
      }
    }
    const settled = ['succeeded', 'checks_failed', 'failed', 'interrupted', 'work_complete']
    const deadline = Date.now() + BOUND_MS
    while (!settled.includes(String(read((s) => s.attempts.get('att_1'))?.state))) {
      if (Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const end = read((s) => s.attempts.get('att_1')) as Record<string, unknown>
    const listing = read((s) => s.engines.get('slot-models/slot_codex')) as { listed?: string[] } | undefined
    const events = read((s) => s.events.read('attempt:att_1')).map((event) => event.type)
    const summary = {
      state: end.state,
      terminal_reason: end.terminal_reason,
      resolved_model: end.resolved_model,
      tier_degraded: end.tier_degraded,
      models_passed_over: end.models_passed_over,
      listed: listing?.listed,
      events: [...new Set(events)],
    }
    const out = process.env.MEC_CODEX_RUN_OUT
    if (out !== undefined) writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`)

    // No key shape or bearer value in any file of the data dir.
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else files.push(path)
      }
    }
    walk(dataDir)
    for (const file of files)
      expect(readFileSync(file, 'latin1')).not.toMatch(/sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\./)

    expect(listing?.listed).toContain(end.resolved_model)
    expect(end.resolved_model).toBe('gpt-5.6-luna')
    expect(end.state).toBe('succeeded')
  })
})
