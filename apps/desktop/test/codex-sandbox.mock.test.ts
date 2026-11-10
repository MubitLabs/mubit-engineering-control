import { execFileSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { repoFields } from '@mec/meta'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { startServer } from '../src/composition'

/**
 * The real launch path and the real codex-cli app-server, with only the model replaced: a local
 * mock of the Responses API answers scripted tool calls, so a turn spends nothing. A wrapper named
 * `codex` ahead on PATH adds the mock provider to `app-server` and passes every other command
 * through (the probe's `login status` reads the linked default login itself; nothing here reads a
 * file under `~/.codex`, and the mock provider carries a dummy key, so no sign-in reaches the mock).
 * Runs ONLY with MEC_REAL_CODEX_MOCK=1, never in CI or the wrappers (it needs the real binary):
 *
 *   MEC_REAL_CODEX_MOCK=1 pnpm exec vitest run apps/desktop/test/codex-sandbox.mock.test.ts
 *
 * The patch goes the way gpt-5.6 models sent every one in the store (att_7, att_10, att_15): code
 * mode, `tools.apply_patch(patch)` inside the `exec` tool. MOCK_FORM=custom sends the bare
 * `apply_patch` tool call, MOCK_FORM=shell `apply_patch <<'EOF'` through exec_command;
 * MOCK_NO_REALPATH=1 keeps the data dir under the `/var` symlink.
 *
 * The wrapper sits behind a link on PATH, as `~/.local/bin/codex` links into `~/.codex`, and runs
 * codex by the path MEC chose: by the link when MEC launched the link, by its real path otherwise.
 */
const ON = process.env.MEC_REAL_CODEX_MOCK === '1'
const POLICY = '{"preAuthorised":{}}'
const BOUND_MS = 120_000

type Step = { item: Record<string, unknown> }

const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/** The first codex on PATH, as MEC's launch finds it: not resolved. */
function onPath(): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    try {
      accessSync(join(dir, 'codex'), constants.X_OK)
      return join(dir, 'codex')
    } catch {}
  }
  throw new Error('no codex on PATH')
}

/** A Responses API that plays `steps` in order, one per request, then a final message. */
function mockResponses(steps: (worktree: () => string) => Step[]) {
  const seen: unknown[] = []
  let worktree = ''
  let call = 0
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      if (!String(req.url).includes('/responses')) {
        res.writeHead(404).end()
        return
      }
      const parsed = JSON.parse(body || '{}') as { input?: unknown[] }
      seen.push({ input: parsed.input, dummyAuth: req.headers.authorization === 'Bearer mock-not-a-key' })
      const script = steps(() => worktree)
      const step = script[call]
      call += 1
      const id = `resp_${call}`
      const item = step?.item ?? {
        type: 'message',
        id: `msg_${call}`,
        role: 'assistant',
        content: [{ type: 'output_text', text: 'done', annotations: [] }],
        status: 'completed',
      }
      const events = [
        { type: 'response.created', response: { id } },
        { type: 'response.output_item.done', item },
        {
          type: 'response.completed',
          response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        },
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end()
    })
  })
  return { server, seen, setWorktree: (path: string) => (worktree = path) }
}

