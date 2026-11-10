import { describe, expect, it } from 'vitest'
import { yieldToDuplicate } from '../src'

const A1 = '1'.repeat(40)
const A2 = '2'.repeat(40)
const B1 = '3'.repeat(40)

describe('yieldToDuplicate (§14: the same commits or the same diff)', () => {
  it('yields to the branch whose content equals ours for every changed file', () => {
    const decision = yieldToDuplicate({
      changedFiles: [
        { path: 'src/a.ts', blob: A1 },
        { path: 'src/b.ts', blob: B1 },
      ],
      existingBranches: [
        {
          name: 'human-fix',
          files: [
            { path: 'src/a.ts', blob: A1 },
            { path: 'src/b.ts', blob: B1 },
            { path: 'src/c.ts', blob: A2 },
          ],
        },
      ],
    })
    expect(decision).toEqual({ yield: true, branch: 'human-fix' })
  })

  it('never yields when the other side merely touches every changed path: different content is different work', () => {
    // The live fault (10 November 2026): a horse-tinder site and a home page both add index.html and style.css.
    const decision = yieldToDuplicate({
      changedFiles: [
        { path: 'index.html', blob: A1 },
        { path: 'style.css', blob: B1 },
      ],
      existingBranches: [
        {
          name: 'mec/mw9kvv16/integration',
          files: [
            { path: 'index.html', blob: A2 },
            { path: 'style.css', blob: B1 },
          ],
        },
      ],
    })
    expect(decision).toEqual({ yield: false })
  })

  it('a deletion matches only a deletion of the same path', () => {
    const ours = [{ path: 'old.ts', blob: null }]
    expect(
      yieldToDuplicate({ changedFiles: ours, existingBranches: [{ name: 'gone', files: ours }] }),
    ).toEqual({ yield: true, branch: 'gone' })
    expect(
      yieldToDuplicate({
        changedFiles: ours,
        existingBranches: [{ name: 'edited', files: [{ path: 'old.ts', blob: A1 }] }],
      }),
    ).toEqual({ yield: false })
  })

  it('yields to a branch that already contains our commits, whatever its file list says', () => {
    const decision = yieldToDuplicate({
      changedFiles: [{ path: 'src/a.ts', blob: A1 }],
      existingBranches: [{ name: 'carries-ours', files: [], containsHead: true }],
    })
    expect(decision).toEqual({ yield: true, branch: 'carries-ours' })
  })

  it('picks the first duplicate when several qualify', () => {
    const files = [{ path: 'src/a.ts', blob: A1 }]
    const decision = yieldToDuplicate({
      changedFiles: files,
      existingBranches: [
        { name: 'first', files },
        { name: 'second', files },
      ],
    })
    expect(decision).toEqual({ yield: true, branch: 'first' })
  })

  it('does not yield on partial overlap: related work is not the change', () => {
    const decision = yieldToDuplicate({
      changedFiles: [
        { path: 'src/a.ts', blob: A1 },
        { path: 'src/b.ts', blob: B1 },
      ],
      existingBranches: [{ name: 'related', files: [{ path: 'src/a.ts', blob: A1 }] }],
    })
    expect(decision).toEqual({ yield: false })
  })

  it('never yields on an empty change set', () => {
    const decision = yieldToDuplicate({
      changedFiles: [],
      existingBranches: [{ name: 'anything', files: [{ path: 'src/a.ts', blob: A1 }], containsHead: true }],
    })
    expect(decision).toEqual({ yield: false })
  })

  it('does not yield when no branch touches the change', () => {
    const decision = yieldToDuplicate({
      changedFiles: [{ path: 'src/a.ts', blob: A1 }],
      existingBranches: [{ name: 'elsewhere', files: [{ path: 'docs/x.md', blob: A1 }] }],
    })
    expect(decision).toEqual({ yield: false })
  })
})
