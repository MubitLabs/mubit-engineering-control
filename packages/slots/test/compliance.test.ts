import { describe, expect, it } from 'vitest'
import { scanSourceForViolations } from '../src/compliance'

describe('compliance guard (§5.11/§22)', () => {
  it('flags a readFile of .credentials.json', () => {
    const violations = scanSourceForViolations([
      {
        path: 'src/evil.ts',
        text: "const raw = fs.readFileSync(join(home, '.credentials.json'), 'utf8')",
      },
    ])
    expect(violations).toEqual([
      { path: 'src/evil.ts', line: 1, pattern: expect.stringContaining('credentials') },
    ])
  })

  it('flags a read of a slot keystore path', () => {
    const violations = scanSourceForViolations([
      {
        path: 'src/keys.ts',
        text: "const key = fs.readFileSync('/root/.mec/engines/claude/keys/zai-coding-plan.key', 'utf8')",
      },
    ])
    expect(violations).toEqual([{ path: 'src/keys.ts', line: 1, pattern: expect.stringContaining('keys') }])
  })

  it('sees read markers on an adjacent line (multi-line calls)', () => {
    const violations = scanSourceForViolations([
      {
        path: 'src/multiline.ts',
        text: ['const raw = createReadStream(', "  join(slot, '.credentials.json'),", ')'].join('\n'),
      },
    ])
    expect(violations.map((v) => v.line)).toEqual([2])
  })

  it('flags macOS Keychain reads (security find-generic-password / dump-keychain)', () => {
    const violations = scanSourceForViolations([
      {
        path: 'src/keychain.ts',
        text: [
          '// probe the macOS credential store',
          'exec(\'security find-generic-password -w -s "Claude Code keychain item"\')',
          "exec('security dump-keychain')",
        ].join('\n'),
      },
    ])
    expect(violations).toEqual([
      { path: 'src/keychain.ts', line: 2, pattern: expect.stringContaining('keychain') },
      { path: 'src/keychain.ts', line: 3, pattern: expect.stringContaining('keychain') },
    ])
  })

  it('passes harmless config reads', () => {
    expect(
      scanSourceForViolations([
        {
          path: 'src/fine.ts',
          text: "const cfg = JSON.parse(fs.readFileSync(join(home, 'settings.json'), 'utf8'))",
        },
        { path: 'src/also-fine.ts', text: "const db = open(join(dataDir, 'mec.db'))" },
      ]),
    ).toEqual([])
  })

  it('does not flag a forbidden path with no read nearby', () => {
    expect(
      scanSourceForViolations([
        { path: 'src/name-only.ts', text: "const CREDENTIALS_FILE = '.credentials.json'" },
      ]),
    ).toEqual([])
  })
})
