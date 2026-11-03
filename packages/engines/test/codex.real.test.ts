import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EngineEvent, PermissionBridge } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
import { CodexAdapter } from '../src/codex/adapter'

/**
 * R2.1 canary — the real codex app-server through the ADAPTER (never a scratch client).
 * Runs ONLY with MEC_REAL_CODEX=1 and a logged-in dedicated slot:
 *   MEC_REAL_CODEX=1 MEC_CODEX_SLOT=~/.mec/engines/codex/codex-1 \
 *     pnpm exec vitest run packages/engines/test/codex.real.test.ts
 * Two tiny real turns (cents of ChatGPT quota): a smoke turn and one permission round-trip.
 * Re-run at every handshake and on every pinned engine version change (plan §7.1).
 */
const REAL = process.env.MEC_REAL_CODEX === '1'
const SLOT = process.env.MEC_CODEX_SLOT ?? join(process.env.HOME ?? '', '.mec/engines/codex/codex-1')

/** One real `codex app-server` child, wired into the adapter's injectable deps (argv-only spawn). */
type RealClient = {
  post: (payload: unknown) => Promise<unknown>
  notifications: () => AsyncIterable<string>
  processExitCode: () => number | undefined
  stop: () => Promise<void>
}

function startAppServer(): RealClient {
  const child = spawn('codex', ['app-server'], {
    env: { ...process.env, CODEX_HOME: SLOT },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const queue: string[] = []
  const wakeups: (() => void)[] = []
  let ended = false
  let exitCode: number | undefined
  child.stdout.setEncoding('utf8')
  let buf = ''
  child.stdout.on('data', (chunk: string) => {
    buf += chunk
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim() === '') continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (
        msg.method === undefined &&
        msg.id !== undefined &&
        (msg.result !== undefined || msg.error !== undefined)
      ) {
        const waiter = pending.get(Number(msg.id))
        if (waiter) {
          pending.delete(Number(msg.id))
          msg.error !== undefined
            ? waiter.reject(new Error(JSON.stringify(msg.error)))
            : waiter.resolve(msg.result)
          continue
        }
      }
      // notifications AND server→client requests (approval asks) feed the adapter
      queue.push(line)
      for (const wake of wakeups.splice(0)) wake()
    }
  })
  child.on('exit', (code) => {
    ended = true
    exitCode = code === null ? 137 : code
    for (const wake of wakeups.splice(0)) wake()
  })
  return {
    post: (payload) =>
      new Promise((resolve, reject) => {
        const message = payload as { id?: number | string; method?: string }
        if (message.method === undefined || message.id === undefined) {
          // a notification (no id) or a RESPONSE to a server request (no method): nothing comes back
          child.stdin.write(`${JSON.stringify(payload)}\n`)
          resolve({})
          return
        }
        pending.set(Number(message.id), { resolve, reject })
        child.stdin.write(`${JSON.stringify(payload)}\n`)
      }),
    notifications: () => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            while (queue.length === 0 && !ended) {
              await new Promise<void>((r) => wakeups.push(r))
            }
            return queue.length > 0
              ? { value: queue.shift() as string, done: false }
              : { value: undefined, done: true }
          },
        }
      },
    }),
    processExitCode: () => exitCode,
    stop: async () => {
      child.kill('SIGTERM')
      await new Promise<void>((r) => {
        if (ended) return r()
        child.on('exit', () => r())
        setTimeout(() => {
          child.kill('SIGKILL')
          r()
        }, 2000)
      })
    },
  }
}

const brief = (over: {
  attempt_id: string
  worktree: string
  read_only: boolean
  permission_mode: 'bridge' | 'none'
}) =>
  ({
    attempt_id: over.attempt_id,
    generation: 1,
    task_id: 'task_canary',
    work_item_id: 'wi_canary',
    role: { name: 'implementer', revision: 'r0' },
    engine: 'codex',
    slot_id: 'slot_codex1',
    worktree: over.worktree,
    base_sha: '0'.repeat(40),
    branch: 'mec/canary',
    origin: { messages: [] },
    objective: 'R2.1 canary',
    owned_paths: [],
    acceptance_checks: [],
    budget: { turns: 2, wall_clock_ms: 240_000 },
    bundle_revision: 'r0',
    tools: { url: 'http://127.0.0.1:1', token: 't' },
    env: {},
    isolation: {
      sandbox: 'required',
      read_only: over.read_only,
      allow_write: [],
      deny_read: [],
      allowed_domains: [],
      blocked_commands: [],
      background_cap_ms: 240_000,
      permission_mode: over.permission_mode,
      repo_trusted: false,
    },
  }) as const

