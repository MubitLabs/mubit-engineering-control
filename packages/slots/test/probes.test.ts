import { describe, expect, it } from 'vitest'
import type { ProbeRun } from '../src/probes'
import { probeClaudeSlot, probeEngineVersion } from '../src/probes'

const runWith =
  (stdout: string, code = 0): ProbeRun =>
  async () => ({ code, stdout, stderr: '' })

const throwingRun: ProbeRun = async () => {
  throw new Error('spawn claude ENOENT')
}

describe('claude slot probe', () => {
  it('loggedIn true reports healthy with the non-secret identity', async () => {
    const stdout = JSON.stringify({
      loggedIn: true,
      authMethod: 'subscription',
      email: 'dev@example.com',
      subscriptionType: 'claude_max',
      configDirectory: '/x/engines/claude/max-1',
    })
    await expect(probeClaudeSlot(runWith(stdout), {})).resolves.toEqual({
      state: 'healthy',
      identity: { email: 'dev@example.com', plan: 'claude_max' },
    })
  })

  it('parses the JSON even behind a banner line', async () => {
    const stdout = `Claude Code v2.1.248\n${JSON.stringify({ loggedIn: true, email: 'dev@example.com' })}\n`
    await expect(probeClaudeSlot(runWith(stdout), {})).resolves.toEqual({
      state: 'healthy',
      identity: { email: 'dev@example.com' },
    })
  })

  it('loggedIn false reports degraded auth_expired (exit 1 is the vendor saying logged out)', async () => {
    const stdout = JSON.stringify({ loggedIn: false })
    await expect(probeClaudeSlot(runWith(stdout, 1), {})).resolves.toEqual({
      state: 'degraded',
      reason: 'auth_expired',
    })
  })

  it('unreadable output is degraded auth_expired, never healthy by default; a missing binary is engine_missing', async () => {
    await expect(probeClaudeSlot(runWith('garbage', 0), {})).resolves.toEqual({
      state: 'degraded',
      reason: 'auth_expired',
    })
    await expect(probeClaudeSlot(throwingRun, {})).resolves.toEqual({
      state: 'degraded',
      reason: 'engine_missing',
    })
  })

  it('runs the vendor command inside the slot env, verbatim', async () => {
    const seen: { cmd: string; args: readonly string[]; env?: Record<string, string> }[] = []
    const spy: ProbeRun = async (cmd, args, env) => {
      seen.push({ cmd, args, env })
      return { code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: '' }
    }
    const env = { CLAUDE_CONFIG_DIR: '/x/engines/claude/max-1' }
    await probeClaudeSlot(spy, env)
    await probeEngineVersion(spy, env)
    expect(seen).toEqual([
      { cmd: 'claude', args: ['auth', 'status'], env },
      { cmd: 'claude', args: ['--version'], env },
    ])
  })
})

describe('engine version probe', () => {
  it('returns the first stdout token of claude --version', async () => {
    await expect(probeEngineVersion(runWith('2.1.248 (Claude Code)\n'), {})).resolves.toBe('2.1.248')
  })

  it('engine_missing on a nonzero exit or an absent binary', async () => {
    await expect(probeEngineVersion(runWith('command not found', 127), {})).resolves.toBe('engine_missing')
    await expect(probeEngineVersion(throwingRun, {})).resolves.toBe('engine_missing')
    await expect(probeEngineVersion(runWith(''), {})).resolves.toBe('engine_missing')
  })
})
