// Owner ruling, 7 November 2026: the repository's instructions reach the brief as information,
// labelled, redacted and bounded, with any cut said; neither file, nothing said.
import { describe, expect, it } from 'vitest'
import { INSTRUCTION_CHARS, instructionsPart } from '../src/repo-instructions'

const same = (text: string): string => text

describe("the repository's instructions in a brief", () => {
  it('neither file, or only empty ones, says nothing', () => {
    expect(instructionsPart([], same)).toBeUndefined()
    expect(instructionsPart([{ name: 'AGENTS.md', text: ' \n' }], same)).toBeUndefined()
  })

  it('each file is labelled as the repository’s, and MEC’s brief wins', () => {
    const part = instructionsPart([{ name: 'AGENTS.md', text: 'Keep commits small.\n' }], same) ?? ''
    expect(part).toMatch(/^The repository's own instructions, as information\./)
    expect(part).toContain("MEC's\nbrief wins")
    expect(part).toContain('AGENTS.md at the base:\nKeep commits small.')
  })

  it('a long file is cut at the bound and says how much it had', () => {
    const text = 'x'.repeat(INSTRUCTION_CHARS + 500)
    const part = instructionsPart([{ name: 'CLAUDE.md', text }], same) ?? ''
    expect(part).toContain(`the first ${INSTRUCTION_CHARS} of its ${INSTRUCTION_CHARS + 500} characters`)
    expect(part).not.toContain('x'.repeat(INSTRUCTION_CHARS + 1))
  })

  it('redaction runs before the bound, so a cut never splits a key into view', () => {
    const part = instructionsPart([{ name: 'CLAUDE.md', text: 'key SECRET here' }], (text) =>
      text.replaceAll('SECRET', '[redacted]'),
    )
    expect(part).toContain('key [redacted] here')
  })
})
