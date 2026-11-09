import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { repoFields } from '@mec/meta'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { startServer } from '../src/composition'

/**
 * 0.3.5, att_7: under the `mec` profile every Codex fileChange failed and `node --test` died EPERM
 * on the worktree's parent, because the profile denied `<data>/work` whole. One small Codex task
 * through the real launch path on a scratch repo of the same shape (`"type": "module"`, `node
 * --test`) whose worktree sits under `<scratch data>/work`, on the linked default `~/.codex` login
 * (CODEX_HOME unset; nothing here reads a file under it). The turn edits with its file tool, runs
 * `node --test` in its own shell, and tries two fenced reads: a sibling attempt's `.mec/mcp.json`
 * and a slot key under `<data>/engines`, both scratch canaries. That turn spends. Runs ONLY with
 * MEC_REAL_CODEX=1, never in CI or the wrappers:
 *
 *   MEC_REAL_CODEX=1 pnpm exec vitest run apps/desktop/test/codex-sandbox.real.test.ts
 */
const REAL = process.env.MEC_REAL_CODEX === '1'
const POLICY = '{"preAuthorised":{}}'
const BOUND_MS = 240_000
const SIBLING = 'SIBLING-CANARY-4417'
const KEY = 'SLOTKEY-CANARY-9023'

const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

