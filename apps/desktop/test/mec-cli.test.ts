// M2.4, §20, O9: the CLI says what it did.
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cliHome, runCli } from '../src/mec'
import { readStopMarker, writeStopMarker } from '../src/stop-marker'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function io(startServer: () => Promise<'not_started' | undefined>) {
  const lines: string[] = []
  const markerDir = mkdtempSync(join(tmpdir(), 'mec-cli-'))
  dirs.push(markerDir)
  return {
    lines,
    io: {
      readSnapshotText: () => null,
      initialized: () => true,
      markerDir,
      dataDir: markerDir,
      stdout: (line: string) => {
        lines.push(line)
      },
      startServer,
    },
  }
}

describe('mec restart', () => {
  it('restart does not claim success without starting', async () => {
    const { io: cli, lines } = io(async () => 'not_started')
    writeStopMarker(cli.markerDir)
    const code = await runCli(['restart'], cli)
    expect(code).toBe(1)
    expect(lines.join('\n')).not.toContain('server starting')
    expect(lines.join('\n')).toContain('no server was started')
    expect(readStopMarker(cli.markerDir).present).toBe(false)
  })

  it('still says so when one did start', async () => {
    const { io: cli, lines } = io(async () => undefined)
    expect(await runCli(['restart'], cli)).toBe(0)
    expect(lines).toContain('server starting')
  })
})

describe('the CLI home', () => {
  it('honours MEC_DATA_DIR, as the server does', () => {
    expect(cliHome({ MEC_DATA_DIR: '/scratch/state' })).toBe('/scratch/state')
  })

  it('is ~/.mec by default, and an empty value is no value', () => {
    expect(cliHome({})).toBe(join(homedir(), '.mec'))
    expect(cliHome({ MEC_DATA_DIR: '' })).toBe(join(homedir(), '.mec'))
  })
})
