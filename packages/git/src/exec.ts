import { execFile } from 'node:child_process'

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
    readonly code: number | string | null,
  ) {
    super(message)
  }
}

export interface GitOptions {
  cwd: string
  /** Extra environment (credential helpers, author identity). The parent env is not inherited. */
  env?: Record<string, string>
  timeoutMs?: number
}

/**
 * Runs git with an argument array — never a shell string — so refs, URLs and messages are data.
 * The environment is explicit: only PATH/HOME plus what the caller passes, and prompts are off.
 */
export function git(args: string[], opts: GitOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: process.env.HOME ?? '/tmp',
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C',
          ...opts.env,
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { code?: number | string }
          reject(
            new GitError(
              `git ${args[0]} failed: ${String(stderr).trim() || e.message}`,
              args,
              String(stderr),
              e.code ?? null,
            ),
          )
          return
        }
        resolve(String(stdout))
      },
    )
  })
}

/** A ref, branch or SHA that is safe to pass as an argument (cannot be read as an option). */
export function assertSafeRef(ref: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,250}$/.test(ref) ||
    ref.includes('..') ||
    ref.endsWith('.lock') ||
    ref.endsWith('/')
  ) {
    throw new Error(`unsafe git ref: ${JSON.stringify(ref)}`)
  }
  return ref
}

export function assertSha(sha: string): string {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a full commit SHA: ${JSON.stringify(sha)}`)
  return sha
}
