// M2.1's permission boundary: what a specialist's token reaches, on the real server with real
// tokens over real HTTP. The fence is the point, so everything goes through `tools/call`.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Operation } from '@mec/contracts'
import { issueToken, MecToolsServer } from '@mec/mec-tools'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { reportDocId, StoreFacts } from '../src/core-facts'
import { judgeOperation, specialistBridge, specialistTools } from '../src/specialist-tools'

const SECRET = 'specialist-tools-test-secret'
const root = mkdtempSync(join(tmpdir(), 'mec-specialist-'))
const worktree = join(root, 'work', 'att_1')
const tempDir = join(root, 'tmp', 'att_1')
const HEAD = 'a'.repeat(40)

const db = new Database(':memory:')
migrate(db, MIGRATIONS_v1)
const store = new SqliteStore(db)
const facts = new StoreFacts(store, (_attemptId, value) => value)
const tools = new MecToolsServer({
  secret: SECRET,
  bridge: { request: async () => 'deny' },
  onCall: specialistTools({ store, facts, headOf: async () => HEAD }),
})
let url = ''

type Rpc = { result?: { content: { text: string }[]; isError: boolean }; error?: { message: string } }

async function call(token: string, tool: string, args: unknown): Promise<Rpc> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  })
  return (await response.json()) as Rpc
}

const answer = (rpc: Rpc): Record<string, unknown> => JSON.parse(rpc.result?.content[0]?.text ?? 'null')

const tokenFor = (attemptId: string, generation = 1, role: 'specialist' | 'meta_agent' = 'specialist') =>
  issueToken({ attemptId, generation, role, secret: SECRET })

const own = tokenFor('att_1')

beforeAll(async () => {
  mkdirSync(worktree, { recursive: true })
  mkdirSync(tempDir, { recursive: true })
  mkdirSync(join(root, 'outside'))
  symlinkSync(join(root, 'outside'), join(worktree, 'escape'))
  url = (await tools.start()).url
  store.atomic(() => {
    store.messages.save({ id: 'msg_1', text: 'the request' })
    store.messages.save({ id: 'msg_2', text: 'somebody else asked this' })
    store.tasks.save({ id: 'task_1', workItemId: 'wi_1', objective: 'own task', status: 'active' })
    store.tasks.save({ id: 'task_2', workItemId: 'wi_2', objective: 'other task', status: 'active' })
    store.engines.save({ id: 'prompts/rev1', text: 'own prompt' })
    store.engines.save({ id: 'prompts/rev2', text: 'other prompt' })
    const base = { state: 'running', generation: 1, workItemId: 'wi_1' }
    store.attempts.save({
      ...base,
      id: 'att_1',
      taskId: 'task_1',
      worktree,
      temp_dir: tempDir,
      sandbox: 'required',
      origin_message_id: 'msg_1',
      bundle_revision: 'rev1',
    })
    store.attempts.save({ ...base, id: 'att_2', taskId: 'task_2', workItemId: 'wi_2' })
    store.attempts.save({ ...base, id: 'att_done', taskId: 'task_1', state: 'succeeded' })
  })
})

