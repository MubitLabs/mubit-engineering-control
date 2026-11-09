#!/usr/bin/env node
/**
 * The `mec` launcher (plan §21.1): runs the esbuild bundle (scripts/bundle-desktop.mjs) when
 * it exists, and falls back to type-stripped source otherwise — Node >= 22.18 strips types
 * natively, so repo dev needs no build step. Both entries export `serveMain(dataDir)`, which
 * stays alive until SIGINT/SIGTERM (see src/serve.ts).
 *
 * §21.7: the launcher REFUSES to compile native modules on the user's machine. When the
 * bundle cannot load better-sqlite3 / node-pty (missing prebuild, wrong ABI, not
 * installed), it prints the internal-install fix and exits 3 — a loud, distinct failure
 * instead of a stack trace.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const hasBundle = existsSync(join(here, '../dist/mec.mjs'))
const entry = hasBundle ? '../dist/mec.mjs' : '../src/serve.ts'

/**
 * True when the error is a native-module LOAD failure (§21.7), not any later runtime
 * error: the message must name one of the native modules and look like a module-load
 * problem. Matches ERR_DLOPEN_FAILED, missing bindings, missing module and ABI drift.
 */
function isNativeLoadFailure(error) {
  const text = `${error instanceof Error ? error.message : String(error)} ${error?.code ?? ''}`
  if (!/better[-_]sqlite3|node[-_]pty/.test(text)) return false
  return /MODULE_NOT_FOUND|ERR_DLOPEN_FAILED|ERR_MODULE_NOT_FOUND|Cannot find module|bindings|compiled against|NODE_MODULE_VERSION|ABI|dlopen/i.test(
    text,
  )
}

try {
  // §21.1 dispatch: no arguments → the guarded server; `mec <command>` → the CLI
  // (status/stop/restart/doctor/slot/update), which never starts a second server.
  // Server flags are intercepted here: --no-open (scripts/CI) exports MEC_NO_OPEN and
  // still runs the server; --version/-v and help print and exit without the store.
  const { readFile } = await import('node:fs/promises')
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const rawArgs = process.argv.slice(2)
  if (rawArgs.includes('--no-open')) process.env.MEC_NO_OPEN = '1'
  const KEY_FD = '--approval-key-fd='
  const keyFd = rawArgs.find((a) => a.startsWith(KEY_FD))?.slice(KEY_FD.length)
  const args = rawArgs.filter((a) => a !== '--no-open' && !a.startsWith(KEY_FD))
  const HELP = `mec ${pkg.version} — Mubit Engineering Control

usage: mec [command]

(no command)    start the workbench server and print its URL (opens Setup on first run)
--no-open       start the server without opening a browser
--approval-key-fd=N  read the approval key from descriptor N: for a script that must answer cards
--version, -v   print the version
help            this help
status          health snapshot + setup state (exit 0–3)
stop            stop the running server and record an intentional stop
restart         stop the running server, start a new one on its port (--respect-stop honours an intentional stop)
doctor          probe engines, sandbox and store; print a redacted report
slot            add | list | probe | retire — local slot state (never a running server)
update          version + the internal reinstall path (no network, by design)
backup          write a redacted archive of the store and state dir (--out <dir>)
restore         restore an archive into an empty data dir (--target <dir>, --drill)

docs: https://github.com/MubitLabs/mubit-engineering-control — README → guide
`
  if (args[0] === '--version' || args[0] === '-v') {
    console.log(`mec ${pkg.version}`)
  } else if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    console.log(HELP)
  } else if (args.length > 0) {
    const { cliMain } = await import(hasBundle ? '../dist/mec-cli.mjs' : '../src/mec.ts')
    await cliMain()
  } else {
    const { serveMain } = await import(entry)
    // cliHome's rule: an empty value is unset, or the server and the commands read different roots.
    await serveMain(
      process.env.MEC_DATA_DIR || join(homedir(), '.mec'),
      keyFd === undefined ? {} : { approvalKeyFd: Number(keyFd) },
    )
    // §20: close is bounded, and an engine child that outlived it must not hold the process up.
    process.exit()
  }
} catch (error) {
  if (isNativeLoadFailure(error)) {
    console.error(
      'MEC needs prebuilt native modules (better-sqlite3, node-pty) for this platform. ' +
        'Internal installs: pnpm install with the root package.json allowlist. ' +
        'See docs/known-limits.md',
    )
    process.exit(3)
  }
  console.error(`mec: failed to start: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
