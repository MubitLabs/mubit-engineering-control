import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matchesSecret } from '@mec/contracts'
import { repoFields } from '@mec/meta'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { startServer } from '../src/composition'

/**
 * A pinned OpenCode version is accepted only after this ran on it (docs/engines.md). One bounded
 * real turn through the runner, the way the workbench launches one: a seeded queued attempt, no
 * planner, the real `opencode` on PATH, scratch data dir and repository. The slot is the default
 * home's own login (`linkedDefault`, no `home`), so no keystore is read and no key reaches the test.
 * Spends Coding Plan quota, so never in CI or a wrapper:
 *
 *   MEC_REAL_OPENCODE=1 pnpm exec vitest run --project b apps/desktop/test/opencode-runner.real.test.ts
 *
 * Add a line to engine-runs.md first. `MEC_OPENCODE_MODEL` picks the model (default `glm-5.3-flash`).
 * The verdict is the store's and the journal's, never what the model says it did.
 */
const REAL = process.env.MEC_REAL_OPENCODE === '1'
const MODEL = process.env.MEC_OPENCODE_MODEL ?? 'glm-5.3-flash'
const POLICY = '{"preAuthorised":{}}'

const OBJECTIVE =
  'This is a check of your tools, in four steps, in order. 1. Create the file made.txt in the ' +
  'working directory, containing the single line made, with your file tool. 2. Run the shell ' +
  'command `git status` once. MEC is expected to refuse it: do not retry, and carry on. 3. Call the ' +
  'mec_report tool once with kind ready and the summary "made the file". 4. Stop.'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/** A bearer value that is not a `{env:}` reference: the tools token, written out. */
const BEARER = /Bearer (?!\{env:)[A-Za-z0-9._~+/=-]{20,}/

/** The files under a directory holding a key shape or a bearer value, by path only: never the text. */
function secretFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return secretFiles(path)
    const text = readFileSync(path, 'latin1')
    return matchesSecret(text) || BEARER.test(text) ? [path] : []
  })
}

