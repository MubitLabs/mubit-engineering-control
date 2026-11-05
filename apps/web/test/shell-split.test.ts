import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The real production build, because the dev server cannot show this: Vite preloads CSS from a
 * single dependency list per call site, so `flag ? import(a) : import(b)` built clean and
 * served classic's stylesheet to the next shell.
 */

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('the production build keeps the shells apart', () => {
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

  it('the bootstrap preloads each shell with its own stylesheet', () => {
    const bootstrap = read(asset(/^index-.*\.js$/))
    const nextCss = asset(/^entry-.*\.css$/)
    const classicCss = asset(/^classic-entry-.*\.css$/)
    const nextJs = asset(/^entry-.*\.js$/)
    const classicJs = asset(/^classic-entry-.*\.js$/)

    const deps = /m\.f=(\[[^\]]*\])/.exec(bootstrap)?.[1]
    expect(deps, 'dependency table').toBeDefined()
    expect(deps).toContain(nextCss)
    expect(deps).toContain(classicCss)

    const list = JSON.parse(deps as string) as string[]
    const groupOf = (js: string): string[] => {
      const start = bootstrap.indexOf(`./${js}`)
      const call = /__vite__mapDeps\(\[([\d,]+)\]\)/.exec(bootstrap.slice(start))
      expect(call, `deps for ${js}`).not.toBeNull()
      return (call?.[1] ?? '').split(',').map((index) => list[Number(index)] as string)
    }
    expect(groupOf(nextJs).some((file) => file.endsWith(nextCss))).toBe(true)
    expect(groupOf(nextJs).some((file) => file.endsWith(classicCss))).toBe(false)
    expect(groupOf(classicJs).some((file) => file.endsWith(classicCss))).toBe(true)
    expect(groupOf(classicJs).some((file) => file.endsWith(nextCss))).toBe(false)
  })

  it('no web font, classic token or mock reaches the next shell', () => {
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