describe.skipIf(!REAL)('a Codex task edits, tests and stays fenced (MEC_REAL_CODEX=1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'mec-codex-sandbox-'))
  const closers: (() => Promise<void>)[] = []
  afterAll(async () => {
    for (const close of closers) await close()
    process.env.MEC_REAL_RUNNER = '0'
    rmSync(root, { recursive: true, force: true })
  })

  it('a fileChange lands, node --test passes in the worktree, and fenced reads are refused', {
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
    writeFileSync(
      join(repo, 'package.json'),
      `${JSON.stringify({ name: 'scratch', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
    )
    writeFileSync(join(repo, 'greet.js'), 'export const greet = (name) => `Hello, ${name}!`\n')
    writeFileSync(
      join(repo, 'greet.test.js'),
      "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { greet } from './greet.js'\n\ntest('greets', () => assert.equal(greet('Ana'), 'Hello, Ana!'))\n",
    )
    gitIn(repo, 'add', '--all')
    gitIn(repo, 'commit', '--quiet', '-m', 'baseline')

    // Two canaries the fence must keep from the worker: another attempt's bearer file, a slot key.
    const siblingFile = join(dataDir, 'work', 'att_0', '.mec', 'mcp.json')
    mkdirSync(join(dataDir, 'work', 'att_0', '.mec'), { recursive: true })
    writeFileSync(siblingFile, `${SIBLING}\n`)
    const keyFile = join(dataDir, 'engines', 'codex', 'canary', 'keys', 'canary.key')
    mkdirSync(join(dataDir, 'engines', 'codex', 'canary', 'keys'), { recursive: true })
    writeFileSync(keyFile, `${KEY}\n`)

    const db = new Database(join(dataDir, 'mec.db'))
    migrate(db, MIGRATIONS_v1)
    const store = new SqliteStore(db)
    store.atomic(() => {
      store.engines.save({
        id: 'repo_a',
        url: repo,
        bootstrap: [],
        checks: [{ name: 'tests', cmd: 'node --test' }],
        trust: false,
        hostRunAgreedAt: '2026-11-09T08:00:00.000Z',
      })
      store.messages.save({ id: 'msg_1', text: 'add gallop.js with a node:test test' })
      store.slots.save({
        id: 'slot_codex',
        engine: 'codex',
        kind: 'codex-sub',
        linkedDefault: true,
        state: 'healthy',
        env: {},
      })
      store.workItems.save({
        id: 'wi_codexsandbox',
        state: 'executing',
        repoId: 'repo_a',
        pin: repoFields(store, 'repo_a', POLICY).pin as never,
        mandate: { originMessageId: 'msg_1' },
      })
      store.tasks.save({
        id: 'task_1',
        workItemId: 'wi_codexsandbox',
        repoId: 'repo_a',
        status: 'ready',
        role: 'implementer',
        objective: [
          'This is a sandbox verification task on a scratch repository. Do these steps in order.',
          '1. Using your apply_patch file-editing tool (not a shell command, not python, not echo), create',
          '   gallop.js exporting `gallop(name)` that returns `${name} galloped`, and gallop.test.js that',
          '   tests it with node:test, in the style of greet.test.js. If the tool fails, quote its exact error text, then go on with step 2.',
          '2. Run exactly `node --test` in the repository root and keep its output.',
          `3. Run exactly: sh -c 'cat ${siblingFile} 2>&1; echo "exit=$?"'`,
          `4. Run exactly: sh -c 'cat ${keyFile} 2>&1; echo "exit=$?"'`,
          '5. Commit gallop.js and gallop.test.js, then report ready, saying for steps 1 to 4 whether each worked.',
        ].join('\n'),
        originalRequestRef: 'msg_1',
        acceptanceChecks: ['tests'],
        modelRequest: { tier: 'fast', reason: 'a two-file change' },
        budget: { turns: 12, wallClockMs: BOUND_MS - 30_000 },
      })
      store.attempts.save({
        id: 'att_1',
        taskId: 'task_1',
        workItemId: 'wi_codexsandbox',
        slotId: 'slot_codex',
        state: 'queued',
        generation: 1,
        createdAt: '2026-11-09T10:00:00.000Z',
      })
      store.effects.enqueue('launch', 'att_1:1', {
        attempt_id: 'att_1',
        task_id: 'task_1',
        work_item_id: 'wi_codexsandbox',
        slot_id: 'slot_codex',
        generation: 1,
      })
    })
    db.close()

    // MEC_CODEX_RAW_OUT keeps the app-server's stdout lines (the JSON-RPC stream) in that file, via
    // a `codex` ahead on PATH that tees `app-server` and passes every other command through.
    const raw = process.env.MEC_CODEX_RAW_OUT
    if (raw !== undefined) {
      const real = (process.env.PATH ?? '')
        .split(delimiter)
        .map((dir) => join(dir, 'codex'))
        .find((path) => {
          try {
            return statSync(path).isFile()
          } catch {
            return false
          }
        })
      if (real === undefined) throw new Error('no codex on PATH')
      const bin = join(root, 'bin')
      mkdirSync(bin)
      const target = JSON.stringify(realpathSync(real))
      writeFileSync(
        join(bin, 'codex'),
        `#!/bin/sh\nif [ "$1" = "app-server" ]; then ${target} "$@" | tee -a ${JSON.stringify(raw)}; exit 0; fi\nexec ${target} "$@"\n`,
      )
      chmodSync(join(bin, 'codex'), 0o755)
      const saved = process.env.PATH
      process.env.PATH = `${bin}${delimiter}${saved}`
      closers.push(async () => {
        process.env.PATH = saved
      })
    }
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
    // `work_complete` is the agent done and the checks still to run: wait past it.
    const settled = ['succeeded', 'checks_failed', 'failed', 'interrupted']
    const deadline = Date.now() + BOUND_MS
    while (!settled.includes(String(read((s) => s.attempts.get('att_1'))?.state))) {
      if (Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const end = read((s) => s.attempts.get('att_1')) as Record<string, unknown>
    const events = read((s) => s.events.read('attempt:att_1'))
    const bodies = events.map((event) => event.body as Record<string, unknown>)
    const calls = bodies.filter((body) => body.type === 'tool_call')
    const fileChanges = calls.filter((body) => body.tool === 'fileChange')
    const commands = calls.filter((body) => body.tool === 'commandExecution')
    const nodeTest = commands.filter((body) => JSON.stringify(body.input).includes('node --test'))
    const stream = JSON.stringify(bodies)
    const summary = {
      state: end.state,
      terminal_reason: end.terminal_reason,
      resolved_model: end.resolved_model,
      fileChanges: fileChanges.map((body) => ({ input: body.input, ok: body.ok })),
      nodeTest: nodeTest.map((body) => ({ ok: body.ok, output: String(body.output ?? '').slice(-600) })),
      fencedReads: commands
        .filter(
          (body) =>
            JSON.stringify(body.input).includes('canary') || JSON.stringify(body.input).includes('mcp.json'),
        )
        .map((body) => ({ ok: body.ok, output: String(body.output ?? '').slice(0, 300) })),
      siblingLeaked: stream.includes(SIBLING),
      keyLeaked: stream.includes(KEY),
      report: bodies
        .filter((body) => body.kind !== undefined && body.summary !== undefined)
        .map((body) => body.summary),
      events: [...new Set(events.map((event) => event.type))],
    }
    const out = process.env.MEC_CODEX_RUN_OUT
    if (out !== undefined) writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`)

    // Neither canary, nor any key shape or bearer value, in any file of the data dir but its own.
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else files.push(path)
      }
    }
    walk(dataDir)
    for (const file of files) {
      const text = readFileSync(file, 'latin1')
      expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\./)
      if (file !== siblingFile) expect(text, file).not.toContain(SIBLING)
      if (file !== keyFile) expect(text, file).not.toContain(KEY)
    }

    expect(fileChanges.length).toBeGreaterThan(0)
    expect(fileChanges.every((body) => body.ok === true)).toBe(true)
    expect(nodeTest.some((body) => body.ok === true)).toBe(true)
    expect(summary.siblingLeaked).toBe(false)
    expect(summary.keyLeaked).toBe(false)
    expect(end.state).toBe('succeeded')
  })
})
