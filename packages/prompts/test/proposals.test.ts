import { describe, expect, it } from 'vitest'
import type { BundleComponent, BundleLayer } from '../src'
import { componentHash, ProposalArea } from '../src'

const component = (
  name: string,
  text: string,
  origin: BundleComponent['origin'] = 'default',
): BundleComponent => ({
  layer: 'skills' as BundleLayer,
  name,
  text,
  hash: componentHash(text),
  origin,
})

describe('ProposalArea', () => {
  it('runs a propose → list → apply round-trip', () => {
    const area = new ProposalArea()
    const edit = component('review-budget', 'Review within two passes.')
    const { id } = area.propose('implementer-1', edit)
    expect(id).toMatch(/^prop_[1-9][0-9]*$/)
    expect(area.list()).toEqual([{ id, author: 'implementer-1', component: edit, status: 'proposed' }])
    expect(area.apply(id)).toEqual(edit)
  })

  it('no longer lists applied proposals; applying again is unknown', () => {
    const area = new ProposalArea()
    const { id } = area.propose('reviewer-1', component('review-budget', 'Two passes.'))
    area.apply(id)
    expect(area.list()).toEqual([])
    expect(area.apply(id)).toEqual({ error: 'unknown' })
  })

  it('answers an unknown id with an error, not a throw', () => {
    const area = new ProposalArea()
    expect(area.apply('prop_999')).toEqual({ error: 'unknown' })
  })

  it('keeps proposals in arrival order', () => {
    const area = new ProposalArea()
    const first = area.propose('agent-a', component('a', 'First.'))
    const second = area.propose('agent-b', component('b', 'Second.'))
    expect(area.list().map((p) => p.id)).toEqual([first.id, second.id])
    expect(area.list().map((p) => p.author)).toEqual(['agent-a', 'agent-b'])
  })

  it('refuses a proposal whose hash does not match its text', () => {
    const area = new ProposalArea()
    const lying = { ...component('a', 'A.'), hash: '0'.repeat(16) }
    expect(() => area.propose('agent-a', lying)).toThrow(/does not hash to its own text/)
  })

  it('refuses an override proposal that names no base, and an anonymous author', () => {
    const area = new ProposalArea()
    const orphan = { ...component('a', 'A.', 'user_override') }
    delete orphan.defaultBaseHash
    expect(() => area.propose('agent-a', orphan)).toThrow(/names no defaultBaseHash/)
    expect(() => area.propose('', component('b', 'B.'))).toThrow(/must name its author/)
  })
})
