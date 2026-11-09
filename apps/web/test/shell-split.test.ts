import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/** The real production build: what ships is the built bundle, not what the dev server serves. */

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('the production build', () => {
  let out: string
  let assets: string[]
  const read = (name: string) => readFileSync(join(out, 'assets', name), 'utf8')
  const asset = (pattern: RegExp): string => {
    const found = assets.find((name) => pattern.test(name))
    if (!found) throw new Error(`no asset matching ${pattern}`)
    return found
  }

  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), 'mec-web-build-'))
    await build({ root: WEB, logLevel: 'silent', build: { outDir: out, emptyOutDir: true } })
    assets = readdirSync(join(out, 'assets'))
  }, 60_000)

  afterAll(() => rmSync(out, { recursive: true, force: true }))

  it('the bootstrap preloads the shell with its stylesheet', () => {
    const bootstrap = read(asset(/^index-.*\.js$/))
    const css = asset(/^entry-.*\.css$/)
    expect(bootstrap).toContain(asset(/^entry-.*\.js$/))
    expect(bootstrap).toContain(css)
    // The stylesheet is the shell's own: its tokens and layout, not an empty file.
    const sheet = read(css)
    expect(sheet).toContain('--')
    expect(sheet).toContain('.shell')
  })

  it('no web font or mock reaches the shell', () => {
    const css = read(asset(/^entry-.*\.css$/))
    expect(css).not.toMatch(/Instrument Sans|@font-face/)
    const js = read(asset(/^entry-.*\.js$/))
    // The inspection paths are the live layer's own and belong here; a mock's names never do.
    expect(js).not.toMatch(/demoStatus|demoWork/)
  })

  it('dist/assets contains no SAMPLE-ONLY', () => {
    for (const name of assets) expect(read(name), name).not.toContain('SAMPLE-ONLY')
  })

  it('the synthetic harness is not in the build at all', () => {
    for (const name of assets) expect(read(name), name).not.toMatch(/Sample console|sample search/)
  })
})
