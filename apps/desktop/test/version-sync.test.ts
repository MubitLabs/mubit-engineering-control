/**
 * The three version fields move together (M3.4 Stage D). pack-tarball.mjs names the
 * artifact from the desktop version, so a root or web version left behind would not break
 * the build; it would mislabel the tarball (`393144b`). packages/* stay at 0.1.0 and are
 * not compared.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const versionOf = (path: string): string => JSON.parse(readFileSync(join(root, path), 'utf8')).version

describe('version sync', () => {
  it('root, desktop and web agree', () => {
    const desktop = versionOf('apps/desktop/package.json')
    expect(desktop).toMatch(/^\d+\.\d+\.\d+$/)
    expect({ root: versionOf('package.json'), desktop, web: versionOf('apps/web/package.json') }).toEqual({
      root: desktop,
      desktop,
      web: desktop,
    })
  })
})
