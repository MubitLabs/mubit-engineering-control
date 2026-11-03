import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../src/mec'
import { readStopMarker, writeStopMarker } from '../src/stop-marker'

const normalBoardText = readFileSync(
  fileURLToPath(new URL('./fixtures/fake-health-board/normal.json', import.meta.url)),
  'utf8',
)

const tempDirs: string[] = []

/** A CliIo double: records stdout lines and startServer calls, markerDir is a fresh tmpdir. */
function makeIo(overrides: { readSnapshotText?: () => string; initialized?: boolean } = {}) {
  const lines: string[] = []
  let starts = 0
  const markerDir = mkdtempSync(join(tmpdir(), 'mec-cli-'))
  tempDirs.push(markerDir)
  const io = {
    readSnapshotText: overrides.readSnapshotText ?? (() => normalBoardText),
    initialized: () => overrides.initialized ?? true,
    markerDir,
    stdout: (line: string) => {
      lines.push(line)
    },
    startServer: async () => {
      starts += 1
    },
  }
  return { io, lines, markerDir, starts: () => starts }
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('runCli', () => {
  it('status prints the board lines and returns the mapped exit code', async () => {
    const { io, lines } = makeIo()
    const code = await runCli(['status'], io)
    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('running normally')
  })

  it('status maps a missing board after initialization to exit code 1', async () => {
    const { io } = makeIo({ readSnapshotText: () => '', initialized: true })
    const code = await runCli(['status'], io)
    expect(code).toBe(1)
  })

  it('stop writes an intentional-stop marker into markerDir and returns 0', async () => {
    const { io, markerDir } = makeIo()
    const code = await runCli(['stop'], io)
    expect(code).toBe(0)
    expect(readStopMarker(markerDir).present).toBe(true)
  })

  it('restart clears the marker and starts the server', async () => {
    const { io, markerDir, starts } = makeIo()
    writeStopMarker(markerDir, 'user pressed stop')
    await runCli(['restart'], io)
    expect(starts()).toBe(1)
    expect(readStopMarker(markerDir).present).toBe(false)
  })

  it('restart --respect-stop honours a present marker without starting the server', async () => {
    const { io, markerDir, lines, starts } = makeIo()
    writeStopMarker(markerDir, 'user pressed stop')
    const code = await runCli(['restart', '--respect-stop'], io)
    expect(code).toBe(0)
    expect(starts()).toBe(0)
    expect(lines.join('\n')).toContain('intentional stop marker present')
  })

  it('an unknown command returns 1 and prints usage', async () => {
    const { io, lines } = makeIo()
    const code = await runCli(['bogus'], io)
    expect(code).toBe(1)
    expect(lines.some((line) => line.toLowerCase().includes('usage'))).toBe(true)
  })
})
