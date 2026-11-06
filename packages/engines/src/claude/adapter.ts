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
import { classifyClaudeError, createClaudeEventParser } from './stream'

/**
 * Wires the pure parts to a real process. The runtime owns the environment, worktree,
 * settings and MCP config files and hands them over in the LaunchSpec; the adapter only
 * builds argv, starts the process inside the caller's process group and normalises its
 * stream. `deps.spawn` is injectable for tests.
 *
 * With `streamInput` the adapter owns stdin as well (§9, §12.4): the objective is the first line,
 * every line carries a uuid the engine reports back on, and stdin closes when the last turn ends.
 */

export type SpawnFn = (
  argv: readonly string[],
  opts: { cwd: string; env: Record<string, string> },
) => {
  pid: number | undefined
  stdout: AsyncIterable<string>
  exited: Promise<number>
  kill(signal?: string): void
  /** The engine's input, for a launch that asks for stream input. */
  stdin?: { write(text: string): void; end(): void }
}

const defaultSpawn: SpawnFn = (argv, opts) => {
  const child: ChildProcess = spawn(argv[0] ?? 'claude', argv.slice(1), {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin?.on('error', () => {})
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
    stdin: {
      write: (text) => {
        child.stdin?.write(text)
      },
      end: () => {
        child.stdin?.end()
      },
    },
    kill: (signal: string = 'SIGTERM') => {
      child.kill(signal as NodeJS.Signals)
    },
  }
}

type Waiter = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }

