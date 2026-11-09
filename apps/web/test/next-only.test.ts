import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseHash } from '../src/router'

/** The old shell is gone (decision #35): nothing may reach for it, and nothing of it may ship. */

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(WEB, 'src')

/** Paths relative to src, with no extension. A trailing slash is a whole folder. */
const DELETED = [
  'App',
  'classic-entry',
  'workbench',
  'state',
  'ui-flag',
  'tokens.css',
  'workbench.css',
  'views/',
  'components/',
]

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })

/** Static imports, side-effect imports, re-exports and dynamic imports alike. */
const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g

function deletedImports(file: string): string[] {
  const found: string[] = []
  for (const [, specifier] of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
    const target = relative(SRC, resolve(dirname(file), specifier as string))
    const hit = DELETED.some((name) => (name.endsWith('/') ? target.startsWith(name) : target === name))
    if (hit) found.push(`${relative(WEB, file)} imports ${specifier}`)
  }
  return found
}

describe('the classic shell is gone', () => {
  it('no src file imports a deleted module', () => {
    expect(walk(SRC).flatMap(deletedImports)).toEqual([])
  })

  it('no deleted module is left on disk', () => {
    const left = DELETED.flatMap((name) =>
      [name, `${name}.ts`, `${name}.tsx`].filter((path) => existsSync(join(SRC, path))),
    )
    expect(left).toEqual([])
    expect(existsSync(join(WEB, 'public', 'fonts'))).toBe(false)
  })

  it('nothing reads the old shell choice', () => {
    const source = walk(SRC).filter((file) => readFileSync(file, 'utf8').includes('mec-ui-shell'))
    expect(source.map((file) => relative(WEB, file))).toEqual([])
  })

  it('old deep links still route', () => {
    expect(parseHash('#/wizard')).toBe('setup')
    expect(parseHash('#/inbox')).toBe('needs')
    expect(parseHash('#wizard')).toBe('setup')
    expect(parseHash('#inbox')).toBe('needs')
    expect(parseHash('#nonsense')).toBe('chat')
  })
})

describe('the production build', () => {
  let out: string
  let files: string[]

  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), 'mec-web-build-'))
    await build({ root: WEB, logLevel: 'silent', build: { outDir: out, emptyOutDir: true } })
    files = walk(out)
  }, 60_000)

  afterAll(() => rmSync(out, { recursive: true, force: true }))

  it('the bundle references no Instrument Sans', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toMatch(/Instrument ?Sans|Spline ?Sans|@font-face|\.woff2/)
    }
    expect(files.filter((file) => /\/fonts\/|\.woff2$/.test(file))).toEqual([])
  })

  it('the bundle carries none of the classic shell', () => {
    expect(files.filter((file) => /classic-entry/.test(file))).toEqual([])
    for (const file of files) {
      // Class names only the classic stylesheet and components used.
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/rail-item|rail-status|pane-title|slot-dots/)
    }
  })
})
