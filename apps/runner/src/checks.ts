import type { Owner, Supervisor } from './supervisor'

export interface CheckCommand {
  name: string
  argv: string[]
  timeoutSec: number
}

export interface CheckOutcome {
  name: string
  /** passed: exit 0 · failed: the check ran and reported failure · error: it could not run. */
  status: 'passed' | 'failed' | 'error'
  exitCode: number | null
  durationMs: number
  log: string
  detail: string | null
}

const MAX_LOG_BYTES = 2 * 1024 * 1024

/**
 * Runs one validation command (PDF §15) as an argv process in its own group, captures its output
 * directly, and distinguishes a failing check from one that could not start or timed out.
 */
export async function runCheck(
  supervisor: Supervisor,
  owner: Owner,
  cmd: CheckCommand,
  cwd: string,
  env: Record<string, string>,
): Promise<CheckOutcome> {
  const started = Date.now()
  let child: ReturnType<Supervisor['spawn']>
  try {
    child = supervisor.spawn(owner, { argv: cmd.argv, cwd, env, stdin: 'ignore' })
  } catch (e) {
    return {
      name: cmd.name,
      status: 'error',
      exitCode: null,
      durationMs: 0,
      log: '',
      detail: `could not start: ${(e as Error).message}`,
    }
  }
  let log = ''
  let spawnError: string | null = null
  const collect = (d: Buffer | string) => {
    log += d.toString()
    if (log.length > MAX_LOG_BYTES) log = log.slice(-MAX_LOG_BYTES)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.stdout.on('error', (e) => {
    spawnError = e.message
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    void child.terminate(2_000)
  }, cmd.timeoutSec * 1000)
  const exit = await child.exited
  clearTimeout(timer)
  const durationMs = Date.now() - started

  if (timedOut) {
    return {
      name: cmd.name,
      status: 'error',
      exitCode: exit.code,
      durationMs,
      log,
      detail: `timed out after ${cmd.timeoutSec}s`,
    }
  }
  if (exit.code === null && exit.signal === null) {
    return {
      name: cmd.name,
      status: 'error',
      exitCode: null,
      durationMs,
      log,
      detail: `could not start ${cmd.argv[0]}${spawnError ? `: ${spawnError}` : ''}`,
    }
  }
  if (exit.code === 0) return { name: cmd.name, status: 'passed', exitCode: 0, durationMs, log, detail: null }
  return {
    name: cmd.name,
    status: 'failed',
    exitCode: exit.code,
    durationMs,
    log,
    detail: exit.signal ? `terminated by ${exit.signal}` : `exited with ${exit.code}`,
  }
}

export function tail(text: string, lines = 60): string {
  return text.split('\n').slice(-lines).join('\n').slice(-8000)
}
