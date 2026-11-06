/**
 * The `mec` CLI entry (plan §21): a thin, fully injectable router.
 *
 * Every side effect (snapshot file, stop marker, server start, stdout) sits behind `CliIo`
 * so tests drive `runCli` with fakes; the guarded `main` at the bottom is the only place
 * that touches the real process.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDoctorJson, buildDoctorReport, defaultVersionRunner } from './doctor'
import type { HealthSnapshot } from './health'
import { parseHealthSnapshot } from './health'
import { runSlotCli } from './slot-cli'
import { formatStatus, statusFromSnapshot } from './status'
import { clearStopMarker, readStopMarker, writeStopMarker } from './stop-marker'

export type CliIo = {
  /** null when no snapshot file exists */
  readSnapshotText: () => string | null
  /** whether ~/.mec was ever initialised */
  initialized: () => boolean
  /** directory holding the stop marker */
  markerDir: string
  /**
   * §21.1 `mec slot …`: the root that holds mec.db and the engines/ slot-home tree
   * (~/.mec in production). The slot subcommands operate on that local state, never on
   * a running server.
   */
  dataDir: string
  stdout: (line: string) => void
  /** called on 'restart' when allowed; record calls in tests */
  startServer: () => Promise<void>
  /** `mec update` seams; defaults read the nearest package.json, git and process.env. */
  readVersion?: () => string
  gitRemote?: () => string | null
  env?: Record<string, string | undefined>
}

const USAGE = 'usage: mec <status|stop|restart|doctor|setup|slot|update> [flags]'

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
    // --json is the machine bundle bug reports attach (SETUP.md, the issue template).
    // Exit 0 whenever the bundle was produced: `ok` inside the JSON says whether engines
    // answered — a machine with none installed is a REPORTED state, not a command failure
    // (the CI install-smoke runs exactly such a machine).
    if (argv.includes('--json')) {
      const bundle = await buildDoctorJson({ env: process.env, run: defaultVersionRunner })
      io.stdout(JSON.stringify(bundle, null, 2))
      return 0
    }
    const report = await buildDoctorReport({ env: process.env, run: defaultVersionRunner })
    io.stdout(report)
    return 0
  }

  // T7 (review 2026-11-04 §7): `mec setup` points at the workbench's Setup mode — the
  // CLI stays thin; the setup agent itself runs in Chat against the Settings API.
  if (command === 'setup') {
    io.stdout(
      [
        'open the workbench → Chat → Setup mode',
        'the setup agent configures MEC with you there: slots, prompts, the model table, repositories',
        '(this command configures nothing itself — the CLI stays thin by design)',
      ].join('\n'),
    )
    return 0
  }

  // §21.1 `mec slot add|list|probe|retire`: local slot state in io.dataDir, never a
  // server call — runSlotCli owns its store open/close and exit codes.
  if (command === 'slot') {
    return runSlotCli(argv.slice(1), { dataDir: io.dataDir, stdout: io.stdout })
  }

  if (command === 'update') {
    io.stdout(buildUpdateReport(io))
    return 0
  }

  io.stdout(USAGE)
  return 1
}

/**
 * `mec update` (plan §21.5, amended by DECISIONS #4): MEC is distributed internally —
 * the artifact of record is the git repository (or an internal registry via MEC_REGISTRY),
 * so this reports the installed version and the reinstall path. No network check exists
 * by design; nothing here ever fetches.
 */
export function buildUpdateReport(io: CliIo): string {
  const version = (io.readVersion ?? defaultReadVersion)()
  const env = io.env ?? process.env
  const registry =
    env.MEC_REGISTRY ??
    (io.gitRemote ?? defaultGitRemote)() ??
    'unset — set MEC_REGISTRY or reinstall from the repository'
  return [
    `mec ${version} (installed)`,
    `registry: ${registry} (internal distribution)`,
    'internal distribution: reinstall from the repository (pnpm install && pnpm build:desktop)',
    'no auto-update exists by design',
  ].join('\n')
}

/** The nearest package.json — apps/desktop's in dev, the staged one in an internal install. */
function defaultReadVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as {
      version?: unknown
    }
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** The install's git origin, when this checkout is a repository (local git only, no network). */
function defaultGitRemote(): string | null {
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const url = out.trim()
    return url === '' ? null : url
  } catch {
    return null
  }
}

/** §21.1 entry for the `mec <command>` dispatch: exports for bin/mec.js and the bundle. */
export async function cliMain(): Promise<void> {
  const home = process.env.MEC_DATA_DIR ?? join(homedir(), '.mec')
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
    dataDir: home,
    stdout: (line) => console.log(line),
    startServer: async () => {},
  })
}

async function main(): Promise<void> {
  await cliMain()
}

if (process.argv[1]?.endsWith('mec.ts') || process.argv[1]?.endsWith('mec-cli.mjs')) {
  await main()
}
