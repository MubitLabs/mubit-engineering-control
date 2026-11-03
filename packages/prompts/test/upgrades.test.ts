import { describe, expect, it } from 'vitest'
import type { BundleComponent, BundleLayer, ComponentText, Decision } from '../src'
import { componentHash, planUpgrades } from '../src'

const shipped = (layer: BundleLayer, name: string, text: string): ComponentText => ({
  layer,
  name,
  text,
  hash: componentHash(text),
})

const component = (
  layer: BundleLayer,
  name: string,
  text: string,
  origin: BundleComponent['origin'] = 'default',
  defaultBaseHash?: string,
): BundleComponent => ({ layer, name, text, hash: componentHash(text), origin, defaultBaseHash })

// One shipped part that changes between releases, plus its two versions.
const previousDefault = shipped('delivery', 'pr-evidence', 'PRs carry evidence.')
const newDefault = shipped('delivery', 'pr-evidence', 'PRs carry evidence, checks and UI proof.')

const planOne = (
  current: readonly BundleComponent[],
  previousDefaults: readonly ComponentText[] = [previousDefault],
  newDefaults: readonly ComponentText[] = [newDefault],
): Decision | undefined => planUpgrades({ current, previousDefaults, newDefaults })[0]

describe('planUpgrades', () => {
  it('keeps (and so removes) an override identical to the new default', () => {
    const override = component(
      'delivery',
      'pr-evidence',
      newDefault.text,
      'user_override',
      previousDefault.hash,
    )
    // 'keep' tells the caller to drop the override row: the part follows future defaults (§16.2).
    expect(planOne([override])).toEqual({ action: 'keep' })
  })

  it('applies a clean rebase: the override text stands, its base moves to the new default', () => {
    const override = component(
      'delivery',
      'pr-evidence',
      'PRs carry our own evidence.',
      'user_override',
      previousDefault.hash,
    )
    const decision = planOne([override])
    expect(decision).toEqual({
      action: 'apply',
      updated: { ...override, defaultBaseHash: newDefault.hash },
    })
  })

  it("preserves a stale-base override verbatim as a draft with reason 'stale base'", () => {
    const olderBase = shipped('delivery', 'pr-evidence', 'PRs carry a diff.')
    const override = component(
      'delivery',
      'pr-evidence',
      'PRs carry our own evidence.',
      'user_override',
      olderBase.hash,
    )
    const decision = planOne([override])
    expect(decision).toEqual({ action: 'draft', draft: override, reason: 'stale base' })
    expect(decision).toMatchObject({ draft: { text: 'PRs carry our own evidence.' } })
    expect(decision).toMatchObject({ draft: { defaultBaseHash: olderBase.hash } })
  })

  it('preserves an override without any base hash as a draft too — never lose the text', () => {
    const orphan = { ...component('delivery', 'pr-evidence', 'Our evidence.', 'user_override') }
    delete orphan.defaultBaseHash
    expect(planOne([orphan])).toEqual({ action: 'draft', draft: orphan, reason: 'stale base' })
  })

  it('adopts the new default for a part the user never overrode', () => {
    const decision = planOne([component('delivery', 'pr-evidence', previousDefault.text)])
    expect(decision).toEqual({ action: 'apply', updated: { ...newDefault, origin: 'default' } })
  })

  it('keeps an unchanged default that merely reappears in the new defaults', () => {
    const sameAgain = shipped('delivery', 'pr-evidence', previousDefault.text)
    expect(planOne([component('delivery', 'pr-evidence', previousDefault.text)], [], [sameAgain])).toEqual({
      action: 'keep',
    })
  })

  it('keeps parts with no shipped change for their layer/name', () => {
    const untouched = component('shared', 'global', 'Voice and hard rules.')
    expect(planOne([untouched])).toEqual({ action: 'keep' })
  })

  it('applies idempotently when the override already names the new default as its base', () => {
    const alreadyRebased = component(
      'delivery',
      'pr-evidence',
      'PRs carry our own evidence.',
      'user_override',
      newDefault.hash,
    )
    const decision = planOne([alreadyRebased])
    expect(decision).toEqual({ action: 'apply', updated: alreadyRebased })
  })

  it('surfaces a delivery-specific part with a changed default as an upgrade check, not an action', () => {
    const specific = component(
      'delivery',
      'pr-evidence',
      'Evidence rules for this delivery.',
      'delivery_specific',
    )
    expect(planOne([specific])).toEqual({ component: specific, previousDefault, newDefault })
    const decision = planOne([specific])
    expect('action' in (decision ?? {})).toBe(false)
  })

  it('returns one decision per component, in input order', () => {
    const shared = component('shared', 'global', 'Voice and hard rules.')
    const overridden = component(
      'delivery',
      'pr-evidence',
      'PRs carry our own evidence.',
      'user_override',
      previousDefault.hash,
    )
    const plain = component('delivery', 'pr-evidence', previousDefault.text)
    const decisions = planUpgrades({
      current: [shared, overridden, plain],
      previousDefaults: [previousDefault],
      newDefaults: [newDefault],
    })
    expect(decisions).toHaveLength(3)
    expect(decisions[0]).toEqual({ action: 'keep' })
    expect(decisions[1]).toMatchObject({ action: 'apply' })
    expect(decisions[2]).toMatchObject({ action: 'apply' })
  })
})