function waiter(): Waiter {
  let resolve: () => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  // Nobody may be waiting when the engine exits.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/** One message on stdin: taken when the engine said so, finished when its turn ended. */
type Command = {
  uuid: string
  inputId?: string
  taken: Waiter
  finished: Waiter
  replayed: boolean
  done: boolean
}

type Launch = {
  handle: AttemptHandle & { exitCode?: number }
  proc: ReturnType<SpawnFn>
  spec: LaunchSpec
  commands: Map<string, Command>
  sawLifecycle: boolean
  inputOpen: boolean
}

/** How long the engine has to say it took an input before the delivery counts as failed. */
const INPUT_TIMEOUT_MS = 10_000

type Content = string | { type: 'text'; text: string }[]

/**
 * A follow-up's words stay exactly the person's. The ids go in a block of their own, because the
 * engine has no other way to know them, and `handled_inputs` and `handback` need them (§12.3, §12.4).
 */
function contentOf(input: Input): Content {
  if (input.message_id === undefined) return input.text
  const reference =
    `MEC follow-up: input id ${input.id}, message id ${input.message_id}. ` +
    `Once you have handled it, list ${input.id} in handled_inputs on mcp__mec__report. ` +
    `If it is beyond your task, call mcp__mec__handback once with message_id ${input.message_id} ` +
    'and a one-sentence reason.'
  return [
    { type: 'text', text: input.text },
    { type: 'text', text: reference },
  ]
}

export type ClaudeAdapterDeps = {
  spawnFn?: SpawnFn
  /**
   * The absolute path of the engine. The attempt's PATH starts with its shim directory, which
   * holds a `claude` that fails by name (§8.3), so a bare name would start the shim.
   */
  binary?: string
  /**
   * §9: the objective goes on stdin, `send` works, and stdin closes when nothing is left, which
   * is what ends the process. A planner turn is one-shot and leaves this off.
   */
  streamInput?: boolean
  inputTimeoutMs?: number
}

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
    const streamInput = this.deps.streamInput === true
    const argv = buildClaudeArgv({
      ...(streamInput ? { streamInput } : { prompt: spec.brief.objective }),
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
    if (this.deps.binary !== undefined) argv[0] = this.deps.binary
    const proc = spawnFn(argv, { cwd: spec.cwd, env: spec.env })
    const handle: AttemptHandle = {
      attempt_id: spec.brief.attempt_id,
      generation: spec.brief.generation,
      pid: proc.pid,
      session_id: sessionId,
    }
    const launch: Launch = {
      handle,
      proc,
      spec,
      commands: new Map(),
      sawLifecycle: false,
      inputOpen: streamInput && proc.stdin !== undefined,
    }
    this.spawns.set(spec.brief.attempt_id, launch)
    if (launch.inputOpen) this.#write(launch, spec.brief.objective)
    // A one-shot prompt rides argv. With stdin left open the engine waits 3 s for input it never gets.
    else proc.stdin?.end()
    return handle
  }

  /**
   * §12.4: resolves when the engine said it took the input, not when the write returned. On
   * 2.1.318 `command_lifecycle` says so at once, even for a message that waits for the next turn;
   * a version with only `--replay-user-messages` says so when that turn starts.
   */
  async send(handle: AttemptHandle, input: Input): Promise<void> {
    const launch = this.spawns.get(handle.attempt_id)
    if (!launch) throw new Error(`claude adapter: unknown attempt ${handle.attempt_id}`)
    if (this.deps.streamInput !== true) throw new Error('claude adapter: this launch has no stream input')
    if (!launch.inputOpen) throw new Error('claude adapter: the engine input is closed: its last turn ended')
    const command = this.#write(launch, contentOf(input), input.id)
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`claude adapter: the engine did not take input ${input.id}`)),
        this.deps.inputTimeoutMs ?? INPUT_TIMEOUT_MS,
      )
    })
    try {
      await Promise.race([command.taken.promise, late])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Resolves when the turn that carried this input ended: the evidence for `read` (§12.4). */
  async inputFinished(handle: AttemptHandle, inputId: string): Promise<void> {
    const commands = this.spawns.get(handle.attempt_id)?.commands
    const command = [...(commands?.values() ?? [])].find((entry) => entry.inputId === inputId)
    await command?.finished.promise
  }

  #write(launch: Launch, content: Content, inputId?: string): Command {
    const uuid = randomUUID()
    const command: Command = {
      uuid,
      ...(inputId !== undefined && { inputId }),
      taken: waiter(),
      finished: waiter(),
      replayed: false,
      done: false,
    }
    launch.commands.set(uuid, command)
    const message = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: launch.handle.session_id,
      uuid,
    }
    launch.proc.stdin?.write(`${JSON.stringify(message)}\n`)
    return command
  }

  /** Reads what the engine says about stdin; the stream parser never sees any of this. */
  #observe(launch: Launch, line: string): void {
    if (!launch.inputOpen || !/"command_lifecycle"|"isReplay"|"result"/.test(line)) return
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (parsed.type === 'command_lifecycle') {
      launch.sawLifecycle = true
      const command = launch.commands.get(String(parsed.command_uuid))
      if (parsed.state === 'completed') this.#finish(launch, command)
      else command?.taken.resolve()
    } else if (parsed.type === 'user' && parsed.isReplay === true) {
      const command = launch.commands.get(String(parsed.uuid))
      command?.taken.resolve()
      if (command !== undefined) command.replayed = true
    } else if (parsed.type === 'result') {
      if (!launch.sawLifecycle) {
        for (const command of launch.commands.values()) {
          if (command.replayed && !command.done) this.#finish(launch, command)
        }
      }
      // A turn that ended badly leaves nothing to wait for: the engine cannot go on.
      if (parsed.terminal_reason !== 'completed') this.#closeInput(launch)
    }
  }

  #finish(launch: Launch, command: Command | undefined): void {
    if (command === undefined) return
    command.finished.resolve()
    command.done = true
    if ([...launch.commands.values()].every((entry) => entry.done)) this.#closeInput(launch)
  }

  /** EOF is what ends a stream-input process, so the last finished turn closes it. */
  #closeInput(launch: Launch): void {
    if (!launch.inputOpen) return
    launch.inputOpen = false
    launch.proc.stdin?.end()
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
    const parser = createClaudeEventParser()
    let seq = 1
    const stamped = (body: EngineEventBody): EngineEvent => ({
      ...body,
      seq: seq++,
      at: new Date().toISOString(),
      attempt_id: handle.attempt_id,
      generation: handle.generation,
    })
    for await (const line of launch.proc.stdout) {
      this.#observe(launch, line)
      for (const body of parser.push(line)) yield stamped(body)
    }
    // The exit event carries the real exit code, so it is the one thing that waits for the end.
    const code = await launch.proc.exited
    launch.inputOpen = false
    const gone = new Error('claude adapter: the engine exited')
    for (const command of launch.commands.values()) {
      command.taken.reject(gone)
      command.finished.reject(gone)
    }
    for (const body of parser.finish(code)) yield stamped(body)
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
