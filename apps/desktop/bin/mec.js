#!/usr/bin/env node
/**
 * The `mec` launcher (plan §21.1): runs the esbuild bundle (scripts/bundle-desktop.mjs) when
 * it exists, and falls back to type-stripped source otherwise — Node >= 22.18 strips types
 * natively, so repo dev needs no build step. Both entries export `serveMain(dataDir)`, which
 * stays alive until SIGINT/SIGTERM (see src/serve.ts).
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const hasBundle = existsSync(join(here, '../dist/mec.mjs'))
const entry = hasBundle ? '../dist/mec.mjs' : '../src/serve.ts'

try {
  const { serveMain } = await import(entry)
  await serveMain(process.env.MEC_DATA_DIR ?? join(homedir(), '.mec'))
} catch (error) {
  console.error(`mec: failed to start: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
