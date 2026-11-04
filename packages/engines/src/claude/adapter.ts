import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import type {
  AttemptHandle,
  AttemptRef,
  AuthHealth,
  Capabilities,
  EngineAdapter,
  EngineEvent,
  EngineEventBody,
  ErrorClass,
  Input,
  LaunchSpec,
  Report,
} from '@mec/contracts'
import { buildClaudeArgv } from './argv'
import { classifyClaudeError, parseClaudeStream } from './stream'

/**
 * Wires the pure parts to a real process. The runtime owns the environment, worktree,
 * settings and MCP config files and hands them over in the LaunchSpec; the adapter only
 * builds argv, starts the process inside the caller's process group and normalises its
 * stream. `deps.spawn` is injectable for tests.
 */

export type SpawnFn = (
  argv: readonly string[],
  opts: { cwd: string; env: Record<string, string> },
) => {
  pid: number | undefined
  stdout: AsyncIterable<string>
  exited: Promise<number>
  kill(signal?: string): void
}

const defaultSpawn: SpawnFn = (argv, opts) => {
  const child: ChildProcess = spawn(argv[0] ?? 'claude', argv.slice(1), {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim()
    if (line !== '') console.error(`[engine:stderr] ${line}`)
  })
  const emptyLineStream = (async function* () {})()
  const exited = new Promise<number>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve(code ?? (signal ? 128 + 15 : 0))
    })
  })
  return {
    pid: child.pid,
    stdout: child.stdout ? createInterface({ input: child.stdout }) : emptyLineStream,
    exited,
    kill: (signal: string = 'SIGTERM') => {
      child.kill(signal as NodeJS.Signals)
    },
  }
}

type Launch = {
  handle: AttemptHandle & { exitCode?: number }
  proc: ReturnType<SpawnFn>
  spec: LaunchSpec
  inputs: Input[]
}

export type ClaudeAdapterDeps = { spawnFn?: SpawnFn }

export class ClaudeAdapter implements EngineAdapter {
  private readonly spawns: Map<string, Launch> = new Map()
  private readonly exiting = new Map<string, number>()

  constructor(private readonly deps: ClaudeAdapterDeps = {}) {}

  async probe(): Promise<{ capabilities: Capabilities; auth: AuthHealth }> {
    const { probeClaude } = await import('./probe')
    const { execFile } = await import('node:child_process')
    const run = (cmd: string, args: readonly string[], env?: Record<string, string>) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        execFile(
          cmd,
          args,
          { env: env ? { ...process.env, ...env } : process.env },
          (error, stdout, stderr) => {
            resolve({
              code: error
                ? ((error as NodeJS.ErrnoException & { code?: number }).code ??
                  (typeof (error as { code?: number }).code === 'number'
                    ? (error as { code: number }).code
                    : 1))
                : 0,
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? ''),
            })
          },
        )
      })
    return probeClaude(run)
  }

  async launch(spec: LaunchSpec): Promise<AttemptHandle> {
    const spawnFn = this.deps.spawnFn ?? defaultSpawn
    // Claude's --session-id must be a UUID; mint one per launch (resume keeps its own).
    const sessionId = spec.resume?.session_id ?? randomUUID()
    const argv = buildClaudeArgv({
      prompt: spec.brief.objective,
      sessionId,
      settingsPath: (spec.brief.env.MEC_SETTINGS_PATH as string | undefined) ?? '/dev/null',
      mcpConfigPath: (spec.brief.env.MEC_MCP_CONFIG_PATH as string | undefined) ?? '/dev/null',
      readOnly: spec.brief.isolation.read_only,
      permissionMode: spec.brief.isolation.permission_mode,
      maxTurns: spec.brief.budget.turns,
      // LaunchSpec.model (additive v0.1): the runtime's resolveModel output — id + effort.
      model: spec.model?.id,
      effort: spec.model?.effort,
      // The runtime's subagent writer (review §4) hands its file over through the brief env.
      agentsPath: spec.brief.env.MEC_AGENTS_PATH as string | undefined,
      resumeSessionId: spec.resume?.session_id,
      allowedTools: (spec.brief.env.MEC_ALLOWED_TOOLS as string | undefined)?.split(',').filter(Boolean),
      disallowedTools: (spec.brief.env.MEC_DISALLOWED_TOOLS as string | undefined)
        ?.split(',')
        .filter(Boolean),
    })
    const proc = spawnFn(argv, { cwd: spec.cwd, env: spec.env })
    const handle: AttemptHandle = {
      attempt_id: spec.brief.attempt_id,
      generation: spec.brief.generation,
      pid: proc.pid,
      session_id: sessionId,
    }
    this.spawns.set(spec.brief.attempt_id, { handle, proc, spec, inputs: [] })
    return handle
  }

  async send(handle: AttemptHandle, input: Input): Promise<void> {
    const launch = this.spawns.get(handle.attempt_id)
    if (!launch) throw new Error(`claude adapter: unknown attempt ${handle.attempt_id}`)
    launch.inputs.push(input)
  }

  async interrupt(handle: AttemptHandle): Promise<void> {
    this.spawns.get(handle.attempt_id)?.proc.kill('SIGINT')
  }

  async stop(handle: AttemptHandle): Promise<void> {
    this.spawns.get(handle.attempt_id)?.proc.kill('SIGTERM')
  }

  async *events(handle: AttemptHandle): AsyncIterable<EngineEvent> {
    const launch = this.spawns.get(handle.attempt_id)
    if (!launch) throw new Error(`claude adapter: unknown attempt ${handle.attempt_id}`)
    const raw: string[] = []
    for await (const line of launch.proc.stdout) {
      raw.push(line)
    }
    const exitCode = await launch.proc.exited
    const bodies: EngineEventBody[] = parseClaudeStream(raw, { exitCode })
    let seq = 1
    for (const body of bodies) {
      yield {
        ...body,
        seq: seq++,
        at: new Date().toISOString(),
        attempt_id: handle.attempt_id,
        generation: handle.generation,
      }
    }
  }

  classify(error: unknown): ErrorClass {
    return classifyClaudeError(error instanceof Error ? error.message : String(error))
  }

  mapReport(final: unknown): Report {
    const value = (final ?? {}) as Record<string, unknown>
    const text = typeof value.result === 'string' ? value.result : ''
    const isError = value.is_error === true
    return {
      kind: isError ? 'failed' : 'ready',
      summary: text.slice(0, 2000) || (isError ? 'engine reported an error result' : 'engine completed'),
    }
  }
}
