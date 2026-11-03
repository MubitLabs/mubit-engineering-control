import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EngineEvent, PermissionBridge } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
// Test-only cross-package import (no new package dep): the keystore's read() is
// the ONLY sanctioned key access — the canary never touches *.key files itself.
import { SlotKeystore } from '../../slots/src/keystore'
import { OpenCodeAdapter } from '../src/opencode/adapter'

/**
 * R2.2 canary — the real opencode 2.2.5 serve API through the ADAPTER (never a
 * scratch client). Runs ONLY with MEC_REAL_OPENCODE=1 and a provisioned slot:
 *   MEC_REAL_OPENCODE=1 MEC_OPENCODE_SLOT=~/.mec/engines/opencode/glm-2 \
 *     pnpm exec vitest run packages/engines/test/opencode.real.test.ts
 * Two tiny real turns on the GLM Coding Plan: a smoke turn and one permission
 * round trip. Launch recipe (verified 3 Nov 2026): slot-isolated XDG home,
 * OPENCODE_DISABLE_PROJECT_CONFIG=1, a config-file provider whose apiKey is
 * `{env:MEC_OPENCODE_KEY}` — the key is read from the slot keystore at launch
 * and rides the environment, never a file opencode persists — plus
 * OPENCODE_PASSWORD for HTTP Basic (user `opencode`). `serve --port 0 --stdio`
 * prints `{"url":…}` on stdout line 1 and the client fetches that URL.
 * Re-run at every handshake and on every pinned engine version change (plan §7.1).
 */
const REAL = process.env.MEC_REAL_OPENCODE === '1'
const SLOT = process.env.MEC_OPENCODE_SLOT ?? join(process.env.HOME ?? '', '.mec/engines/opencode/glm-2')
const KEY_ENV = 'MEC_OPENCODE_KEY'
const CAPTURE = process.env.MEC_OPENCODE_CAPTURE // optional tee for fixture recording

/** One real `opencode serve --stdio` child, wired into the adapter's injectable deps (argv-only spawn). */
type RealClient = {
  post: (path: string, body?: unknown) => Promise<unknown>
  sse: () => AsyncIterable<string>
  stop: () => Promise<void>
}

