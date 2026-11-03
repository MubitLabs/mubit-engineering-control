import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseClaudeStream } from '../src/claude/stream'

/**
 * CONTRACTS §9 conformance, engine side: the adapter's stream parser, run over each
 * recorded raw stream, must yield exactly the fixture's normalised events.
 * The fixture library is the record; raw.jsonl is the truth; this test keeps the
 * three in agreement for every real recording we ship.
 */
const ROOT = fileURLToPath(new URL('../../testkit/fixtures/claude/2.1.317', import.meta.url))

const CASES = [
  { scenario: 'smoke', exitCode: 0 },
  { scenario: 'auth_expired', exitCode: 1 },
  { scenario: 'max_turns', exitCode: 1 },
  { scenario: 'crash_mid_turn', exitCode: 137 },
] as const

describe('claude stream conformance (real fixtures)', () => {
  for (const { scenario, exitCode } of CASES) {
    it(`${scenario}: parseClaudeStream(raw) === events.jsonl`, () => {
      const rawLines = readFileSync(join(ROOT, scenario, 'raw.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
      const expected = readFileSync(join(ROOT, scenario, 'events.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const parsed = parseClaudeStream(rawLines, { exitCode })
      expect(parsed).toHaveLength(expected.length)
      for (let i = 0; i < expected.length; i++) {
        expect(parsed[i]).toEqual(expected[i])
      }
    })
  }

  it('invariants hold for every fixture', () => {
    for (const { scenario, exitCode } of CASES) {
      const rawLines = readFileSync(join(ROOT, scenario, 'raw.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
      const parsed = parseClaudeStream(rawLines, { exitCode })
      expect(parsed[0]?.type).toBe('session_started')
      expect(parsed.at(-1)?.type).toBe('exit')
      expect(parsed.filter((e) => e.type === 'session_started')).toHaveLength(1)
      expect(parsed.filter((e) => e.type === 'exit')).toHaveLength(1)
    }
  })
})