afterAll(async () => {
  await tools.stop()
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('read', () => {
  it('specialist reads only its own attempt', async () => {
    expect(answer(await call(own, 'read', { resource: 'attempt/att_1' })).text).toContain('att_1')
    expect(answer(await call(own, 'read', { resource: 'task/task_1' })).text).toContain('own task')
    expect(answer(await call(own, 'read', { resource: 'message/msg_1' })).text).toContain('the request')
    expect(answer(await call(own, 'read', { resource: 'prompts/rev1' })).text).toContain('own prompt')

    for (const resource of [
      'attempt/att_2',
      'task/task_2',
      'message/msg_2',
      'prompts/rev2',
      'work_items',
      'slots',
      'attempt/att_2/report',
      '',
    ]) {
      const rpc = await call(own, 'read', { resource })
      expect(rpc.result, resource).toBeUndefined()
      expect(rpc.error?.message).toContain('not readable')
    }
  })

  it('never answers with the secrets of a doc: only named fields leave', async () => {
    const text = String(answer(await call(own, 'read', { resource: 'attempt/att_1' })).text)
    expect(text).not.toContain('temp_dir')
  })

  it('pages a long resource and rejects a nonsense cursor', async () => {
    store.atomic(() => store.engines.save({ id: 'prompts/rev1', text: 'x'.repeat(9000) }))
    const first = answer(await call(own, 'read', { resource: 'prompts/rev1' }))
    expect(String(first.text)).toHaveLength(4000)
    const second = answer(await call(own, 'read', { resource: 'prompts/rev1', cursor: first.next }))
    expect(second.next).toBe('8000')
    expect((await call(own, 'read', { resource: 'prompts/rev1', cursor: 'x' })).error).toBeDefined()
  })
})

describe('confirm', () => {
  // The shape Claude Code 2.1.318 really sends, recorded in the M2.1 builder runs.
  const ask = async (tool_name: string, input: Record<string, unknown>) =>
    answer(await call(own, 'confirm', { tool_name, input, tool_use_id: 'toolu_1' }))

  it('git push is denied without a card', async () => {
    for (const command of [
      'git push origin HEAD',
      'git -C . push',
      'cd sub && git  push --force',
      'gh pr create --fill',
      '/usr/local/bin/gh api repos',
      'git branch -D main',
      'git branch --delete main',
      'git rebase --force-with-lease',
    ]) {
      const verdict = await ask('Bash', { command })
      expect(verdict.behavior, command).toBe('deny')
      expect(String(verdict.message)).toMatch(/confirmation/)
    }
    expect(store.confirmations.list()).toEqual([])
  })

  it('a ref delete is a branch delete, however it is spelled', async () => {
    for (const command of [
      'git update-ref -d refs/heads/mec/other/task/a1',
      'git -C . update-ref --delete refs/heads/mec/other/task/a1',
      'echo "delete refs/heads/mec/other/task/a1" | git update-ref --stdin',
      'git update-ref refs/heads/mec/other/task/a1 0123456',
    ]) {
      const verdict = await ask('Bash', { command })
      expect(verdict.behavior, command).toBe('deny')
      expect(String(verdict.message)).toMatch(/confirmation/)
    }
  })

  it('allows Bash under the required sandbox, with the input it was given', async () => {
    const input = { command: 'pnpm test', description: 'run the tests' }
    expect(await ask('Bash', input)).toEqual({ behavior: 'allow', updatedInput: input })
    // Words that merely look like a guarded command do not trip it.
    expect((await ask('Bash', { command: 'echo pushing && git status' })).behavior).toBe('allow')
  })

  it('reads the schema name for the input too, and denies a request with nothing in it', async () => {
    const schema = await call(own, 'confirm', { tool_name: 'Bash', tool_input: { command: 'git push' } })
    expect(answer(schema).behavior).toBe('deny')
    const empty = answer(await call(own, 'confirm', { tool_name: 'Bash' }))
    expect(empty).toEqual({ behavior: 'deny', message: 'no command to check' })
    expect((await ask('Write', {})).behavior).toBe('deny')
  })

  it('denies Bash when the attempt has no required sandbox', () => {
    const scope = { worktree, tempDir, sandboxRequired: false }
    const operation: Operation = { kind: 'shell', summary: 'ls', command: ['ls'] }
    expect(judgeOperation(operation, scope).allow).toBe(false)
  })

  it('allows edit and write inside the worktree and temp dir only', async () => {
    expect((await ask('Write', { file_path: join(worktree, 'src/a.ts') })).behavior).toBe('allow')
    expect((await ask('Edit', { file_path: 'relative/b.ts' })).behavior).toBe('allow')
    expect((await ask('Write', { file_path: join(tempDir, 'scratch') })).behavior).toBe('allow')

    for (const file_path of [
      join(root, 'mec.db'),
      '/etc/passwd',
      join(worktree, '..', 'att_2', 'x'),
      join(worktree, 'escape', 'x'),
      join(worktree, '.mec', 'bin', 'claude'),
      join(worktree, '.git'),
    ]) {
      const verdict = await ask('Write', { file_path })
      expect(verdict.behavior, file_path).toBe('deny')
    }
  })

  it('denies everything else, with a reason', async () => {
    for (const tool of ['Read', 'WebFetch', 'Task', 'mcp__other__tool', '']) {
      const verdict = await ask(tool, { file_path: join(root, 'mec.db') })
      expect(verdict.behavior, tool).toBe('deny')
      expect(String(verdict.message)).not.toBe('')
    }
  })

  it('records every ask', async () => {
    const before = store.events.read('attempt:att_1').length
    await ask('Bash', { command: 'git push' })
    await ask('Bash', { command: 'ls' })
    const asks = store.events.read('attempt:att_1').slice(before)
    expect(asks.map((event) => event.type)).toEqual([
      'attempt.permission_requested',
      'attempt.permission_requested',
    ])
    expect(JSON.stringify(asks[0]?.body)).toContain('git push')
  })

  it('the in-process bridge answers by the same rule', async () => {
    const bridge = specialistBridge(store)
    const evidence = { raw: null, worktree }
    const deadline = new Date(Date.now() + 5000).toISOString()
    const ref = { attempt_id: 'att_1', generation: 1 }
    const shell = (command: string): Operation => ({ kind: 'shell', summary: command, command: [command] })
    expect(await bridge.request(ref, shell('git push'), evidence, deadline)).toBe('deny')
    expect(await bridge.request(ref, shell('ls'), evidence, deadline)).toBe('allow')
    const nobody = { attempt_id: 'att_none', generation: 1 }
    expect(await bridge.request(nobody, shell('ls'), evidence, deadline)).toBe('deny')
  })
})

describe('report', () => {
  it('stores a parsed report and records a claimed head beside the real one', async () => {
    const claimed = 'b'.repeat(40)
    const rpc = await call(own, 'report', { kind: 'ready', summary: 'done', head_sha: claimed })
    expect(answer(rpc)).toEqual({ ok: true, report: 1 })
    const doc = store.engines.get(reportDocId('att_1', 1))
    expect(doc).toMatchObject({ observed_head: HEAD, head_matches: false })
    expect(store.events.read('attempt:att_1').map((event) => event.type)).toContain('attempt.report')
  })

  it('refuses a report outside the closed vocabulary', async () => {
    const rpc = await call(own, 'report', { kind: 'finished', summary: 'done' })
    expect(rpc.error?.message).toContain('invalid report')
  })

  it('an ended attempt reports nothing and permits nothing', async () => {
    const token = tokenFor('att_done')
    expect((await call(token, 'report', { kind: 'ready', summary: 'x' })).error).toBeDefined()
    expect((await call(token, 'confirm', { tool_name: 'Bash', tool_input: {} })).error).toBeDefined()
  })
})

describe('the fence', () => {
  it('meta token refused', async () => {
    const meta = tokenFor('att_1', 1, 'meta_agent')
    const rpc = await call(meta, 'read', { resource: 'attempt/att_1' })
    expect(rpc.error?.message).toContain('meta agent')
  })

  it('unwired tools answer an error, never success', async () => {
    for (const [tool, args] of [
      ['ask_user', { question: 'which one?' }],
      ['handback', { message_id: 'msg_1', reason: 'not mine' }],
      ['request_confirmation', { operation: {}, evidence: {} }],
    ] as const) {
      const rpc = await call(own, tool, args)
      expect(rpc.result, tool).toBeUndefined()
      expect(rpc.error?.message).toContain('not wired until M2.2')
    }
  })

  it('a specialist token cannot reach the planner tools', async () => {
    for (const tool of ['propose_plan', 'spawn_agent', 'stop_agent']) {
      const rpc = await call(own, tool, {})
      expect(rpc.error?.message, tool).toContain('not available for role')
    }
  })

  it('a token of another generation than the attempt holds is refused', async () => {
    const rpc = await call(tokenFor('att_1', 7), 'read', { resource: 'attempt/att_1' })
    expect(rpc.error?.message).toContain('stale generation')
  })
})
