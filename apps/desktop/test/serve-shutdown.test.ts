// Walkthrough, 9 November 2026: a SIGTERM must end the server within a bound, so `mec stop` and
// `mec restart` can rely on the pid going. A close that never settles is the case that would not.
import { describe, expect, it } from 'vitest'
import { STOP_BOUND_MS } from '../src/restart'
import { closeWithin, SHUTDOWN_BOUND_MS } from '../src/serve'

describe('the shutdown bound', () => {
  it('a close that never settles is let go at the bound, and says so', async () => {
    const lines: string[] = []
    const started = Date.now()
    await closeWithin(
      () => new Promise<void>(() => {}),
      50,
      (line) => lines.push(line),
    )
    expect(Date.now() - started).toBeLessThan(1000)
    expect(lines).toEqual(['mec server shutdown did not finish within 0.05 s; exiting without it'])
  })

  it('a close that fails is said, and the shutdown still ends', async () => {
    const lines: string[] = []
    await closeWithin(
      async () => Promise.reject(new Error('disk full')),
      50,
      (line) => lines.push(line),
    )
    expect(lines).toEqual(['mec server shutdown error: disk full'])
  })

  it('a close that finishes says nothing more', async () => {
    const lines: string[] = []
    await closeWithin(
      async () => {},
      50,
      (line) => lines.push(line),
    )
    expect(lines).toEqual([])
  })

  it('ends before a stop gives up on it', () => {
    expect(SHUTDOWN_BOUND_MS).toBeLessThan(STOP_BOUND_MS)
  })
})