describe.skipIf(!REAL)('R2.1: real codex app-server through the adapter', () => {
  const root = mkdtempSync(join(tmpdir(), 'mec-codex-canary-'))
  const answers: Array<{ decision: string; operation: unknown }> = []

  it('a real smoke turn: session_started → message CODEX-H1-OK → usage/rate_limit → exit completed', async () => {
    const client = startAppServer()
    try {
      const adapter = new CodexAdapter({
        post: client.post,
        notifications: client.notifications,
        processExitCode: client.processExitCode,
      })
      const worktree = join(root, 'smoke')
      mkdirSync(worktree, { recursive: true })
      const handle = await adapter.launch({
        brief: brief({
          attempt_id: 'att_cx_smoke',
          worktree,
          read_only: true,
          permission_mode: 'none',
        }) as never,
        env: {},
        cwd: worktree,
        bridge: { request: async () => 'deny' },
      } as never)
      expect(handle.session_id).toMatch(/^[0-9a-f-]{10,}$/)
      await adapter.send(handle, { id: 'inp_1', kind: 'message', text: 'Reply with exactly: CODEX-H1-OK' })
      const events: EngineEvent[] = []
      for await (const event of adapter.events(handle)) {
        events.push(event)
        if (event.type === 'exit') break // the app-server never exits on its own
      }
      const types = events.map((e) => e.type)
      expect(types[0]).toBe('session_started')
      expect(types.at(-1)).toBe('exit')
      const message = events.find((e) => e.type === 'message' && e.role === 'assistant')
      expect(message && message.type === 'message' ? message.text : '').toContain('CODEX-H1-OK')
      expect(types).toContain('usage')
      expect(types).toContain('rate_limit')
      const exit = events.at(-1)
      expect(exit && exit.type === 'exit' ? exit.terminal_reason : '').toBe('completed')
      const session = events[0]
      expect(session && session.type === 'session_started' ? session.engine_version : '').toBe('0.148.0')
    } finally {
      await client.stop()
    }
  }, 240_000)

  it('a real permission round-trip: read-only sandbox + on-request, answered allow through the bridge stub', async () => {
    const client = startAppServer()
    try {
      const bridge: PermissionBridge = {
        request: async (_attempt, operation) => {
          answers.push({ decision: 'allow', operation })
          return 'allow'
        },
      }
      const adapter = new CodexAdapter({
        post: client.post,
        notifications: client.notifications,
        processExitCode: client.processExitCode,
      })
      const worktree = join(root, 'perm')
      mkdirSync(worktree, { recursive: true })
      const spec = {
        brief: brief({
          attempt_id: 'att_cx_perm',
          worktree,
          read_only: true, // read-only sandbox + on-request: the write must escalate → approval
          permission_mode: 'bridge',
        }),
        env: {},
        cwd: worktree,
        resume: undefined,
        bridge,
      }
      const handle = await adapter.launch(spec as never)
      await adapter.send(handle, {
        id: 'inp_1',
        kind: 'message',
        text: 'Run this exact shell command: touch canary.txt — then reply with exactly: CANARY-PERM-OK',
      })
      const events: EngineEvent[] = []
      for await (const event of adapter.events(handle)) {
        events.push(event)
        if (event.type === 'exit') break // the app-server never exits on its own
      }
      const types = events.map((e) => e.type)
      // the round trip: request → bridge allow → result → the escalated command ran
      const request = events.find((e) => e.type === 'permission_request')
      expect(request && request.type === 'permission_request' ? request.operation.kind : '').toBe('shell')
      const result = events.find((e) => e.type === 'permission_result')
      expect(result && result.type === 'permission_result' ? result.decision : '').toBe('allow')
      expect(answers).toHaveLength(1)
      expect(types).toContain('tool_call')
      const toolCall = events.find((e) => e.type === 'tool_call')
      expect(toolCall && toolCall.type === 'tool_call' ? toolCall.ok : undefined).toBe(true)
      // the approval really escalated: the file exists on disk outside the read-only sandbox
      expect(existsSync(join(worktree, 'canary.txt'))).toBe(true)
      // the final assistant message (commentary precedes it), not the first
      const messages = events.filter((e) => e.type === 'message' && e.role === 'assistant')
      const message = messages.at(-1)
      expect(message && message.type === 'message' ? message.text : '').toContain('CANARY-PERM-OK')
      const exit2 = events.at(-1)
      expect(exit2 && exit2.type === 'exit' ? exit2.terminal_reason : '').toBe('completed')
    } finally {
      await client.stop()
    }
  }, 240_000)

  it('cleans the scratch tree', () => {
    rmSync(root, { recursive: true, force: true })
  })
})
