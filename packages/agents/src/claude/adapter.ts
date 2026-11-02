import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentProbe } from '@mec/contracts'
import {
  type AgentAdapter,
  type AgentExit,
  type AgentIO,
  type AgentSession,
  type ExecutionMode,
  readJsonLines,
  type StartInput,
} from '../adapter'
import { type Bridge, startBridge } from './bridge'
import { probeClaude } from './probe'
import { classifyFailure, normalise, type TurnResult } from './stream'

export interface ClaudeAdapterOptions {
  binary: string
  /** How Claude starts our `mec` MCP server (node + bundled script). */
  mcpServer: { command: string; args: string[] }
  /** Per-attempt sockets and MCP config files. */
  runtimeDir: string
  model?: string | null
  probeTtlMs?: number
}

const READ_TOOLS = ['Read', 'Grep', 'Glob']
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'TodoWrite']
const MEC_TOOLS = ['mcp__mec__ask_question', 'mcp__mec__report_result', 'mcp__mec__propose_tasks']
const SAFE_BASH = [
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(ls:*)',
]

/**
 * Execution modes (PDF §13) mapped to what Claude Code actually enforces. `--restricted` confines
 * file tools to the working directory and drops command tools unless named; owned paths in the
 * brief remain coordination instructions, not a sandbox.
 */
export function modeArgs(mode: ExecutionMode, allowedCommands: string[][]): string[] {
  const checkBash = allowedCommands.map((argv) => `Bash(${argv.join(' ')}:*)`)
  switch (mode) {
    case 'observe':
      return [
        '--permission-mode',
        'dontAsk',
        '--tools',
        ...READ_TOOLS,
        '--allowedTools',
        ...READ_TOOLS,
        ...MEC_TOOLS,
        '--disallowedTools',
        'Edit',
        'Write',
        'NotebookEdit',
        'Bash',
        'WebFetch',
        'WebSearch',
        'AskUserQuestion',
      ]
    case 'implement':
      return [
        '--permission-mode',
        'acceptEdits',
        '--tools',
        ...READ_TOOLS,
        ...EDIT_TOOLS,
        'Bash',
        '--allowedTools',
        ...READ_TOOLS,
        ...EDIT_TOOLS,
        ...MEC_TOOLS,
        ...SAFE_BASH,
        ...checkBash,
        '--disallowedTools',
        'AskUserQuestion',
        'WebSearch',
      ]
    case 'assisted':
      return [
        '--permission-mode',
        'manual',
        '--tools',
        ...READ_TOOLS,
        ...EDIT_TOOLS,
        'Bash',
        '--allowedTools',
        ...READ_TOOLS,
        ...MEC_TOOLS,
        '--disallowedTools',
        'AskUserQuestion',
        'WebSearch',
      ]
  }
}

