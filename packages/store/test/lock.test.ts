import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DirLock } from '../src/lock'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mec-lock-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const lockPath = (d: string): string => join(d, '.mec.lock')

describe('directory lock', () => {
  it('acquires, records the pid and creates the directory when missing', () => {
    const nested = join(dir, 'state')
    const lock = DirLock.acquire(nested)
    expect(existsSync(lockPath(nested))).toBe(true)
    expect(readFileSync(lockPath(nested), 'utf8').trim()).toBe(String(process.pid))
    expect(lock.ownerPid()).toBe(process.pid)
    lock.release()
  })

  it('a second acquire on a held directory is refused', () => {
    const lock = DirLock.acquire(dir)
    // The holder is this very process, so its pid is alive and the lock is not stale.
    expect(() => DirLock.acquire(dir)).toThrow(`mec: another process owns ${dir}`)
    lock.release()
  })

  it('release frees the directory and is idempotent', () => {
    const lock = DirLock.acquire(dir)
    lock.release()
    lock.release() // A second release is a no-op, not an error.
    expect(() => DirLock.acquire(dir)).not.toThrow()
  })

  it('a lockfile naming a dead pid is stale: removed and acquired in one retry', () => {
    writeFileSync(lockPath(dir), '999999999\n') // No such pid; provably dead.
    const lock = DirLock.acquire(dir)
    expect(readFileSync(lockPath(dir), 'utf8').trim()).toBe(String(process.pid))
    lock.release()
  })

  it('a lockfile naming a live pid is not stale', () => {
    writeFileSync(lockPath(dir), `${process.pid}\n`) // We are alive.
    expect(() => DirLock.acquire(dir)).toThrow(`mec: another process owns ${dir}`)
  })

  it('a lockfile with unreadable content cannot be proven stale, so it is treated as held', () => {
    writeFileSync(lockPath(dir), 'not-a-pid\n')
    expect(() => DirLock.acquire(dir)).toThrow(`mec: another process owns ${dir}`)
  })
})
