import type { Readable, Writable } from 'node:stream'
import type { AgentCapability, AgentKind, AgentProbe } from '@mec/contracts'

/**
 * The common adapter contract, PDF §7. Each installed agent version states what it can do;
 * a uniform UI must not imply every agent can pause, resume, approve or fork the same way.
 *
 *   probe(profile)                -> capabilities and auth health
 *   start(attempt, inputs)        -> native session
 *   send / interrupt / resume     -> per-session controls (capability dependent)
 *   resolveDecision               -> answer a native question or permission request
 */

export interface SpawnSpec {
  argv: string[]
  cwd: string
  env: Record<string, string>
  stdin: 'pipe' | 'ignore'
}

/** A supervised process. The runner owns it by (attemptId, generation), never by PID alone. */
export interface ChildHandle {
  pid: number
  stdin: Writable | null
  stdout: Readable
  stderr: Readable
  exited: Promise<{ code: number | null; signal: string | null }>
  /** SIGTERM the process group, escalate to SIGKILL, resolve once the group is gone. */
  terminate(graceMs?: number): Promise<void>
}

export type DecisionRequest =
  | { kind: 'question'; nativeRequestRef: string; question: string; options?: string[] }
  | {
      kind: 'tool'
      nativeRequestRef: string
      toolName: string
      input: Record<string, unknown>
      command?: string
    }

export type DecisionResult =
  | { kind: 'answer'; answer: string }
  | { kind: 'approve' }
  | { kind: 'reject'; reason?: string }
  /** The request expired or became stale: never consent. */
  | { kind: 'closed'; reason: string }

export interface AgentIO {
  /** Record evidence (agent.message, agent.tool_use, …). Lifecycle events belong to the runner. */
  emit(type: string, payload: Record<string, unknown>): void
  spawn(spec: SpawnSpec): ChildHandle
  /** Ask a person. Resolves with their decision; rejects if unsupported in this context. */
  requestDecision(request: DecisionRequest): Promise<DecisionResult>
  /** A scoped round trip to control (e.g. the coordinator's propose_tasks). */
  callControl?(method: string, params: Record<string, unknown>): Promise<unknown>
}

export type ExecutionMode = 'observe' | 'implement' | 'assisted'

export interface StartInput {
  attemptId: string
  generation: number
  workdir: string
  prompt: string
  mode: ExecutionMode
  /** Native session to continue, when the adapter supports native_resume. */
  resume?: { nativeSessionRef: string } | undefined
  /** Adapter-specific extras (the fake agent's script, MCP config paths, …). */
  options?: Record<string, unknown>
  env?: Record<string, string>
}

export type AgentExit =
  | { status: 'finished'; summary?: string }
  | { status: 'failed'; detail: string }
  | { status: 'interrupted' }
  | { status: 'quota'; detail: string; resetAt?: string | null }
  | { status: 'auth'; detail: string }

export interface AgentSession {
  /** Resolves once the native session id is known. */
  readonly ready: Promise<{ nativeSessionRef: string }>
  readonly done: Promise<AgentExit>
  send(message: string): Promise<void>
  interrupt(): Promise<void>
}

export interface AgentAdapter {
  readonly kind: AgentKind
  probe(): Promise<AgentProbe>
  start(input: StartInput, io: AgentIO): AgentSession
}

export function hasCapability(probe: AgentProbe, c: AgentCapability): boolean {
  return probe.capabilities.includes(c)
}

/** Reads newline-delimited JSON from a stream; malformed lines are reported, not thrown. */
export function readJsonLines(
  stream: Readable,
  onValue: (value: Record<string, unknown>) => void,
  onBadLine?: (line: string) => void,
): void {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    let idx = buffer.indexOf('\n')
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line) {
        try {
          const v = JSON.parse(line)
          if (v && typeof v === 'object' && !Array.isArray(v)) onValue(v as Record<string, unknown>)
          else onBadLine?.(line)
        } catch {
          onBadLine?.(line)
        }
      }
      idx = buffer.indexOf('\n')
    }
  })
}