describe.skipIf(!ON)('the real launch path with a mock model (MEC_REAL_CODEX_MOCK=1)', () => {
  const made = mkdtempSync(join(tmpdir(), 'mec-codex-mock-'))
  const root = process.env.MOCK_NO_REALPATH === '1' ? made : realpathSync(made)
  const closers: (() => Promise<void>)[] = []
  afterAll(async () => {
    for (const close of closers) await close()
    process.env.MEC_REAL_RUNNER = '0'
    rmSync(root, { recursive: true, force: true })
  })

  it('a fileChange lands and node --test runs in the worktree', { timeout: BOUND_MS + 30_000 }, async () => {
    const dataDir = join(root, 'state')
    mkdirSync(dataDir)
    const worktree = join(dataDir, 'work', 'att_1')
    const patch = [
      '*** Begin Patch',
      `*** Add File: ${worktree}/gallop.js`,
      '+export const gallop = (name) => `${name} galloped`',
      `*** Add File: ${worktree}/gallop.test.js`,
      "+import { test } from 'node:test'",
      "+import assert from 'node:assert/strict'",
      "+import { gallop } from './gallop.js'",
      "+test('gallops', () => assert.match(gallop('Ana'), /^Ana galloped/))",
      '*** End Patch',
      '',
    ].join('\n')
    const form = process.env.MOCK_FORM ?? 'exec'
    const editStep: Step =
      form === 'exec'
        ? {
            item: {
              type: 'custom_tool_call',
              id: 'ctc_1',
              call_id: 'call_1',
              name: 'exec',
              input: `const patch = ${JSON.stringify(patch)};\ntext(await tools.apply_patch(patch));\n`,
              status: 'completed',
            },
          }
        : form === 'shell'
          ? {
              item: {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_1',
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: `apply_patch <<'EOF'\n${patch}EOF\n`, workdir: worktree }),
              },
            }
          : {
              item: {
                type: 'custom_tool_call',
                id: 'ctc_1',
                call_id: 'call_1',
                name: 'apply_patch',
                input: patch,
                status: 'completed',
              },
            }
    // A second patch edits a file the first one added, as att_15's did: an update reads the file
    // through the same fs helper first ("fs sandbox helper failed" when it cannot start).
    const update = [
      '*** Begin Patch',
      `*** Update File: ${worktree}/gallop.js`,
      '@@',
      '-export const gallop = (name) => `${name} galloped`',
      '+export const gallop = (name) => `${name} galloped away`',
      '*** End Patch',
      '',
    ].join('\n')
    const updateStep: Step = {
      item: {
        type: 'custom_tool_call',
        id: 'ctc_3',
        call_id: 'call_3',
        name: 'exec',
        input: `const patch = ${JSON.stringify(update)};\ntext(await tools.apply_patch(patch));\n`,
        status: 'completed',
      },
    }
    const mock = mockResponses(() => [
      editStep,
      updateStep,
      {
        item: {
          type: 'function_call',
          id: 'fc_2',
          call_id: 'call_2',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'node --test', workdir: worktree }),
        },
      },
    ])
    await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', resolve))
    closers.push(() => new Promise((resolve) => mock.server.close(() => resolve())))
    const port = (mock.server.address() as { port: number }).port

    const bin = join(root, 'bin')
    const wrap = join(root, 'wrap')
    mkdirSync(bin)
    mkdirSync(wrap)
    const provider = `model_providers.mock={name="mock",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false,env_key="MOCK_PROVIDER_KEY"}`
    writeFileSync(
      join(wrap, 'codex'),
      [
        '#!/bin/sh',
        // Run by the link MEC was handed, codex runs by the link on PATH too; run by its real path,
        // codex does: so the codex below runs by the path MEC chose.
        `if [ -L "$0" ]; then CODEX=${JSON.stringify(onPath())}; else CODEX=${JSON.stringify(realpathSync(onPath()))}; fi`,
        `if [ "$1" = "app-server" ]; then shift; MOCK_PROVIDER_KEY=mock-not-a-key exec "$CODEX" app-server -c 'model_provider="mock"' -c '${provider}' "$@"; fi`,
        'exec "$CODEX" "$@"',
        '',
      ].join('\n'),
    )
    chmodSync(join(wrap, 'codex'), 0o755)
    symlinkSync(join(wrap, 'codex'), join(bin, 'codex'))
    const savedPath = process.env.PATH
    process.env.PATH = `${bin}${delimiter}${savedPath}`
    closers.push(async () => {
      process.env.PATH = savedPath
    })

    const repo = join(root, 'repo')
    mkdirSync(repo)
    gitIn(repo, 'init', '--quiet', '-b', 'main')
    gitIn(repo, 'config', 'user.name', 'Scratch Owner')
    gitIn(repo, 'config', 'user.email', 'scratch@example.com')
    gitIn(repo, 'config', 'commit.gpgsign', 'false')
    writeFileSync(
      join(repo, 'package.json'),
      '{"name":"s","private":true,"type":"module","scripts":{"test":"node --test"}}\n',
    )
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
        checks: [],
        trust: false,
        hostRunAgreedAt: '2026-11-09T08:00:00.000Z',
      })
      store.messages.save({ id: 'msg_1', text: 'add gallop.js' })
      store.slots.save({
        id: 'slot_codex',
        engine: 'codex',
        kind: 'codex-sub',
        linkedDefault: true,
        state: 'healthy',
        env: {},
      })
      store.workItems.save({
        id: 'wi_mock',
        state: 'executing',
        repoId: 'repo_a',
        pin: repoFields(store, 'repo_a', POLICY).pin as never,
        mandate: { originMessageId: 'msg_1' },
      })
      store.tasks.save({
        id: 'task_1',
        workItemId: 'wi_mock',
        repoId: 'repo_a',
        status: 'ready',
        role: 'implementer',
        objective: 'add gallop.js',
        originalRequestRef: 'msg_1',
        acceptanceChecks: [],
        modelRequest: { tier: 'fast', reason: 'mock' },
        budget: { turns: 8, wallClockMs: BOUND_MS - 20_000 },
      })
      store.attempts.save({
        id: 'att_1',
        taskId: 'task_1',
        workItemId: 'wi_mock',
        slotId: 'slot_codex',
        state: 'queued',
        generation: 1,
        createdAt: '2026-11-09T10:00:00.000Z',
      })
      store.effects.enqueue('launch', 'att_1:1', {
        attempt_id: 'att_1',
        task_id: 'task_1',
        work_item_id: 'wi_mock',
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
    const deadline = Date.now() + BOUND_MS
    while (!read((s) => s.events.read('attempt:att_1')).some((event) => event.type === 'exit')) {
      const state = String(read((s) => s.attempts.get('att_1'))?.state)
      if (Date.now() > deadline || ['failed', 'interrupted'].includes(state)) break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    const bodies = read((s) => s.events.read('attempt:att_1')).map(
      (event) => event.body as Record<string, unknown>,
    )
    const calls = bodies.filter((body) => body.type === 'tool_call')
    const outputs = (mock.seen as { input?: { type?: string; output?: unknown }[] }[]).flatMap((request) =>
      (request.input ?? []).filter((entry) => String(entry.type).endsWith('_output')),
    )
    const out = process.env.MEC_CODEX_MOCK_OUT
    if (out !== undefined) {
      writeFileSync(
        out,
        `${JSON.stringify({ state: read((s) => s.attempts.get('att_1'))?.state, calls, outputs, dummyAuth: (mock.seen as { dummyAuth: boolean }[]).map((r) => r.dummyAuth) }, null, 2)}\n`,
      )
    }
    const fileChanges = calls.filter((body) => body.tool === 'fileChange')
    const nodeTest = calls.find(
      (body) => body.tool === 'commandExecution' && JSON.stringify(body.input).includes("'node --test'"),
    )
    // 0.3.5 att_7, 0.3.6 att_10: run by the link into the denied `~/.codex`, the fs helper that
    // applies the patch could not start, and the model heard "Failed to write file".
    expect(JSON.stringify(outputs)).not.toContain('Failed to write file')
    expect(fileChanges.map((body) => body.ok)).toEqual([true, true])
    // 0.3.5, att_7: with `<data>/work` denied whole this died `EPERM ... lstat '<data>/work'`.
    expect(String(nodeTest?.output)).not.toContain('EPERM')
    expect(nodeTest?.ok).toBe(true)
    expect(readFileSync(join(worktree, 'gallop.js'), 'utf8')).toContain('galloped away')
  })
})
