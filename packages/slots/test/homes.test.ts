import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeHome, codexHome, linkedDefault, opencodeHome } from '../src/homes'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mec-homes-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const mode = (path: string): number => statSync(path).mode & 0o777

describe('credential homes', () => {
  it('claude home sets CLAUDE_CONFIG_DIR to the slot dir and creates it 0o700', () => {
    const home = claudeHome(root, 'max-1')
    const dir = join(root, 'engines', 'claude', 'max-1')
    expect(home).toEqual({ engine: 'claude', homeDir: dir, env: { CLAUDE_CONFIG_DIR: dir } })
    expect(mode(dir)).toBe(0o700)
  })

  it('codex home sets CODEX_HOME to the slot dir, created 0o700 before launch', () => {
    const home = codexHome(root, 'codex-1')
    const dir = join(root, 'engines', 'codex', 'codex-1')
    expect(home).toEqual({ engine: 'codex', homeDir: dir, env: { CODEX_HOME: dir } })
    expect(mode(dir)).toBe(0o700)
  })

  it('opencode home sets the four XDG dirs plus OPENCODE_CONFIG_DIR, all created 0o700', () => {
    const home = opencodeHome(root, 'glm-1')
    const base = join(root, 'engines', 'opencode', 'glm-1')
    expect(home.engine).toBe('opencode')
    expect(home.homeDir).toBe(base)
    expect(home.env).toEqual({
      XDG_DATA_HOME: join(base, 'data'),
      XDG_CONFIG_HOME: join(base, 'config'),
      XDG_STATE_HOME: join(base, 'state'),
      XDG_CACHE_HOME: join(base, 'cache'),
      OPENCODE_CONFIG_DIR: join(base, 'config'),
    })
    for (const leaf of ['data', 'config', 'state', 'cache']) {
      expect(mode(join(base, leaf))).toBe(0o700)
    }
  })

  it('refuses slot names that could escape the slot root', () => {
    expect(() => claudeHome(root, '../evil')).toThrow(/invalid slot name/)
    expect(() => claudeHome(root, 'a/b')).toThrow(/invalid slot name/)
    expect(() => codexHome(root, '')).toThrow(/invalid slot name/)
    expect(() => opencodeHome(root, '.hidden')).toThrow(/invalid slot name/)
  })

  it('linkedDefault: claude runs with the env absent (issue #92252); codex/opencode have none in v0', () => {
    expect(linkedDefault('claude')).toEqual({
      engine: 'claude',
      homeDir: join(homedir(), '.claude'),
      env: {},
    })
    expect(linkedDefault('codex')).toBeNull()
    expect(linkedDefault('opencode')).toBeNull()
  })
})
