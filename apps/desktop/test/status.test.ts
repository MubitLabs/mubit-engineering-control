import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { HealthSnapshot } from '../src/health'
import { parseHealthSnapshot } from '../src/health'
import { formatStatus, statusFromSnapshot } from '../src/status'

const fixtureDir = fileURLToPath(new URL('./fixtures/fake-health-board', import.meta.url))

/** A fully healthy board; each row overrides only the thing it exercises. */
function board(overrides: {
  runtime?: Partial<HealthSnapshot['runtime']>
  parts?: HealthSnapshot['parts']
  setup?: Partial<HealthSnapshot['setup']>
}): HealthSnapshot {
  return {
    runtime: { state: 'ready', instances: 1, answering: true, ...overrides.runtime },
    parts: overrides.parts ?? {},
    setup: { has_slot: true, has_repository: true, ...overrides.setup },
  }
}

function text(result: { lines: string[] }): string {
  return result.lines.join('\n')
}

describe('statusFromSnapshot', () => {
  describe('precedence rows', () => {
    it('null snapshot before initialization waits for setup (3)', () => {
      const result = statusFromSnapshot(null, { initialized: false })
      expect(result.code).toBe(3)
      expect(text(result)).toContain('waiting for setup')
    })

    it('null snapshot after initialization is not running (1)', () => {
      const result = statusFromSnapshot(null, { initialized: true })
      expect(result.code).toBe(1)
      expect(text(result)).toContain('not running')
    })

    it('zero instances is not running (1)', () => {
      const result = statusFromSnapshot(board({ runtime: { instances: 0, answering: true } }), {
        initialized: true,
      })
      expect(result.code).toBe(1)
      expect(result.lines.length).toBeGreaterThan(0)
    })

    it('two instances is running twice (1)', () => {
      const result = statusFromSnapshot(board({ runtime: { instances: 2 } }), { initialized: true })
      expect(result.code).toBe(1)
      expect(text(result)).toContain('running twice')
    })

    it('not answering is code 1', () => {
      const result = statusFromSnapshot(board({ runtime: { answering: false } }), { initialized: true })
      expect(result.code).toBe(1)
      expect(result.lines.length).toBeGreaterThan(0)
    })

    it('runtime error state is code 1', () => {
      const result = statusFromSnapshot(board({ runtime: { state: 'error' } }), { initialized: true })
      expect(result.code).toBe(1)
      expect(result.lines.length).toBeGreaterThan(0)
    })

    it('a part in error is code 2 and names the part and its detail', () => {
      const result = statusFromSnapshot(
        board({ parts: { 'slot:max-1': { state: 'error', detail: 'login expired' } } }),
        { initialized: true },
      )
      expect(result.code).toBe(2)
      expect(text(result)).toContain('slot:max-1')
      expect(text(result)).toContain('login expired')
    })

    it('a missing slot waits for setup (3) and names what is missing', () => {
      const result = statusFromSnapshot(board({ setup: { has_slot: false } }), { initialized: true })
      expect(result.code).toBe(3)
      expect(text(result)).toContain('slot')
    })

    it('a missing repository waits for setup (3) and names what is missing', () => {
      const result = statusFromSnapshot(board({ setup: { has_repository: false } }), { initialized: true })
      expect(result.code).toBe(3)
      expect(text(result)).toContain('repository')
    })

    it('a healthy board runs normally (0)', () => {
      const result = statusFromSnapshot(board({}), { initialized: true })
      expect(result.code).toBe(0)
      expect(text(result)).toContain('running normally')
    })

    it('a degraded part keeps code 0 but adds a degraded line', () => {
      const result = statusFromSnapshot(
        board({ parts: { 'engine:claude': { state: 'degraded', detail: 'rate limited' } } }),
        { initialized: true },
      )
      expect(result.code).toBe(0)
      expect(text(result)).toContain('engine:claude')
      expect(text(result)).toContain('degraded')
    })

    it('not answering outranks a part in error', () => {
      const result = statusFromSnapshot(
        board({
          runtime: { answering: false },
          parts: { 'slot:max-1': { state: 'error', detail: 'login expired' } },
        }),
        { initialized: true },
      )
      expect(result.code).toBe(1)
    })

    it('a part in error outranks missing setup', () => {
      const result = statusFromSnapshot(
        board({
          parts: { 'slot:max-1': { state: 'error', detail: 'login expired' } },
          setup: { has_repository: false },
        }),
        { initialized: true },
      )
      expect(result.code).toBe(2)
    })
  })

  describe('fake health board fixtures', () => {
    const cases = [
      { file: 'normal.json', code: 0 },
      { file: 'slot-error.json', code: 2 },
      { file: 'unconfigured.json', code: 3 },
      { file: 'not-answering.json', code: 1 },
    ] as const

    for (const { file, code } of cases) {
      it(`${file} maps to code ${code}`, () => {
        const snapshot = parseHealthSnapshot(readFileSync(join(fixtureDir, file), 'utf8'))
        expect(snapshot).not.toBeNull()
        const result = statusFromSnapshot(snapshot, { initialized: true })
        expect(result.code).toBe(code)
      })
    }
  })
})

describe('formatStatus', () => {
  it('joins the result lines with newlines', () => {
    const formatted = formatStatus({ code: 1, lines: ['mec is not running', 'start it with mec restart'] })
    expect(formatted).toBe('mec is not running\nstart it with mec restart')
  })
})
