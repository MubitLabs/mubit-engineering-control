import { describe, expect, it } from 'vitest'
import { commandMatches, searchOffer } from '../src/next/command-search'
import {
  type ModelsSummary,
  modelsSummaryLines,
  policySummary,
  type Readiness,
  type ReadinessStep,
  setupDone,
} from '../src/next/config-model'
import { multiline, timeLabel } from '../src/next/format'

const step = (id: string, status: ReadinessStep['status']): ReadinessStep => ({
  id,
  title: id,
  status,
  detail: '',
  next: null,
})

const readiness = (over: Partial<Readiness>): Readiness => ({
  steps: [],
  engines: [],
  metaCandidates: [],
  metaSlotId: null,
  finish: { enabled: true },
  completion: null,
  ...over,
})

const completion = {
  repository: { id: 'repo_a', url: 'https://example.test/a' },
  metaSlot: { id: 'slot_a', label: 'a' },
}

describe('the policy in plain words', () => {
  it('says that nothing runs unasked when nothing is pre-authorised', () => {
    const none = ['MEC asks you before anything that needs a confirmation.']
    expect(policySummary('{"preAuthorised":{}}')).toEqual(none)
    expect(policySummary('{"preAuthorised":[]}')).toEqual(none)
    expect(policySummary('{"preAuthorised":{"install":[]}}')).toEqual(none)
  })

  it('names each class allowed, how far it goes and any spending ceiling', () => {
    expect(
      policySummary(
        JSON.stringify({
          preAuthorised: {
            install: [{ scope: 'repo', repoId: 'repo_a' }],
            spend: [{ scope: 'work_item', maxUsd: 5 }],
          },
        }),
      ),
    ).toEqual([
      'Installing dependencies: allowed without asking, for one repository.',
      'Spending money: allowed without asking, for one piece of work, up to $5.',
    ])
  })

  it('counts several entries for a class rather than picking one', () => {
    const text = JSON.stringify({
      preAuthorised: { migration: [{ scope: 'repo' }, { scope: 'repo' }] },
    })
    expect(policySummary(text)).toEqual(['Database migrations: allowed without asking, 2 rules.'])
  })

  it('says what limits and per-repository rules add', () => {
    const text = JSON.stringify({
      preAuthorised: {},
      capsOverride: { globalActiveAttempts: 2, budgetUsd: 10, somethingNew: 3 },
      repoTightening: { repo_a: {}, repo_b: {} },
    })
    expect(policySummary(text)).toEqual([
      'MEC asks you before anything that needs a confirmation.',
      'Runs at once: at most 2.',
      'Budget: at most $10.',
      'somethingNew: at most 3.',
      'Tighter rules for 2 repositories.',
    ])
  })

  it('never summarises text it cannot read', () => {
    expect(policySummary('{not json')).toBeNull()
    expect(policySummary('[]')).toBeNull()
    expect(policySummary('null')).toBeNull()
  })

  it('shows an unknown class by its own name, never hides it', () => {
    expect(policySummary('{"preAuthorised":{"new_class":[{"scope":"repo"}]}}')).toEqual([
      'new_class: allowed without asking, for one repository.',
    ])
  })
})

describe('the models table in plain words', () => {
  const summary: ModelsSummary = {
    tiers: ['fast', 'strong'],
    engines: [
      {
        engine: 'claude',
        models: [
          { id: 'haiku', tier: 'fast' },
          { id: 'opus', tier: 'strong' },
        ],
      },
      { engine: 'codex', models: [] },
    ],
  }

  it('reads one line per engine with its models by tier', () => {
    expect(modelsSummaryLines(summary)).toEqual([
      'Tiers: fast, strong.',
      'Claude Code: haiku (fast), opus (strong).',
      'Codex: no models listed.',
    ])
  })
})

describe('setup done', () => {
  const steps = [step('engines', 'done'), step('first_request', 'done')]

  it('is done once every stage is, and the server has named what it finished on', () => {
    expect(setupDone(readiness({ steps, completion }))).toBe(true)
  })

  it('is not done with a stage open, or with nothing to name', () => {
    expect(setupDone(readiness({ steps }))).toBe(false)
    expect(
      setupDone(
        readiness({ steps: [steps[0] as ReadinessStep, step('first_request', 'missing')], completion }),
      ),
    ).toBe(false)
    expect(
      setupDone(
        readiness({ steps: [steps[0] as ReadinessStep, step('first_request', 'skipped')], completion }),
      ),
    ).toBe(false)
  })

  it('a stage still being checked is not done', () => {
    expect(setupDone(readiness({ steps: [step('engines', 'checking')], completion }))).toBe(false)
  })
})

describe('the palette and work search', () => {
  const commands = [
    { id: 'a', label: 'Go to Work' },
    { id: 'b', label: 'Theme: Dark' },
  ]

  it('filters commands by label, any case', () => {
    expect(commandMatches(commands, ' WORK ').map((c) => c.id)).toEqual(['a'])
    expect(commandMatches(commands, '')).toHaveLength(2)
  })

  it('offers a search of work for what was typed, with the text as typed', () => {
    expect(searchOffer(' wave ', true)).toEqual({
      query: 'wave',
      label: 'Search work, tasks and messages for “wave”',
    })
  })

  it('offers nothing with nothing typed, or with nothing to answer it', () => {
    expect(searchOffer('   ', true)).toBeNull()
    expect(searchOffer('wave', false)).toBeNull()
  })
})

describe('dates and output', () => {
  const now = new Date()

  it('a date today is its time, in no numeric day format', () => {
    const label = timeLabel(now.toISOString())
    expect(label).not.toContain('/')
    expect(label).toMatch(/\d{1,2}[:.]\d{2}/)
  })

  it('another day names its month, and never prints seconds', () => {
    const label = timeLabel(new Date(now.getFullYear() - 1, 2, 9, 18, 17, 10).toISOString())
    expect(label).toMatch(/Mar/)
    expect(label).toContain(String(now.getFullYear() - 1))
    expect(label).not.toContain('/')
    expect(label).not.toContain(':10')
  })

  it('this year leaves the year out', () => {
    const other = new Date(now.getFullYear(), now.getMonth() === 0 ? 1 : 0, 9, 8, 5)
    expect(timeLabel(other.toISOString())).not.toContain(String(now.getFullYear()))
  })

  it('text that is not a date comes back as it was', () => {
    expect(timeLabel('not a date')).toBe('not a date')
  })

  it('tells several lines of output from one line of words', () => {
    expect(multiline('1 failed\n2 passed')).toBe(true)
    expect(multiline('1 failed\r\n')).toBe(false)
    expect(multiline('All checks passed')).toBe(false)
  })
})
