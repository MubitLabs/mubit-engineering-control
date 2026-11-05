import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * M1.1: demo data must never reach the production bundle. The synthetic worked example lives in
 * test/mocks.ts and the screens suite supplies it explicitly; nothing under src/ may import it.
 */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

describe('the production sources hold no fixtures', () => {
  const srcDir = join(import.meta.dirname, '..', 'src')

  it('no file under src/ imports a mocks module or names demo fixtures', () => {
    for (const file of sources(srcDir)) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toMatch(/from\s+['"][^'"]*\/mocks['"]/)
      expect(text, file).not.toMatch(/\bdemo[A-Z]\w*/)
      expect(text, file).not.toMatch(/\bwithDemo\b/)
    }
  })
})
