import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createClaudeEventParser, parseClaudeStream } from '../src/claude/stream'

/**
 * Defect 5d (M2.1): events must reach the runtime as the lines arrive. Every recording is fed one
 * line at a time, and what came out by each line must be a prefix of the recorded events, so an
 * implementation that holds everything until the end fails here too.
 */
const ROOT = fileURLToPath(new URL('../../testkit/fixtures/claude/2.1.317', import.meta.url))
const EXIT_CODES: Record<string, number> = { auth_expired: 1, max_turns: 1, crash_mid_turn: 137 }

const scenarios = readdirSync(ROOT)
const lines = (scenario: string, file: string): string[] =>
  readFileSync(join(ROOT, scenario, file), 'utf8')
    .split('\n')
    .filter(Boolean)

describe('createClaudeEventParser', () => {
  it('has recordings to run over', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(4)
  })

  for (const scenario of scenarios) {
    it(`incremental parser matches parseClaudeStream on every fixture: ${scenario}`, () => {
      const raw = lines(scenario, 'raw.jsonl')
      const recorded = lines(scenario, 'events.jsonl').map((line) => JSON.parse(line))
      const exitCode = EXIT_CODES[scenario] ?? 0

      const parser = createClaudeEventParser()
      const seen: unknown[] = []
      for (const line of raw) {
        seen.push(...parser.push(line))
        expect(seen).toEqual(recorded.slice(0, seen.length))
        expect(seen.some((event) => (event as { type: string }).type === 'exit')).toBe(false)
      }
      seen.push(...parser.finish(exitCode))

      expect(seen).toEqual(recorded)
      expect(seen).toEqual(parseClaudeStream(raw, { exitCode }))
    })
  }

  it('hands an event over on the line that carries it, not at the end', () => {
    const [first] = lines('smoke', 'raw.jsonl')
    expect(createClaudeEventParser().push(first ?? '')[0]?.type).toBe('session_started')
  })

  it('a result with no terminal reason falls back on the exit code', () => {
    const parser = createClaudeEventParser()
    parser.push(JSON.stringify({ type: 'result', usage: {} }))
    expect(parser.finish(137).at(-1)).toEqual({ type: 'exit', code: 137, terminal_reason: 'crashed' })
  })
})