describe.skipIf(!REAL)('real OpenCode through the runner', () => {
  const root = mkdtempSync(join(tmpdir(), 'mec-opencode-runner-'))
  // MEC_KEEP_SCRATCH=1 keeps the scratch tree for a look after a failure.
  afterAll(() => {
    if (process.env.MEC_KEEP_SCRATCH !== '1') rmSync(root, { recursive: true, force: true })
  })

  it('a turn on the installed binary: an edit allowed, a shell refused, a report, checks on the head', async () => {
    const dataDir = join(root, 'state')
    mkdirSync(dataDir)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '--quiet', '-b', 'main')
    git(repo, 'config', 'user.name', 'Repo Owner')
    git(repo, 'config', 'user.email', 'owner@example.com')
    git(repo, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git(repo, 'add', '--all')
    git(repo, 'commit', '--quiet', '-m', 'baseline')

    const db = new Database(join(dataDir, 'mec.db'))
    migrate(db, MIGRATIONS_v1)
    const store = new SqliteStore(db)
    store.atomic(() => {
      store.engines.save({
        id: 'repo_a',
        url: repo,
        bootstrap: [],
        checks: [{ name: 'unit', cmd: 'test -f made.txt' }],
        trust: false,
        hostRunAgreedAt: '2026-11-09T08:00:00.000Z',
      })
      store.messages.save({ id: 'msg_1', text: 'make the file' })
      store.slots.save({
        id: 'slot_x',
        engine: 'opencode',
        kind: 'opencode-glm',
        provider: 'zai-coding-plan',
        linkedDefault: true,
        state: 'healthy',
        env: {},
      } as never)
      store.workItems.save({
        id: 'wi_abcdefghij',
        state: 'executing',
        repoId: 'repo_a',
        pin: repoFields(store, 'repo_a', POLICY).pin as never,
        mandate: { originMessageId: 'msg_1' },
      })
      store.tasks.save({
        id: 'task_1',
        workItemId: 'wi_abcdefghij',
        repoId: 'repo_a',
        status: 'ready',
        role: 'implementer',
        objective: OBJECTIVE,
        originalRequestRef: 'msg_1',
        acceptanceChecks: ['manual-review'],
        modelRequest: { model: MODEL, reason: 'one small proof turn' },
      })
      store.attempts.save({
        id: 'att_1',
        taskId: 'task_1',
        workItemId: 'wi_abcdefghij',
        slotId: 'slot_x',
        state: 'queued',
        generation: 1,
        createdAt: '2026-11-09T10:00:00.000Z',
      })
      store.effects.enqueue('launch', 'att_1:1', {
        attempt_id: 'att_1',
        task_id: 'task_1',
        work_item_id: 'wi_abcdefghij',
        slot_id: 'slot_x',
        generation: 1,
      })
    })
    db.close()

    const peek = <T>(read: (store: SqliteStore) => T): T => {
      const open = new Database(join(dataDir, 'mec.db'))
      try {
        return read(new SqliteStore(open))
      } finally {
        open.close()
      }
    }
    const attempt = () => peek((s) => s.attempts.get('att_1')) as Record<string, unknown> | undefined

    const saved = process.env.MEC_REAL_RUNNER
    process.env.MEC_REAL_RUNNER = '1'
    const server = await startServer({ dataDir, policyText: POLICY, closeBoundMs: 8000 })
    const started = Date.now()
    try {
      const deadline = started + 240_000
      while (!['succeeded', 'checks_failed', 'failed', 'interrupted'].includes(String(attempt()?.state))) {
        if (Date.now() > deadline) throw new Error(`attempt never settled: ${String(attempt()?.state)}`)
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    } finally {
      await server.close()
      if (saved === undefined) delete process.env.MEC_REAL_RUNNER
      else process.env.MEC_REAL_RUNNER = saved
    }

    const end = attempt() as Record<string, unknown>
    const journal = readFileSync(join(dataDir, 'journal', 'att_1', 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((text) => JSON.parse(text) as Record<string, unknown>)
    const session = journal.find((event) => event.type === 'session_started')
    const asks = journal.filter((event) => event.type === 'permission_request')
    const results = journal.filter((event) => event.type === 'permission_result')
    console.log(
      JSON.stringify({
        state: end.state,
        terminal_reason: end.terminal_reason,
        seconds: Math.round((Date.now() - started) / 1000),
        engine_version: session?.engine_version,
        model: session?.model,
        asks: asks.map((event) => (event.operation as { kind?: string } | undefined)?.kind),
        decisions: results.map((event) => event.decision),
        root,
        types: [...new Set(journal.map((event) => String(event.type)))],
      }),
    )

    expect(session?.engine_version).toBe(
      execFileSync('opencode', ['--version'], { encoding: 'utf8' })
        .trim()
        .replace(/^opencode v/, ''),
    )
    expect(end.state).toBe('succeeded')
    const worktree = String(end.worktree)
    const head = git(worktree, 'rev-parse', 'HEAD')
    expect(git(worktree, 'show', '--name-only', '--format=', 'HEAD').split('\n')).toContain('made.txt')
    expect(git(worktree, 'log', '-p', '--format=')).not.toContain('.mec/')
    expect(peek((s) => s.engines.get('check/att_1/unit'))).toMatchObject({ status: 'passed', sha: head })
    expect(JSON.stringify(peek((s) => s.engines.get('report/att_1/1')))).toContain('made the file')
    // The bridge round trip both ways: the edit inside came back allowed, the shell refused.
    const decided = asks.map((ask) => [
      (ask.operation as { kind?: string }).kind,
      results.find((result) => result.request_id === ask.request_id)?.decision,
    ])
    expect(decided).toContainEqual(['edit', 'allow'])
    expect(decided).toContainEqual(['shell', 'deny'])
    expect(existsSync(join(worktree, 'made.txt'))).toBe(true)
    // No secret shape reached anything durable.
    expect(secretFiles(dataDir)).toEqual([])
  }, 300_000)
})
