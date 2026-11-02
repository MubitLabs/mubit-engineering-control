import { spawn } from 'node:child_process'
import type { ChildHandle, SpawnSpec } from '@mec/agents'

export interface Owner {
  attemptId: string
  generation: number
}

interface Tracked {
  owner: Owner
  handle: ChildHandle
}

/**
 * Starts processes from argument arrays (never a shell string), each in its own process group,
 * and records ownership by (attemptId, generation) rather than PID alone (PDF §6). Stopping
 * signals the whole group and confirms it is gone before capacity is released.
 */
export class Supervisor {
  private readonly children = new Set<Tracked>()

  spawn(owner: Owner, spec: SpawnSpec): ChildHandle {
    const [command, ...args] = spec.argv
    if (!command) throw new Error('empty argv')
    const child = spawn(command, args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      shell: false,
      stdio: [spec.stdin, 'pipe', 'pipe'],
    })
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
      child.once('error', () => resolve({ code: null, signal: null }))
    })
    const pid = child.pid ?? -1
    const handle: ChildHandle = {
      pid,
      stdin: child.stdin,
      stdout: child.stdout!,
      stderr: child.stderr!,
      exited,
      terminate: (graceMs = 5_000) => terminateGroup(pid, exited, graceMs),
    }
    const tracked = { owner, handle }
    this.children.add(tracked)
    void exited.then(() => this.children.delete(tracked))
    return handle
  }

  /** True while any process owned by this attempt generation is running. */
  isLive(owner: Owner): boolean {
    for (const c of this.children) {
      if (c.owner.attemptId === owner.attemptId && c.owner.generation === owner.generation) return true
    }
    return false
  }

  async terminateAttempt(attemptId: string): Promise<void> {
    await Promise.all(
      [...this.children].filter((c) => c.owner.attemptId === attemptId).map((c) => c.handle.terminate()),
    )
  }

  async terminateAll(): Promise<void> {
    await Promise.all([...this.children].map((c) => c.handle.terminate()))
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

async function terminateGroup(pid: number, exited: Promise<unknown>, graceMs: number): Promise<void> {
  if (pid <= 0) return
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig)
    } catch {
      // Already gone.
    }
  }
  signal('SIGTERM')
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), graceMs)),
  ])
  if (timedOut || groupAlive(pid)) signal('SIGKILL')
  await exited
  // Children of the leader may outlive it briefly; wait until the whole group is gone.
  for (let i = 0; i < 50 && groupAlive(pid); i++) {
    signal('SIGKILL')
    await new Promise((r) => setTimeout(r, 20))
  }
}