async function startServe(): Promise<RealClient> {
  for (const dir of ['data', 'config', 'state', 'cache']) {
    mkdirSync(join(SLOT, dir), { recursive: true, mode: 0o700 })
  }
  // The launch-env/probe wiring seam (plan §5.7): the slot config carries the
  // provider profile with an {env:} key reference — the secret itself never
  // enters any file opencode keeps. Written only when the slot has none yet.
  // §8.4 bridge mode: the build agent's permission block REPLACES its default
  // ruleset (whose leading `{action:'*',resource:'*',effect:'allow'}` would
  // otherwise swallow any appended ask — 2.2.5 finding) and routes bash to ask.
  const configDir = join(SLOT, 'config', 'opencode')
  const configPath = join(configDir, 'opencode.json')
  if (!existsSync(configPath)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 })
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          provider: {
            'zai-coding': {
              npm: '@ai-sdk/openai-compatible',
              options: {
                baseURL: 'https://api.z.ai/api/coding/paas/v4',
                apiKey: `{env:${KEY_ENV}}`,
              },
              models: {
                'glm-4.7': { name: 'GLM 4.7 (Coding Plan)' },
              },
            },
          },
          agent: {
            build: { permission: { bash: 'ask' } },
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )
  }
  const key = new SlotKeystore(SLOT).read('zai-coding-plan')
  if (key === undefined) throw new Error(`no zai-coding-plan key in the ${SLOT} keystore`)

  const password = `mec-${Math.random().toString(36).slice(2)}`
  // `serve --stdio` treats STDIN EOF as shutdown — stdin must stay open (piped,
  // never written) for the server's lifetime; kill() closes it (2.2.5 finding).
  const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0', '--stdio'], {
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: SLOT,
      XDG_DATA_HOME: join(SLOT, 'data'),
      XDG_CONFIG_HOME: join(SLOT, 'config'),
      XDG_STATE_HOME: join(SLOT, 'state'),
      XDG_CACHE_HOME: join(SLOT, 'cache'),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_PASSWORD: password,
      [KEY_ENV]: key,
    },
    cwd: SLOT,
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  child.stdout.setEncoding('utf8')
  const url = await new Promise<string>((resolve) => {
    let buf = ''
    child.stdout.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        try {
          resolve((JSON.parse(buf.slice(0, nl)) as { url: string }).url)
        } catch {
          resolve('')
        }
      }
    })
  })
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  if (url === '') throw new Error('opencode serve printed no {"url"} line')

  const post = async (path: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`${url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`opencode ${path} → ${res.status}: ${text.slice(0, 200)}`)
    // e.g. the permission reply returns an empty body — not JSON
    return text.trim() === '' ? undefined : (JSON.parse(text) as unknown)
  }

  const sse = async function* (): AsyncIterable<string> {
    const res = await fetch(`${url}/api/event`, {
      headers: { authorization: auth, accept: 'text/event-stream' },
    })
    if (res.body === null) throw new Error('no SSE body')
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let sawVerdict = false
    const deadline = Date.now() + 120_000
    const lines: string[] = []
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buf += decoder.decode(value, { stream: true })
        let nl = buf.indexOf('\n')
        while (nl >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (line.trim() !== '') {
            lines.push(line)
            if (line.includes('session.execution.succeeded') || line.includes('session.execution.failed')) {
              sawVerdict = true
            }
          }
          nl = buf.indexOf('\n')
        }
        for (const line of lines.splice(0)) {
          if (CAPTURE !== undefined) {
            try {
              appendFileSync(CAPTURE, `${line}\n`)
            } catch {
              // the tee is best-effort; assertions do not depend on it
            }
          }
          yield line
        }
        // The turn ended: drain the trailing final usage/renamed events, then end
        // the generator so the adapter flushes the held exit (CONTRACTS §1).
        if (sawVerdict) {
          await new Promise((r) => setTimeout(r, 2000))
          return
        }
        if (Date.now() > deadline) return
      }
    } finally {
      reader.cancel().catch(() => {})
    }
  }

  return {
    post,
    sse,
    stop: async () => {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve())
        setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
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
    engine: 'opencode',
    slot_id: 'slot_glm2',
    worktree: over.worktree,
    base_sha: '0'.repeat(40),
    branch: 'mec/canary',
    origin: { messages: [] },
    objective: 'R2.2 canary',
    owned_paths: [],
    acceptance_checks: [],
    budget: { turns: 2, wall_clock_ms: 240_000 },
    bundle_revision: 'r0',
    tools: { url: 'http://127.0.0.1:1', token: 't' },
    env: {},
    isolation: {
      sandbox: 'off',
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

describe.skipIf(!REAL)('R2.2: real opencode serve through the adapter', () => {
  const root = mkdtempSync(join(tmpdir(), 'mec-opencode-canary-'))
  const answers: Array<{ decision: string; operation: unknown }> = []

  it('a real smoke turn: session_started → message OPENCODE-H1-OK → usage → exit completed', async () => {
    const client = await startServe()
    try {
      const adapter = new OpenCodeAdapter({
        post: client.post,
        sse: client.sse,
        defaultModel: { id: 'glm-4.7', providerID: 'zai-coding' },
      })
      const worktree = join(root, 'smoke')
      mkdirSync(worktree, { recursive: true })
      const handle = await adapter.launch({
        brief: brief({
          attempt_id: 'att_oc_smoke',
          worktree,
          read_only: false,
          permission_mode: 'none',
        }) as never,
        env: {},
        cwd: worktree,
        bridge: { request: async () => 'deny' },
      } as never)
      expect(handle.session_id).toMatch(/^ses/)
      await adapter.send(handle, { id: 'inp_1', kind: 'message', text: 'Reply with exactly: OPENCODE-H1-OK' })
      const events: EngineEvent[] = []
      for await (const event of adapter.events(handle)) {
        events.push(event)
        if (event.type === 'exit') break // the flushed exit ends the attempt
      }
      const types = events.map((e) => e.type)
      expect(types[0]).toBe('session_started')
      const message = events.find((e) => e.type === 'message' && e.role === 'assistant')
      expect(message && message.type === 'message' ? message.text : '').toContain('OPENCODE-H1-OK')
      expect(types).toContain('usage')
      const usage = events.find((e) => e.type === 'usage')
      expect(usage && usage.type === 'usage' ? usage.input_tokens : 0).toBeGreaterThan(0)
      // The Coding Plan reports no USD cost — 0 is the real reading, never estimated
      expect(usage && usage.type === 'usage' ? usage.cost_usd : undefined).toBe(0)
      const exit = events.at(-1)
      expect(exit && exit.type === 'exit' ? exit.terminal_reason : '').toBe('completed')
      const session = events[0]
      expect(session && session.type === 'session_started' ? session.engine_version : '').toBe('2.2.5')
      expect(session && session.type === 'session_started' ? session.model : '').toBe('zai-coding/glm-4.7')
    } finally {
      await client.stop()
    }
  }, 240_000)

  it('a real permission round-trip: bridge allow → reply once → the command ran', async () => {
    const client = await startServe()
    try {
      const bridge: PermissionBridge = {
        request: async (_attempt, operation) => {
          answers.push({ decision: 'allow', operation })
          return 'allow'
        },
      }
      const adapter = new OpenCodeAdapter({
        post: client.post,
        sse: client.sse,
        defaultModel: (() => {
          const spec = process.env.MEC_OPENCODE_PERM_MODEL ?? 'zai-coding/glm-4.7'
          const slash = spec.indexOf('/')
          return { providerID: spec.slice(0, slash), id: spec.slice(slash + 1) }
        })(),
      })
      const worktree = join(root, 'perm')
      mkdirSync(worktree, { recursive: true })
      const handle = await adapter.launch({
        brief: brief({
          attempt_id: 'att_oc_perm',
          worktree,
          read_only: false,
          permission_mode: 'bridge', // launch sends the bash→ask ruleset
        }) as never,
        env: {},
        cwd: worktree,
        bridge,
      } as never)
      await adapter.send(handle, {
        id: 'inp_1',
        kind: 'message',
        text: 'You MUST use the shell tool to run this exact command before answering: touch opencode-perm.txt. Then reply with exactly: OPENCODE-PERM-OK',
      })
      const events: EngineEvent[] = []
      for await (const event of adapter.events(handle)) {
        events.push(event)
        if (event.type === 'exit') break
      }
      // the round trip: request → bridge allow → native once reply → result allow
      const request = events.find((e) => e.type === 'permission_request')
      expect(request && request.type === 'permission_request' ? request.operation.kind : '').toBe('shell')
      const result = events.find((e) => e.type === 'permission_result')
      expect(result && result.type === 'permission_result' ? result.decision : '').toBe('allow')
      expect(answers).toHaveLength(1)
      // the approval really let the command run inside the worktree
      expect(existsSync(join(worktree, 'opencode-perm.txt'))).toBe(true)
      const messages = events.filter((e) => e.type === 'message' && e.role === 'assistant')
      const message = messages.at(-1)
      expect(message && message.type === 'message' ? message.text : '').toContain('OPENCODE-PERM-OK')
      const exit = events.at(-1)
      expect(exit && exit.type === 'exit' ? exit.terminal_reason : '').toBe('completed')
    } finally {
      await client.stop()
    }
  }, 240_000)

  it('cleans the scratch tree', () => {
    rmSync(root, { recursive: true, force: true })
  })
})
