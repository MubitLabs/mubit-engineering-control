/**
 * The spawn an engine adapter uses for an attempt (plan §8.1): detached, so the engine leads its
 * own process group, with its stdout piped to the adapter, and registered with the `Supervisor`,
 * so the group is stopped by ownership and confirmed gone. It has the shape of the adapters'
 * `SpawnFn`; `@mec/engines` depends on this package, so the type is structural.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { Supervisor } from './supervisor'
import { SupervisorError } from './supervisor'

export type OwnedSpawn = (
  argv: readonly string[],
  opts: { cwd: string; env: Record<string, string> },
) => {
  pid: number | undefined
  stdout: AsyncIterable<string>
  /** Only with the `stdin` hook: an engine that speaks over stdio, or takes stream input. */
  stdin?: Writable
  exited: Promise<number>
  kill(signal?: string): void
}

export type OwnedSpawnHooks = {
  /** Engine stderr, as it arrives. It is undredacted: the receiver must not store it raw. */
  onStderr?: (chunk: string) => void
  /** How long a group may outlive its leader before it is stopped. */
  reapAfterMs?: number
  /** Keeps stdin as an open pipe. Without it the engine reads an empty stdin. */
  stdin?: boolean
}

/** §8.5: what a finished engine left behind ends with it, or it would hold stdout open. */
const REAP_AFTER_MS = 500

const SIGNAL_NUMBERS: Readonly<Record<string, number>> = { SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }

export function ownedSpawn(
  supervisor: Supervisor,
  owner: { attemptId: string; generation: number },
  hooks: OwnedSpawnHooks = {},
): OwnedSpawn {
  return (argv, opts) => {
    const [cmd, ...args] = argv
    if (cmd === undefined) throw new SupervisorError(`empty argv for attempt ${owner.attemptId}`)
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: [hooks.stdin === true ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    // spawn() reports ENOENT and friends through an async 'error' event; without a pid there is
    // no process to own, and the caller hears it as a throw.
    let startError: Error | undefined
    child.once('error', (error) => {
      startError = error
    })
    const { pid } = child
    if (pid === undefined) {
      throw new SupervisorError(`spawn failed for ${cmd} (attempt ${owner.attemptId})`, {
        cause: startError,
      })
    }
    supervisor.adopt(owner.attemptId, owner.generation, pid)

    // A write after the engine has gone is the caller's to notice, through `exited`.
    child.stdin?.on('error', () => {})
    const stderr = child.stderr as Readable
    stderr.setEncoding('utf8')
    stderr.on('data', (chunk: string) => hooks.onStderr?.(chunk))
    const exited = new Promise<number>((resolve) => {
      child.once('exit', (code, signal) => {
        resolve(code ?? 128 + (SIGNAL_NUMBERS[signal ?? ''] ?? 15))
        const reap = setTimeout(() => {
          if (supervisor.owns(owner.attemptId, owner.generation)) {
            supervisor.stop(owner.attemptId, owner.generation).catch(() => {})
          }
        }, hooks.reapAfterMs ?? REAP_AFTER_MS)
        reap.unref()
      })
    })
    return {
      pid,
      stdout: createInterface({ input: child.stdout as Readable }),
      ...(child.stdin !== null && { stdin: child.stdin as Writable }),
      exited,
      kill: (signal = 'SIGTERM') => {
        try {
          process.kill(-pid, signal as NodeJS.Signals)
        } catch {
          // The group has gone already.
        }
      },
    }
  }
}
