/**
 * Check runner (plan §15, ported from the v1 runner): each check is an argv-only child in
 * its own process group, output is streamed into a capped 8 KiB tail, and a timeout or a
 * cancelled `signal` SIGKILLs the whole group. status keeps a failing check distinct from one that produced
 * no verdict: passed (exit 0) · failed (ran, non-zero) · error (could not start, was
 * signalled, or timed out). exitCode is null only when the process reported none.
 */
import { spawn } from 'node:child_process'

export type CheckSpec = {
  name: string
  cmd: string
  args: readonly string[]
  timeoutMs?: number
  cwd: string
  env?: Record<string, string>
}

export type CheckOutcome = {
  name: string
  status: 'passed' | 'failed' | 'error'
  exitCode: number | null
  durationMs: number
  logTail: string
}

export const LOG_TAIL_BYTES = 8 * 1024
const DEFAULT_TIMEOUT_MS = 600_000

export async function runCheck(
  spec: CheckSpec,
  signal?: AbortSignal,
  onStart?: (pid: number) => void,
): Promise<CheckOutcome> {
  const started = Date.now()
  const child = spawn(spec.cmd, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (child.pid !== undefined) onStart?.(child.pid)

  // Rolling capture: keep the last LOG_TAIL_BYTES of stdout+stderr, interleaved.
  let log = Buffer.alloc(0)
  const collect = (chunk: Buffer): void => {
    log = Buffer.concat([log, chunk]).subarray(-LOG_TAIL_BYTES)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  // Own process group (detached): -pid signals the group, so children the check spawned die
  // with it. ESRCH just means it exited between flag and kill — close settles it.
  const killGroup = (): void => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killGroup()
  }, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  if (signal?.aborted) killGroup()
  else signal?.addEventListener('abort', killGroup, { once: true })

  // spawn() reports failures such as ENOENT through an async 'error' event, not a throw.
  let spawnError: string | null = null
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', (err) => {
      spawnError = err.message
      resolve({ code: null, signal: null })
    })
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(timer)
  signal?.removeEventListener('abort', killGroup)

  const durationMs = Date.now() - started
  const logTail = log.toString('utf8')
  const base = { name: spec.name, durationMs, logTail }

  if (timedOut) return { ...base, status: 'error', exitCode: null }
  if (spawnError !== null) {
    const note = `could not start ${spec.cmd}: ${spawnError}`
    return { ...base, status: 'error', exitCode: null, logTail: `${logTail}${logTail ? '\n' : ''}${note}` }
  }
  if (exit.code === 0) return { ...base, status: 'passed', exitCode: 0 }
  // exit.code null means a signal took it (the timeout case returned above) — no verdict.
  return { ...base, status: exit.code === null ? 'error' : 'failed', exitCode: exit.code }
}

/** Runs checks sequentially, in order, returning their outcomes in the same order. */
export async function runChecks(specs: readonly CheckSpec[]): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = []
  for (const spec of specs) {
    outcomes.push(await runCheck(spec))
  }
  return outcomes
}