export function systemPrompt(mode: ExecutionMode, allowedCommands: string[][]): string {
  return [
    'You are running inside Mubit Engineering Control as one task of a coordinated delivery.',
    'Work only inside the current directory. Do not push, create branches or change git remotes; the platform commits and integrates your work.',
    'When you need a decision from a person, call the mcp__mec__ask_question tool instead of asking in prose, then continue with their answer.',
    'When you are done, call mcp__mec__report_result with a short summary of what changed and anything left open.',
    mode === 'observe'
      ? 'This is a read-only session: analyse and report, do not modify files.'
      : 'Create and change files with the Write and Edit tools, which are pre-approved. Any other shell command, including writing files through the shell (cat <<EOF, sed -i, python), waits for a person to approve it, so use the shell only for the acceptance checks, ls and read-only git commands.',
    allowedCommands.length
      ? `The platform will run these acceptance checks on your final commit: ${allowedCommands.map((a) => a.join(' ')).join('; ')}.`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly kind = 'claude-code' as const
  private cached: { at: number; probe: AgentProbe } | null = null

  constructor(private readonly opts: ClaudeAdapterOptions) {}

  async probe(): Promise<AgentProbe> {
    const ttl = this.opts.probeTtlMs ?? 5 * 60_000
    if (this.cached && Date.now() - this.cached.at < ttl) return this.cached.probe
    const { flags: _flags, ...probe } = await probeClaude(this.opts.binary, {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      DISABLE_AUTOUPDATER: '1',
    })
    this.cached = { at: Date.now(), probe }
    return probe
  }

  start(input: StartInput, io: AgentIO): AgentSession {
    const sessionId = input.resume?.nativeSessionRef ?? randomUUID()
    const allowedCommands = (input.options?.allowedCommands as string[][] | undefined) ?? []
    const tools = (input.options?.mecTools as string[] | undefined) ?? [
      'approve',
      'ask_question',
      'report_result',
    ]
    const runtime = path.join(this.opts.runtimeDir, `${input.attemptId.slice(0, 8)}-g${input.generation}`)
    const socketPath = path.join(runtime, 'bridge.sock')
    const mcpConfigPath = path.join(runtime, 'mcp.json')

    let interrupted = false
    let closing = false
    let inflight = 0
    let lastResult: TurnResult | null = null
    let stderrTail = ''
    let bridge: Bridge | null = null
    let child: ReturnType<AgentIO['spawn']> | null = null

    const writeUser = (text: string) => {
      child?.stdin?.write(
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`,
      )
      inflight++
    }

    const launched = (async () => {
      bridge = await startBridge(socketPath, async (method, params) => {
        if (method === 'approve') {
          const toolName = String(params.tool_name ?? 'unknown')
          const toolInput = (params.input as Record<string, unknown>) ?? {}
          const d = await io.requestDecision({
            kind: 'tool',
            nativeRequestRef: String(params.tool_use_id ?? randomUUID()),
            toolName,
            input: toolInput,
            command:
              toolName === 'Bash' && typeof toolInput.command === 'string' ? toolInput.command : undefined,
          })
          return d.kind === 'approve'
            ? { behavior: 'allow', updatedInput: toolInput }
            : {
                behavior: 'deny',
                message:
                  d.kind === 'reject'
                    ? `A person denied this${d.reason ? `: ${d.reason}` : ''}`
                    : `Not approved (${d.kind === 'closed' ? d.reason : 'no decision'}). Continue without it.`,
              }
        }
        if (method === 'ask_question') {
          const d = await io.requestDecision({
            kind: 'question',
            nativeRequestRef: randomUUID(),
            question: String(params.question ?? ''),
            options: Array.isArray(params.options) ? params.options.map(String) : undefined,
          })
          return d.kind === 'answer'
            ? { answer: d.answer }
            : { answer: null, note: 'No answer was given. Proceed with the safest assumption and state it.' }
        }
        if (method === 'report_result') {
          io.emit('agent.report', params)
          return { recorded: true }
        }
        if (io.callControl) return io.callControl(method, params)
        throw new Error(`unsupported bridge method ${method}`)
      })
      await mkdir(runtime, { recursive: true })
      await writeFile(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            mec: {
              type: 'stdio',
              command: this.opts.mcpServer.command,
              args: this.opts.mcpServer.args,
              env: { MEC_BRIDGE_SOCKET: socketPath, MEC_TOOLS: tools.join(',') },
            },
          },
        }),
        { mode: 0o600 },
      )

      const argv = [
        this.opts.binary,
        '-p',
        '--output-format',
        'stream-json',
        '--input-format',
        'stream-json',
        '--verbose',
        '--replay-user-messages',
        ...(input.resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
        ...(this.opts.model ? ['--model', this.opts.model] : []),
        '--restricted',
        ...modeArgs(input.mode, allowedCommands),
        '--permission-prompt-tool',
        'mcp__mec__approve',
        '--append-system-prompt',
        systemPrompt(input.mode, allowedCommands),
        '--strict-mcp-config',
        '--mcp-config',
        mcpConfigPath,
      ]
      child = io.spawn({
        argv,
        cwd: input.workdir,
        env: { TERM: 'dumb', DISABLE_AUTOUPDATER: '1', ...(input.env ?? {}) },
        stdin: 'pipe',
      })
      readJsonLines(
        child.stdout,
        (msg) => {
          const { events, result } = normalise(msg)
          for (const e of events) io.emit(e.type, e.payload)
          if (result) {
            lastResult = result
            inflight--
            // The attempt ends when the last queued message has been answered.
            if (inflight <= 0 && !closing) {
              closing = true
              child?.stdin?.end()
            }
          }
        },
        (line) => io.emit('agent.log', { stream: 'stdout', line: line.slice(0, 2_000) }),
      )
      readJsonLines(
        child.stderr,
        () => {},
        (line) => {
          stderrTail = `${stderrTail}\n${line}`.slice(-4_000)
          io.emit('agent.log', { stream: 'stderr', line: line.slice(0, 2_000) })
        },
      )
      writeUser(
        input.resume ? 'You were interrupted. Continue the task from where you stopped.' : input.prompt,
      )
      return child
    })()

    const done: Promise<AgentExit> = launched.then(
      async (c) => {
        const exit = await c.exited
        await bridge?.close()
        if (interrupted) return { status: 'interrupted' }
        const r = lastResult as TurnResult | null
        if (r?.ok) return { status: 'finished', summary: r.text.slice(0, 2_000) }
        const failure = classifyFailure(r?.text || stderrTail || `claude exited with code ${exit.code}`)
        if (failure.status === 'quota')
          return { status: 'quota', detail: failure.detail, resetAt: failure.resetAt }
        if (failure.status === 'auth') return { status: 'auth', detail: failure.detail }
        return { status: 'failed', detail: failure.detail }
      },
      async (err: Error) => {
        await bridge?.close()
        return { status: 'failed', detail: `could not start Claude Code: ${err.message}` }
      },
    )

    return {
      ready: Promise.resolve({ nativeSessionRef: sessionId }),
      done,
      async send(message) {
        await launched
        if (closing) throw new Error('the session is finishing; start a new attempt to continue')
        writeUser(message)
        io.emit('agent.message', { role: 'user', text: message })
      },
      async interrupt() {
        interrupted = true
        const c = await launched.catch(() => null)
        await c?.terminate()
      },
    }
  }
}
