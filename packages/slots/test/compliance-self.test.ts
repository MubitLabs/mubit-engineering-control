import { readdirSync, readFileSync, lstatSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { scanSourceForViolations } from '../src/compliance'

/**
 * §26 Compliance guard, self-applied: the scanner that guards the product also guards our
 * own source. No module in the product's source may read a vendor credential store.
 */
const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

const SRC_DIRS = ['packages/contracts', 'packages/domain', 'packages/effects', 'packages/engines', 'packages/git', 'packages/integration', 'packages/mec-tools', 'packages/meta', 'packages/policy', 'packages/prompts', 'packages/runtime', 'packages/scorecards', 'packages/slots', 'packages/store', 'apps/desktop', 'apps/web/src']

function listSourceFiles(dir: string, acc: { path: string; text: string }[] = []): { path: string; text: string }[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return acc
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === 'test') continue
    const full = join(dir, name)
    const st = lstatSync(full)
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) {
      listSourceFiles(full, acc)
    } else if (/\.(ts|tsx|js|mjs)$/.test(name)) {
      acc.push({ path: relative(REPO_ROOT, full), text: readFileSync(full, 'utf8') })
    }
  }
  return acc
}

describe('compliance self-scan', () => {
  it('no module in the product reads a vendor credential store', () => {
    const files = SRC_DIRS.flatMap((dir) => listSourceFiles(join(REPO_ROOT, dir)))
      // The guard's own source names every forbidden path and read marker by necessity;
      // it cannot read a credential store — it only defines the patterns that catch one.
      .filter((f) => f.path !== 'packages/slots/src/compliance.ts')
    expect(files.length).toBeGreaterThan(50)
    const violations = scanSourceForViolations(files)
    expect(violations).toEqual([])
  })
})
