import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The next shell's walls, enforced in `pnpm check`: props only, no route to a server, no
 * sample data, and tokens that meet the design's measurable contrast and size rules.
 */

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NEXT = join(WEB, 'src/next')
const FIXTURES = join(WEB, 'test/fixtures')

function files(dir: string, extension: RegExp): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => extension.test(name))
    .map((name) => join(dir, name))
}

const code = files(NEXT, /\.tsx?$/)
const css = files(NEXT, /\.css$/)

function importsOf(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
    if (match[1]) found.push(match[1])
  }
  return found
}

describe('next/* import walls', () => {
  it('finds the shell at all', () => {
    expect(code.length).toBeGreaterThan(5)
    expect(css.length).toBeGreaterThanOrEqual(3)
  })

  it('reaches only react, itself and the pure hash router', () => {
    const offending: string[] = []
    for (const file of code) {
      for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
        if (specifier === 'react' || specifier === 'react-dom' || specifier === 'react-dom/client') continue
        if (specifier === 'react/jsx-runtime') continue
        const target = specifier.startsWith('.') ? resolve(dirname(file), specifier) : specifier
        const allowed = target.startsWith(`${NEXT}/`) || target === join(WEB, 'src/router')
        if (!allowed) offending.push(`${relative(WEB, file)} -> ${specifier}`)
      }
    }
    expect(offending).toEqual([])
  })

  it('has no way to reach a server', () => {
    const offending: string[] = []
    for (const file of code) {
      const source = readFileSync(file, 'utf8')
      for (const needle of ['fetch(', 'EventSource', 'XMLHttpRequest', 'WebSocket', 'sendBeacon']) {
        if (source.includes(needle)) offending.push(`${relative(WEB, file)}: ${needle}`)
      }
    }
    expect(offending).toEqual([])
  })

  it('ships no sample sentence from the fixtures', () => {
    const sentences = new Set<string>()
    for (const file of files(FIXTURES, /\.tsx?$/)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/['"]([A-Z][^'"\n]* [^'"\n]* [^'"\n]*)['"]/g)) {
        if (match[1]) sentences.add(match[1])
      }
    }
    expect(sentences.size).toBeGreaterThan(10)
    const source = [...code, ...css].map((file) => readFileSync(file, 'utf8')).join('\n')
    expect([...sentences].filter((sentence) => source.includes(sentence))).toEqual([])
  })
})

describe('next/* stylesheets', () => {
  const sheets = css.map((file) => ({ name: relative(WEB, file), text: readFileSync(file, 'utf8') }))

  it('never sets text under 12px', () => {
    const offending: string[] = []
    for (const sheet of sheets) {
      for (const match of sheet.text.matchAll(/font(?:-size)?:\s*(?:[a-z]+\s+)*?(\d+(?:\.\d+)?)px/g)) {
        if (Number(match[1]) < 12) offending.push(`${sheet.name}: ${match[0]}`)
      }
    }
    expect(offending).toEqual([])
  })

  it('loads nothing over the network and no web font', () => {
    for (const sheet of sheets) {
      expect(sheet.text).not.toMatch(/@font-face|@import|url\(\s*['"]?https?:/)
    }
  })

  it('has no uppercase labels', () => {
    for (const sheet of sheets) expect(sheet.text).not.toMatch(/text-transform:\s*uppercase/)
  })
})

describe('next tokens', () => {
  const tokens = readFileSync(join(NEXT, 'tokens.css'), 'utf8')

  function block(selector: string): Record<string, string> {
    const start = tokens.indexOf(`${selector} {`)
    expect(start, selector).toBeGreaterThanOrEqual(0)
    const end = tokens.indexOf('}', start)
    const values: Record<string, string> = {}
    for (const match of tokens.slice(start, end).matchAll(/--([a-z-]+):\s*(#[0-9a-f]{3,8})/g)) {
      if (match[1] && match[2]) values[match[1]] = match[2]
    }
    return values
  }

  function luminance(hex: string): number {
    const value = hex.replace('#', '')
    const full = value.length === 3 ? [...value].map((c) => c + c).join('') : value
    const channel = (offset: number) => {
      const c = Number.parseInt(full.slice(offset, offset + 2), 16) / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
  }

  function contrast(a: string, b: string): number {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
    return (high + 0.05) / (low + 0.05)
  }

  const light = block(':root')
  const dark = block(':root[data-theme="dark"]')
  const auto = block(':root:not([data-theme="light"])')

  it('Auto dark and explicit dark are the same values', () => {
    expect(auto).toEqual(dark)
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort())
  })

  it.each([
    ['light', light],
    ['dark', dark],
  ] as const)('%s text is at least 4.5:1 on every background it can sit on', (_name, theme) => {
    const backgrounds = ['canvas', 'rail', 'surface', 'selected', 'hover', 'attention']
    for (const foreground of ['ink', 'secondary', 'amber', 'green', 'red']) {
      for (const background of backgrounds) {
        const ratio = contrast(theme[foreground] as string, theme[background] as string)
        expect(ratio, `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it.each([
    ['light', light],
    ['dark', dark],
  ] as const)('%s control boundaries and the focus ring are at least 3:1', (_name, theme) => {
    for (const background of ['canvas', 'rail', 'surface', 'hover']) {
      const boundary = contrast(theme['control-line'] as string, theme[background] as string)
      expect(boundary, `control-line on ${background}`).toBeGreaterThanOrEqual(3)
    }
    for (const background of ['canvas', 'rail', 'surface', 'selected', 'hover', 'attention']) {
      const ring = contrast(theme.focus as string, theme[background] as string)
      expect(ring, `focus on ${background}`).toBeGreaterThanOrEqual(3)
    }
  })

  it('the primary button keeps its label readable', () => {
    expect(contrast(light.surface as string, light.ink as string)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(dark.surface as string, dark.ink as string)).toBeGreaterThanOrEqual(4.5)
  })
})
