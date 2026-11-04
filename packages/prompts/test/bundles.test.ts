import { describe, expect, it } from 'vitest'
import type { BundleComponent, BundleLayer } from '../src'
import { compileBundle, componentHash, LAYER_ORDER } from '../src'

const part = (
  layer: BundleLayer,
  name: string,
  text: string,
  extra: Partial<Pick<BundleComponent, 'origin' | 'defaultBaseHash'>> = {},
): BundleComponent => ({ layer, name, text, hash: componentHash(text), origin: 'default', ...extra })

/** One part per layer except shared (two), listed out of composition order on purpose. */
const bundle = (): readonly BundleComponent[] => [
  part('skills', 'review-budget', 'Review within budget.'),
  part('shared', 'global', 'Voice and hard rules.'),
  part('role', 'implementer', 'Implement the task.'),
  part('delivery', 'pr-evidence', 'PRs carry evidence.'),
  part('conventions', 'team', 'Team conventions.'),
  part('shared', 'secrets', 'Never ask for secrets.'),
  part('engine', 'claude', 'Engine notes.'),
  part('generated', 'env', 'Environment lines.'),
]

describe('LAYER_ORDER', () => {
  it('matches plan §16: shared → role → conventions → delivery → engine → skills → generated', () => {
    expect(LAYER_ORDER).toEqual([
      'shared',
      'role',
      'conventions',
      'delivery',
      'engine',
      'skills',
      'generated',
    ])
  })
})

describe('compileBundle', () => {
  it('lays the text out in LAYER_ORDER with "## layer/name" separators', () => {
    const { text } = compileBundle(bundle())
    expect(text).toBe(
      [
        '## shared/global\nVoice and hard rules.',
        '## shared/secrets\nNever ask for secrets.',
        '## role/implementer\nImplement the task.',
        '## conventions/team\nTeam conventions.',
        '## delivery/pr-evidence\nPRs carry evidence.',
        '## engine/claude\nEngine notes.',
        '## skills/review-budget\nReview within budget.',
        '## generated/env\nEnvironment lines.',
      ].join('\n\n'),
    )
  })

  it('returns the component hashes in composition order', () => {
    const { componentHashes } = compileBundle(bundle())
    expect(componentHashes).toEqual([
      componentHash('Voice and hard rules.'),
      componentHash('Never ask for secrets.'),
      componentHash('Implement the task.'),
      componentHash('Team conventions.'),
      componentHash('PRs carry evidence.'),
      componentHash('Engine notes.'),
      componentHash('Review within budget.'),
      componentHash('Environment lines.'),
    ])
  })

  it('pins a revision that is stable for the same input', () => {
    const first = compileBundle(bundle())
    const second = compileBundle(bundle())
    expect(second.revision).toBe(first.revision)
    expect(first.revision).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes the revision when any part changes', () => {
    const changed = bundle().map((c) =>
      c.layer === 'skills' ? { ...c, text: 'Review harder.', hash: componentHash('Review harder.') } : c,
    )
    expect(compileBundle(changed).revision).not.toBe(compileBundle(bundle()).revision)
  })

  it('throws without a role component', () => {
    const noRole = bundle().filter((c) => c.layer !== 'role')
    expect(() => compileBundle(noRole)).toThrow(/exactly one 'role' component, found 0/)
  })

  it('throws with two role components', () => {
    const twoRoles = [...bundle(), part('role', 'reviewer', 'Review the task.')]
    expect(() => compileBundle(twoRoles)).toThrow(/found 2/)
  })

  it('throws on a duplicate layer/name pair', () => {
    const duplicate = [...bundle(), part('skills', 'review-budget', 'A different text.')]
    expect(() => compileBundle(duplicate)).toThrow(/Duplicate bundle component 'skills\/review-budget'/)
  })

  it('throws when a user_override names no defaultBaseHash', () => {
    const override = part('conventions', 'team', 'Our conventions.', { origin: 'user_override' })
    const withoutTeam = bundle().filter((c) => c.layer !== 'conventions' || c.name !== 'team')
    expect(() => compileBundle([...withoutTeam, override])).toThrow(/names no defaultBaseHash/)
  })

  it('throws when a component hash does not match its text', () => {
    const lying = { ...part('skills', 'review-budget', 'Review within budget.'), hash: '0'.repeat(16) }
    const withoutSkill = bundle().filter((c) => c.layer !== 'skills')
    expect(() => compileBundle([...withoutSkill, lying])).toThrow(/hashes to/)
  })
})
