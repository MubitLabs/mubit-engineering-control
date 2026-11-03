/**
 * The `mec` CLI entry (plan §21): a thin, fully injectable router.
 *
 * Every side effect (snapshot file, stop marker, server start, stdout) sits behind `CliIo`
 * so tests drive `runCli` with fakes; the guarded `main` at the bottom is the only place
 * that touches the real process.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildDoctorReport, defaultVersionRunner } from './doctor'
import type { HealthSnapshot } from './health'
import { parseHealthSnapshot } from './health'
import { formatStatus, statusFromSnapshot } from './status'
import { clearStopMarker, readStopMarker, writeStopMarker } from './stop-marker'

export type CliIo = {
  /** null when no snapshot file exists */
  readSnapshotText: () => string | null
  /** whether ~/.mec was ever initialised */
  initialized: () => boolean
  /** directory holding the stop marker */
  markerDir: string
  stdout: (line: string) => void
  /** called on 'restart' when allowed; record calls in tests */
  startServer: () => Promise<void>
}

const USAGE = 'usage: mec <status|stop|restart|doctor> [flags]'

/** `parseHealthSnapshot` handles '' but not invalid JSON; a corrupt file is "no snapshot". */
function parseSnapshot(text: string | null): HealthSnapshot | null {
  if (text === null) return null
  try {
    return parseHealthSnapshot(text)
  } catch {
    return null
  }
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command] = argv

  if (command === 'status') {
    const snapshot = parseSnapshot(io.readSnapshotText())
    const result = statusFromSnapshot(snapshot, { initialized: io.initialized() })
    io.stdout(formatStatus(result))
    return result.code
  }

  if (command === 'stop') {
    writeStopMarker(io.markerDir)
    io.stdout('intentional stop recorded; mec restart --respect-stop will not start the server')
    return 0
  }

  if (command === 'restart') {
    if (argv.includes('--respect-stop') && readStopMarker(io.markerDir).present) {
      io.stdout('intentional stop marker present; not starting')
      return 0
    }
    clearStopMarker(io.markerDir)
    await io.startServer()
    io.stdout('server starting')
    return 0
  }

  if (command === 'doctor') {
    const report = await buildDoctorReport({ env: process.env, run: defaultVersionRunner })
    io.stdout(report)
    return 0
  }

  io.stdout(USAGE)
  return 1
}

async function main(): Promise<void> {
  const home = join(homedir(), '.mec')
  const snapshotPath = join(home, 'health.json')
  process.exitCode = await runCli(process.argv.slice(2), {
    readSnapshotText: () => {
      try {
        return readFileSync(snapshotPath, 'utf8')
      } catch {
        return null
      }
    },
    initialized: () => existsSync(home),
    markerDir: home,
    stdout: (line) => console.log(line),
    startServer: async () => {},
  })
}

if (process.argv[1]?.endsWith('mec.ts') || process.argv[1]?.endsWith('mec.js')) {
  await main()
}
