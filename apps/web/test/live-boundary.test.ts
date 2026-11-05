import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The binding layer's wall: `live/*` reaches the real server, so nothing synthetic may be one
 * import away from production.
 */

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIVE = join(WEB, 'src/live')

const code = readdirSync(LIVE, { recursive: true, encoding: 'utf8' })
  .filter((name) => /\.tsx?$/.test(name))
  .map((name) => join(LIVE, name))

describe('live/* import walls', () => {
  it('finds the binding layer at all', () => {
    expect(code.length).toBeGreaterThanOrEqual(5)
  })

  it('never imports mocks or anything under test/', () => {
    const offending: string[] = []
    for (const file of code) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
        const specifier = match[1] ?? ''
        const target = specifier.startsWith('.') ? resolve(dirname(file), specifier) : specifier
        if (/mocks|fixtures|\/test\//.test(target)) offending.push(`${relative(WEB, file)} -> ${specifier}`)
      }
    }
    expect(offending).toEqual([])
  })

  it('never takes classic’s store, which selects the first live work by itself', () => {
    for (const file of code) expect(readFileSync(file, 'utf8')).not.toMatch(/WorkbenchProvider|\/workbench'/)
  })
})
