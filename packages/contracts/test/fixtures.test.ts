import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkEventStream, EngineEventBody } from '../src'

// Stream B records fixtures (CONTRACTS §9); every events.jsonl must parse and hold the §1 invariants.
const ROOT = fileURLToPath(new URL('../../testkit/fixtures', import.meta.url))

const fixtures = existsSync(ROOT)
  ? readdirSync(ROOT, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('events.jsonl'))
      .sort()
  : []

describe('fixture event streams', () => {
  if (fixtures.length === 0) it.todo('no fixtures yet; Stream B lands claude/2.1.317 by PR')

  it.each(fixtures)('%s', (file) => {
    const lines = readFileSync(join(ROOT, file), 'utf8').split('\n').filter(Boolean)
    const events = lines.map((line, i) => {
      const result = EngineEventBody.safeParse(JSON.parse(line))
      expect(result.error?.issues, `line ${i + 1}`).toBeUndefined()
      return result.data!
    })
    expect(checkEventStream(events)).toEqual([])
  })
})
