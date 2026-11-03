import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { IsolationProfile } from '@mec/contracts'
import { buildAttemptSettings, defaultDenyRead, serialiseAttemptSettings } from '../src/isolation'

const home = '/Users/tester'
const profile = (over: Partial<IsolationProfile> = {}): IsolationProfile => ({
  sandbox: 'required',
  read_only: false,
  allow_write: [],
  deny_read: [],
  allowed_domains: [],
  blocked_commands: [],
  background_cap_ms: 30 * 60_000,
  permission_mode: 'bridge',
  repo_trusted: false,
  ...over,
})

const opts = {
  worktree: '/Users/tester/.mec/work/att_1',
  tempDir: '/Users/tester/.mec/tmp/att_1',
  allowedDomains: ['registry.npmjs.org'],
  homeDir: home,
}

describe('defaultDenyRead', () => {
  it('covers MEC state, other slot homes and secret directories', () => {
    const deny = defaultDenyRead(home)
    expect(deny).toContain(`${home}/.mec/engines`)
    expect(deny).toContain(`${home}/.mec/db`)
    expect(deny).toContain(`${home}/.ssh`)
    expect(deny).toContain(`${home}/.aws`)
    expect(deny).toContain(`${home}/.config/gh`)
  })
})

describe('buildAttemptSettings', () => {
  it('sandbox required: enabled, failIfUnavailable, strict allowlist', () => {
    const s = buildAttemptSettings(profile(), opts)
    expect(s.sandbox.enabled).toBe(true)
    expect(s.sandbox.failIfUnavailable).toBe(true)
    expect(s.sandbox.allowUnsandboxedCommands).toBe(false)
    expect(s.sandbox.network.strictAllowlist).toBe(true)
    expect(s.sandbox.network.allowedDomains).toContain('registry.npmjs.org')
  })

  it('preferred degrades failIfUnavailable; off disables the sandbox', () => {
    expect(buildAttemptSettings(profile({ sandbox: 'preferred' }), opts).sandbox.failIfUnavailable).toBe(false)
    expect(buildAttemptSettings(profile({ sandbox: 'off' }), opts).sandbox.enabled).toBe(false)
  })

  it('worktree and temp are always writable; profile additions merge and dedupe', () => {
    const s = buildAttemptSettings(profile({ allow_write: [opts.worktree, '/tmp/extra'] }), opts)
    expect(s.sandbox.filesystem.allowWrite.filter((p) => p === opts.worktree)).toHaveLength(1)
    expect(s.sandbox.filesystem.allowWrite).toContain('/tmp/extra')
    expect(s.sandbox.filesystem.allowWrite).toContain(opts.tempDir)
  })

  it('profile deny_read merges with the defaults and dedupes', () => {
    const s = buildAttemptSettings(profile({ deny_read: [`${home}/.mec/engines`, '/private/extra'] }), opts)
    expect(s.sandbox.filesystem.denyRead.filter((p) => p === `${home}/.mec/engines`)).toHaveLength(1)
    expect(s.sandbox.filesystem.denyRead).toContain('/private/extra')
  })

  it('hooks are always disabled', () => {
    expect(buildAttemptSettings(profile(), opts).disableAllHooks).toBe(true)
  })

  it('the serialised form contains no credential-like string', async () => {
    const { matchesSecret } = await import('@mec/contracts')
    const text = serialiseAttemptSettings(buildAttemptSettings(profile(), opts))
    expect(matchesSecret(text)).toBe(false)
  })
})
