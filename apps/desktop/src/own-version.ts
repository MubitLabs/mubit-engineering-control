import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * This build's version: the nearest package.json, apps/desktop's in dev and the staged one in an
 * internal install. `mec --version` prints it and `/api/status` names it, so a page built by an
 * older install can tell it is stale. Unreadable is `unknown`, never a guess.
 */
export function ownVersion(): string {
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
