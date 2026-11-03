import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PolicyDoc, PreAuthorisedEntry } from '../src'
import { ALWAYS_CONFIRM, loadPolicy, repoOverridesOnlyTighten } from '../src'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const validDoc = JSON.stringify({
  capsOverride: { globalActiveAttempts: 2 },
  preAuthorised: {
    install: [{ scope: 'repo', repoId: 'github.com/acme/app' }],
    spend: [{ scope: 'repo', repoId: 'github.com/acme/app', maxUsd: 5 }],
    slot_switch: [{ scope: 'work_item' }],
  },
})

/** Hand-built docs for `repoOverridesOnlyTighten` — the function sees what loadPolicy validated. */
const doc = (
  preAuthorised: Partial<Record<string, PreAuthorisedEntry[]>>,
  capsOverride?: Record<string, number>,
): PolicyDoc => ({
  versionHash: '0'.repeat(64),
  ...(capsOverride !== undefined && { capsOverride }),
  preAuthorised: preAuthorised as PolicyDoc['preAuthorised'],
})

describe('loadPolicy', () => {
  it('refuses to pre-authorise an always-confirm class (§13: policy cannot turn them off)', () => {
    for (const cls of ALWAYS_CONFIRM) {
      const text = JSON.stringify({ preAuthorised: { [cls]: [{ scope: 'work_item' }] } })
      expect(() => loadPolicy(text), cls).toThrowError(/policy_violation: .*always-confirm/)
    }
  })

  it('round-trips a valid document and keeps the hash stable for the same text', () => {
    const first = loadPolicy(validDoc)
    const second = loadPolicy(validDoc)
    expect(first).toEqual(second)
    expect(first.versionHash).toBe(sha256(validDoc))
    expect(first.capsOverride).toEqual({ globalActiveAttempts: 2 })
    expect(first.preAuthorised).toEqual({
      install: [{ scope: 'repo', repoId: 'github.com/acme/app' }],
      spend: [{ scope: 'repo', repoId: 'github.com/acme/app', maxUsd: 5 }],
      slot_switch: [{ scope: 'work_item' }],
    })
  })

  it('counts formatting as a version: same shape, different text, different hash', () => {
    const reformatted = JSON.stringify(JSON.parse(validDoc), null, 2)
    expect(loadPolicy(reformatted).versionHash).toBe(sha256(reformatted))
    expect(loadPolicy(reformatted).versionHash).not.toBe(loadPolicy(validDoc).versionHash)
  })

  it('refuses unknown fields at every level', () => {
    expect(() => loadPolicy(JSON.stringify({ preAuthorised: {}, extra: 1 }))).toThrowError(
      /policy_violation: unknown field/,
    )
    expect(() =>
      loadPolicy(JSON.stringify({ preAuthorised: { pusher: [{ scope: 'work_item' }] } })),
    ).toThrowError(/unknown confirmation class 'pusher'/)
    expect(() =>
      loadPolicy(JSON.stringify({ preAuthorised: { install: [{ scope: 'work_item', who: 'me' }] } })),
    ).toThrowError(/unknown field\(s\) who/)
    expect(() =>
      loadPolicy(
        JSON.stringify({
          preAuthorised: {},
          repoTightening: { 'github.com/acme/app': { install: [{ nope: 1 }] } },
        }),
      ),
    ).toThrowError(/unknown field\(s\) nope/)
  })

  it('refuses malformed or missing structure', () => {
    expect(() => loadPolicy('{')).toThrowError(/not valid JSON/)
    expect(() => loadPolicy('[]')).toThrowError(/must be a JSON object/)
    expect(() => loadPolicy('{}')).toThrowError(/preAuthorised is required/)
    expect(() =>
      loadPolicy(JSON.stringify({ preAuthorised: { install: [{ scope: 'repo' }] } })),
    ).toThrowError(/scope 'repo' must name its repoId/)
    expect(() =>
      loadPolicy(JSON.stringify({ preAuthorised: { spend: [{ scope: 'work_item', maxUsd: -1 }] } })),
    ).toThrowError(/maxUsd must be a non-negative number/)
    expect(() =>
      loadPolicy(JSON.stringify({ preAuthorised: {}, capsOverride: { globalActiveAttempts: 'two' } })),
    ).toThrowError(/capsOverride.globalActiveAttempts must be a non-negative number/)
    // `versionHash` is derived from the exact text, so a stored one is an unknown field.
    expect(() => loadPolicy(JSON.stringify({ preAuthorised: {}, versionHash: '0'.repeat(64) }))).toThrowError(
      /unknown field/,
    )
  })

  it('applies the always-confirm rule inside repoTightening too', () => {
    expect(() =>
      loadPolicy(
        JSON.stringify({
          preAuthorised: {},
          repoTightening: { 'github.com/acme/app': { push: [{ scope: 'work_item' }] } },
        }),
      ),
    ).toThrowError(/always-confirm/)
  })
})

describe('repoOverridesOnlyTighten', () => {
  it('refuses an override that adds a class the base never granted', () => {
    const base = doc({ install: [{ scope: 'repo', repoId: 'r1' }] })
    expect(
      repoOverridesOnlyTighten(base, doc({ install: [{ scope: 'repo', repoId: 'r1' }], migration: [] })),
    ).toBe(false)
  })

  it('accepts an override that only removes classes', () => {
    const base = doc({
      install: [{ scope: 'repo', repoId: 'r1' }],
      spend: [{ scope: 'repo', repoId: 'r1', maxUsd: 5 }],
    })
    expect(repoOverridesOnlyTighten(base, doc({ install: [{ scope: 'repo', repoId: 'r1' }] }))).toBe(true)
    expect(repoOverridesOnlyTighten(base, doc({}))).toBe(true)
  })

  it('accepts narrowing a scope, refuses widening one', () => {
    const base = doc({ install: [{ scope: 'repo', repoId: 'r1' }] })
    expect(repoOverridesOnlyTighten(base, doc({ install: [{ scope: 'work_item', repoId: 'r1' }] }))).toBe(
      true,
    )
    expect(
      repoOverridesOnlyTighten(
        doc({ install: [{ scope: 'work_item' }] }),
        doc({ install: [{ scope: 'repo', repoId: 'r1' }] }),
      ),
    ).toBe(false)
  })

  it('refuses another repo, a raised spend bound and a dropped bound', () => {
    const base = doc({ spend: [{ scope: 'repo', repoId: 'r1', maxUsd: 5 }] })
    expect(repoOverridesOnlyTighten(base, doc({ spend: [{ scope: 'repo', repoId: 'r2', maxUsd: 5 }] }))).toBe(
      false,
    )
    expect(
      repoOverridesOnlyTighten(base, doc({ spend: [{ scope: 'repo', repoId: 'r1', maxUsd: 10 }] })),
    ).toBe(false)
    expect(repoOverridesOnlyTighten(base, doc({ spend: [{ scope: 'repo', repoId: 'r1' }] }))).toBe(false)
    expect(repoOverridesOnlyTighten(base, doc({ spend: [{ scope: 'repo', repoId: 'r1', maxUsd: 3 }] }))).toBe(
      true,
    )
  })

  it('never lets an override raise a cap ceiling', () => {
    const base = doc({ install: [{ scope: 'repo', repoId: 'r1' }] }, { globalActiveAttempts: 2 })
    expect(repoOverridesOnlyTighten(base, doc({}, { globalActiveAttempts: 4 }))).toBe(false)
    expect(repoOverridesOnlyTighten(base, doc({}, { globalActiveAttempts: 1, perSlot: 1 }))).toBe(true)
  })
})
