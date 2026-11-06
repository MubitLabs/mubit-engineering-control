import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cliMain, runCli } from '../src/mec'
import { readStopMarker, writeStopMarker } from '../src/stop-marker'

const normalBoardText = readFileSync(
  fileURLToPath(new URL('./fixtures/fake-health-board/normal.json', import.meta.url)),
  'utf8',
)

const tempDirs: string[] = []

/** A CliIo double: records stdout lines and startServer calls, markerDir/dataDir are fresh tmpdirs. */
function makeIo(overrides: { readSnapshotText?: () => string; initialized?: boolean } = {}) {
  const lines: string[] = []
  let starts = 0
  const markerDir = mkdtempSync(join(tmpdir(), 'mec-cli-'))
  const dataDir = mkdtempSync(join(tmpdir(), 'mec-cli-data-'))
  tempDirs.push(markerDir, dataDir)
  const io = {
    // A live writer's snapshot: `mec status` reads the heartbeat against the clock (§21.2).
    readSnapshotText:
      overrides.readSnapshotText ??
      (() => JSON.stringify({ ...JSON.parse(normalBoardText), heartbeatAt: new Date().toISOString() })),
    initialized: () => overrides.initialized ?? true,
    markerDir,
    dataDir,
    stdout: (line: string) => {
      lines.push(line)
    },
    startServer: async () => {
      starts += 1
    },
  }
  return { io, lines, markerDir, dataDir, starts: () => starts }
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

  it('slot dispatches to the slot CLI against the local data dir', async () => {
    const { io, lines, dataDir } = makeIo()
    const code = await runCli(['slot', 'add', 'claude-sub', 'max-1'], io)
    expect(code).toBe(0)
    expect(lines.some((line) => line.startsWith('created max-1 (home '))).toBe(true)
    expect(existsSync(join(dataDir, 'engines', 'claude', 'max-1'))).toBe(true)
  })

  it('update prints the installed version and the internal reinstall path, exit 0', async () => {
    const { io, lines } = makeIo()
    const code = await runCli(['update'], {
      ...io,
      readVersion: () => '0.1.0',
      gitRemote: () => 'git@github.com:mubit/mec.git',
      env: {},
    })
    expect(code).toBe(0)
    const text = lines.join('\n')
    expect(text).toContain('mec 0.1.0 (installed)')
    expect(text).toContain('registry: git@github.com:mubit/mec.git')
    expect(text).toContain(
      'internal distribution: reinstall from the repository (pnpm install && pnpm build:desktop)',
    )
    expect(text).toContain('no auto-update exists by design')
  })

  it('update prefers MEC_REGISTRY over the git remote', async () => {
    const { io, lines } = makeIo()
    await runCli(['update'], {
      ...io,
      readVersion: () => '0.1.0',
      gitRemote: () => 'git@github.com:mubit/mec.git',
      env: { MEC_REGISTRY: 'https://npm.internal.mubit.example' },
    })
    expect(lines.join('\n')).toContain('registry: https://npm.internal.mubit.example')
  })
})

/** Read-only commands only: `stop` and `restart` must never meet a real HOME from a test. */
describe('cliMain finds the server the way the launcher does', () => {
  const saved = {
    home: process.env.HOME,
    dataDir: process.env.MEC_DATA_DIR,
    argv: process.argv,
    exitCode: process.exitCode,
  }
  const restore = (key: 'HOME' | 'MEC_DATA_DIR', value: string | undefined) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  afterEach(() => {
    restore('HOME', saved.home)
    restore('MEC_DATA_DIR', saved.dataDir)
    process.argv = saved.argv
    process.exitCode = saved.exitCode
    vi.restoreAllMocks()
  })

  /** A home and a data dir, each with a snapshot that names which one was read. */
  function scratch(): { home: string; dataDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'mec-cli-main-'))
    tempDirs.push(root)
    const snapshot = (detail: string) =>
      JSON.stringify({
        ...(JSON.parse(normalBoardText) as object),
        parts: { sample: { state: 'error', detail } },
      })
    const home = join(root, 'home')
    const dataDir = join(root, 'data')
    mkdirSync(join(home, '.mec'), { recursive: true })
    mkdirSync(dataDir)
    writeFileSync(join(home, '.mec', 'health.json'), snapshot('read from HOME'))
    writeFileSync(join(dataDir, 'health.json'), snapshot('read from MEC_DATA_DIR'))
    return { home, dataDir }
  }

  async function status(): Promise<string> {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    process.argv = ['node', 'mec', 'status']
    await cliMain()
    return log.mock.calls.join('\n')
  }

  it('reads MEC_DATA_DIR when it is set', async () => {
    const { home, dataDir } = scratch()
    process.env.HOME = home
    process.env.MEC_DATA_DIR = dataDir
    expect(await status()).toContain('read from MEC_DATA_DIR')
  })

  it('reads ~/.mec when it is not', async () => {
    const { home } = scratch()
    process.env.HOME = home
    delete process.env.MEC_DATA_DIR
    expect(await status()).toContain('read from HOME')
  })
})
