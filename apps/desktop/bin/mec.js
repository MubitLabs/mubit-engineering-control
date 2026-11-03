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
  const args = process.argv.slice(2)
  if (args.length > 0) {
    const { cliMain } = await import(hasBundle ? '../dist/mec-cli.mjs' : '../src/mec.ts')
    await cliMain()
  } else {
    const { serveMain } = await import(entry)
    await serveMain(process.env.MEC_DATA_DIR ?? join(homedir(), '.mec'))
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
