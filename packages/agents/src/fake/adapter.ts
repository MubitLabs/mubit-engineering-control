import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { type AgentProbe, type FakeStep, FakeStep as FakeStepSchema } from '@mec/contracts'
import { z } from 'zod'
import {
  type AgentAdapter,
  type AgentExit,
  type AgentIO,
  type AgentSession,
  readJsonLines,
  type StartInput,
} from '../adapter'
import { FAKE_AGENT_SOURCE } from './agent-source'

export const DEFAULT_FAKE_SCRIPT: FakeStep[] = [
  { say: 'Reading the task brief.' },
  { sleepMs: 500 },
  { tool: 'Read', input: { path: 'README.md' } },
  { say: 'Writing the change.' },
  { write: { path: 'FAKE_AGENT_OUTPUT.md', content: 'Written by the fake agent.\n' } },
  { sleepMs: 500 },
  { say: 'Done.' },
]

/** Writes the fake agent program once per content hash and returns its path. */
function ensureProgram(binDir: string): string {
  const hash = createHash('sha256').update(FAKE_AGENT_SOURCE).digest('hex').slice(0, 12)
  const file = path.join(binDir, `fake-agent-${hash}.mjs`)
  if (!existsSync(file)) {
    mkdirSync(binDir, { recursive: true })
    writeFileSync(file, FAKE_AGENT_SOURCE, { mode: 0o755 })
  }
  return file
}

export interface FakeAdapterOptions {
  /** Where the agent program is written. */
  binDir: string
  /** Where per-attempt scripts and checkpoints live (outside the git worktree). */
  stateDir: string
}

/** A deterministic agent for tests and demos; capability flags mirror what it really supports. */
export class FakeAdapter implements AgentAdapter {
  readonly kind = 'fake' as const

  constructor(private readonly opts: FakeAdapterOptions) {}

  async probe(): Promise<AgentProbe> {
    return {
      kind: 'fake',
      version: '1.0.0',
      available: true,
      auth: 'ok',
      capabilities: ['structured_stream', 'questions', 'tool_approval', 'interrupt', 'native_resume'],
      notes: ['scripted agent for tests and demos'],
    }
  }

  start(input: StartInput, io: AgentIO): AgentSession {
    const program = ensureProgram(this.opts.binDir)
    const dir = path.join(this.opts.stateDir, input.attemptId)
    mkdirSync(dir, { recursive: true })
    const scriptFile = path.join(dir, 'script.json')
    const stateFile = path.join(dir, 'checkpoint.json')
    const parsed = z.array(FakeStepSchema).safeParse(input.options?.script)
    if (!input.resume || !existsSync(scriptFile)) {
      writeFileSync(scriptFile, JSON.stringify(parsed.success ? parsed.data : DEFAULT_FAKE_SCRIPT))
    }

    const argv = [
      process.execPath,
      program,
      '--workdir',
      input.workdir,
      '--script',
      scriptFile,
      '--state',
      stateFile,
    ]
    if (input.resume) argv.push('--resume', input.resume.nativeSessionRef)
    const child = io.spawn({
      argv,
      cwd: input.workdir,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...(input.env ?? {}) },
      stdin: 'pipe',
    })

    let interrupted = false
    let result: Record<string, unknown> | null = null
    let resolveReady!: (v: { nativeSessionRef: string }) => void
    const ready = new Promise<{ nativeSessionRef: string }>((r) => {
      resolveReady = r
    })
    const reply = (msg: Record<string, unknown>) => child.stdin?.write(`${JSON.stringify(msg)}\n`)

    readJsonLines(
      child.stdout,
      (m) => {
        switch (m.type) {
          case 'session':
            resolveReady({ nativeSessionRef: String(m.id) })
            break
          case 'message':
            io.emit('agent.message', { role: 'assistant', text: m.text })
            break
          case 'tool_use':
            io.emit('agent.tool_use', { name: m.name, input: m.input })
            break
          case 'tool_result':
            io.emit('agent.tool_result', { name: m.name, ok: m.ok })
            break
          case 'question':
            io.requestDecision({
              kind: 'question',
              nativeRequestRef: String(m.id),
              question: String(m.question),
              options: Array.isArray(m.options) ? m.options.map(String) : undefined,
            }).then(
              (d) =>
                reply(
                  d.kind === 'answer' ? { id: m.id, answer: d.answer } : { id: m.id, decision: 'reject' },
                ),
              () => reply({ id: m.id, decision: 'reject', reason: 'questions unsupported here' }),
            )
            break
          case 'approval':
            io.requestDecision({
              kind: 'tool',
              nativeRequestRef: String(m.id),
              toolName: String(m.tool),
              input: { command: m.command },
              command: String(m.command),
            }).then(
              (d) =>
                reply({
                  id: m.id,
                  decision: d.kind === 'approve' ? 'approve' : 'reject',
                  reason: d.kind === 'reject' ? d.reason : d.kind === 'closed' ? d.reason : undefined,
                }),
              () => reply({ id: m.id, decision: 'reject', reason: 'approvals unsupported here' }),
            )
            break
          case 'result':
            result = m
            break
        }
      },
      (line) => io.emit('agent.log', { stream: 'stdout', line: line.slice(0, 2000) }),
    )
    readJsonLines(
      child.stderr,
      () => {},
      (line) => io.emit('agent.log', { stream: 'stderr', line: line.slice(0, 2000) }),
    )

    const done: Promise<AgentExit> = child.exited.then(() => {
      if (interrupted) return { status: 'interrupted' }
      const r = result as { status?: string; detail?: string; summary?: string } | null
      if (r?.status === 'success') return { status: 'finished', summary: r.summary }
      if (r?.status === 'quota') return { status: 'quota', detail: String(r.detail) }
      if (r?.status === 'auth') return { status: 'auth', detail: String(r.detail) }
      return { status: 'failed', detail: r?.detail ?? 'agent exited without a result' }
    })
    // A process that dies before announcing a session still settles `ready`.
    void done.then(() => resolveReady({ nativeSessionRef: readSession(stateFile) ?? 'unknown' }))

    return {
      ready,
      done,
      async send(message) {
        io.emit('agent.message', { role: 'user', text: message })
      },
      async interrupt() {
        interrupted = true
        await child.terminate()
      },
    }
  }
}

function readSession(stateFile: string): string | null {
  try {
    return (JSON.parse(readFileSync(stateFile, 'utf8')) as { session?: string }).session ?? null
  } catch {
    return null
  }
}
