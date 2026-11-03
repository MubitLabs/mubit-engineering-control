import { describe, expect, it } from 'vitest'
import { yieldToDuplicate } from '../src'

describe('yieldToDuplicate', () => {
  it('yields to the branch that contains every changed file', () => {
    const decision = yieldToDuplicate({
      changedFiles: ['src/a.ts', 'src/b.ts'],
      existingBranches: [{ name: 'human-fix', files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }],
    })
    expect(decision).toEqual({ yield: true, branch: 'human-fix' })
  })

  it('yields to an exactly matching branch', () => {
    const decision = yieldToDuplicate({
      changedFiles: ['src/a.ts'],
      existingBranches: [{ name: 'twin', files: ['src/a.ts'] }],
    })
    expect(decision).toEqual({ yield: true, branch: 'twin' })
  })

  it('picks the first containing branch when several qualify', () => {
    const decision = yieldToDuplicate({
      changedFiles: ['src/a.ts'],
      existingBranches: [
        { name: 'first', files: ['src/a.ts', 'other.ts'] },
        { name: 'second', files: ['src/a.ts'] },
      ],
    })
    expect(decision).toEqual({ yield: true, branch: 'first' })
  })

  it('does not yield on partial overlap: related work is not the change', () => {
    const decision = yieldToDuplicate({
      changedFiles: ['src/a.ts', 'src/b.ts'],
      existingBranches: [{ name: 'related', files: ['src/a.ts'] }],
    })
    expect(decision).toEqual({ yield: false })
  })

  it('never yields on an empty change set', () => {
    const decision = yieldToDuplicate({
      changedFiles: [],
      existingBranches: [{ name: 'anything', files: ['src/a.ts'] }],
    })
    expect(decision).toEqual({ yield: false })
  })

  it('does not yield when no branch touches the change', () => {
    const decision = yieldToDuplicate({
      changedFiles: ['src/a.ts'],
      existingBranches: [{ name: 'elsewhere', files: ['docs/x.md'] }],
    })
    expect(decision).toEqual({ yield: false })
  })
})
