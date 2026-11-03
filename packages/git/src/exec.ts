/**
 * git argv runner (plan §14): every invocation is an argument array — never a shell
 * string — so URLs, refs, SHAs and messages are data, not syntax. The environment is
 * explicit (PATH/HOME plus what the caller passes) with prompts off and a fixed locale,
 * output is captured as UTF-8 into capped buffers, and a run that outlives the timeout is
 * SIGKILLed and reported with code -1.
 */
import { spawn } from 'node:child_process'

export type GitOptions = {
  cwd?: string
  /** Extra environment (credential helpers, identity), merged over the minimal base env. */
  env?: Record<string, string>
  /** Resolve with the result instead of throwing when git exits non-zero or dies. */
  allowFailure?: boolean
}

export type GitResult = { code: number; stdout: string; stderr: string }

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly result: GitResult,
  ) {
    super(message)
  }
}

const TIMEOUT_MS = 60_000
const MAX_CAPTURE_CHARS = 8 * 1024 * 1024

function capped(accumulated: string, chunk: string): string {
  const next = accumulated + chunk
  // Keep the tail: it carries the actual error, however noisy the run was.
  return next.length > MAX_CAPTURE_CHARS ? next.slice(-MAX_CAPTURE_CHARS) : next
}

export async function git(args: readonly string[], opts: GitOptions = {}): Promise<GitResult> {
  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '/tmp',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout = capped(stdout, chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = capped(stderr, chunk)
    })

    const finish = (result: GitResult, note?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const final: GitResult =
        note === undefined
          ? result
          : { ...result, stderr: `${result.stderr}${result.stderr ? '\n' : ''}${note}` }
      if (final.code !== 0 && opts.allowFailure !== true) {
        reject(
          new GitError(
            timedOut
              ? `git ${args[0] ?? ''} timed out after ${TIMEOUT_MS} ms`
              : `git ${args[0] ?? ''} failed (exit ${final.code}): ${final.stderr.trim()}`,
            args,
            final,
          ),
        )
        return
      }
      resolve(final)
    }

    // spawn() reports failures such as ENOENT through an async 'error' event, not a throw.
    child.on('error', (err) => {
      finish({ code: -1, stdout, stderr }, `git: ${err.message}`)
    })
    child.on('close', (code) => {
      // close() reports null for a signal death or our timeout kill — both become -1.
      finish({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** git(), returning stdout as trimmed non-empty lines (the shape most callers want). */
export async function gitLines(args: readonly string[], opts: GitOptions = {}): Promise<string[]> {
  const { stdout } = await git(args, opts)
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}
