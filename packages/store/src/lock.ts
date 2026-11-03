/**
 * The directory lock (plan §17): one writer per state directory, held through an O_EXCL
 * lockfile that records the owner's pid.
 *
 * - Acquiring creates the directory if needed and opens `<dir>/.mec.lock` with O_EXCL.
 * - A lockfile held by a live pid (including this process) means another owner: refuse with
 *   `mec: another process owns <dir>`.
 * - A lockfile whose pid is provably dead is stale — remove it and retry the create once.
 *   A lockfile with unreadable content cannot be proven stale, so it is treated as held.
 * - `release` removes the lockfile and is idempotent.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const LOCK_FILENAME = '.mec.lock'

export class DirLock {
  private released = false

  private constructor(
    private readonly path: string,
    private readonly pid: number,
  ) {}

  static acquire(dir: string): DirLock {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, LOCK_FILENAME)
    let fd = tryCreate(path)
    if (fd === undefined) {
      if (!isStale(path)) throw new Error(`mec: another process owns ${dir}`)
      try {
        unlinkSync(path)
      } catch (error) {
        if (!isENOENT(error)) throw error // The stale owner released between read and unlink.
      }
      fd = tryCreate(path)
      if (fd === undefined) throw new Error(`mec: another process owns ${dir}`) // Lost the retry race.
    }
    const pid = process.pid
    writeAll(fd, `${pid}\n`)
    closeSync(fd)
    return new DirLock(path, pid)
  }

  release(): void {
    if (this.released) return
    this.released = true
    try {
      unlinkSync(this.path)
    } catch (error) {
      if (!isENOENT(error)) throw error
    }
  }

  /** The pid recorded in the lockfile we own; for diagnostics. */
  ownerPid(): number {
    return this.pid
  }
}

function tryCreate(path: string): number | undefined {
  try {
    return openSync(path, 'wx') // O_EXCL: fails with EEXIST when someone already holds it.
  } catch (error) {
    if (isEEXIST(error)) return undefined
    throw error
  }
}

/** True when the lockfile is gone (released meanwhile) or its pid is provably dead. */
function isStale(path: string): boolean {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (isENOENT(error)) return true // The owner released between the failed create and this read.
    throw error
  }
  const pid = Number.parseInt(text.trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0 || !/^\d+$/.test(text.trim())) return false
  return !isProcessAlive(pid)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0) // Signal 0 probes existence without touching the process.
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user; ESRCH means it is dead.
    return isEPERM(error)
  }
}

function writeAll(fd: number, text: string): void {
  const buffer = Buffer.from(text, 'utf8')
  let written = 0
  while (written < buffer.length) {
    written += writeSync(fd, buffer, written, buffer.length - written)
  }
}

function isEEXIST(error: unknown): boolean {
  return hasCode(error, 'EEXIST')
}

function isENOENT(error: unknown): boolean {
  return hasCode(error, 'ENOENT')
}

function isEPERM(error: unknown): boolean {
  return hasCode(error, 'EPERM')
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
