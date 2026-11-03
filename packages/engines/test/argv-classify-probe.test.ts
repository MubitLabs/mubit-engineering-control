import { describe, expect, it } from 'vitest'
import { buildClaudeArgv } from '../src/claude/argv'
import { probeClaude } from '../src/claude/probe'
import { classifyClaudeError } from '../src/claude/stream'

describe('buildClaudeArgv', () => {
  const base = {
    prompt: 'Add the audit log view',
    sessionId: 'session-1',
    settingsPath: '/wt/.mec/claude-settings.json',
    mcpConfigPath: '/wt/.mec/mcp.json',
    readOnly: false,
    permissionMode: 'bridge' as const,
    maxTurns: 12,
  }

  it('implements mode: headless stream-json with settings, strict mcp and the bridge', () => {
    const argv = buildClaudeArgv(base)
    expect(argv).toContain('-p')
    expect(argv).toEqual(
      expect.arrayContaining([
        '--output-format',
        'stream-json',
        '--settings',
        base.settingsPath,
        '--setting-sources',
        'user',
        '--strict-mcp-config',
        '--permission-prompt-tool',
        'mcp__mec__confirm',
        '--max-turns',
        '12',
      ]),
    )
    expect(argv).not.toContain('--restricted')
    expect(argv).not.toContain('--bare')
  })

  it('read-only roles: --restricted, no prompts, no bridge tool', () => {
    const argv = buildClaudeArgv({ ...base, readOnly: true, permissionMode: 'none' })
    expect(argv).toEqual(expect.arrayContaining(['--restricted', '--permission-prompts', 'none']))
    expect(argv).not.toContain('--permission-prompt-tool')
  })

  it('resume replaces --session-id; budget only when given; model when given', () => {
    const argv = buildClaudeArgv({
      ...base,
      resumeSessionId: 'session-9',
      maxBudgetUsd: 2.5,
      model: 'sonnet',
    })
    expect(argv).toEqual(expect.arrayContaining(['--resume', 'session-9']))
    expect(argv).not.toContain('--session-id')
    expect(argv).toEqual(expect.arrayContaining(['--max-budget-usd', '2.5', '--model', 'sonnet']))
  })
})

describe('classifyClaudeError', () => {
  it('maps the recorded failure shapes', () => {
    expect(classifyClaudeError('authentication_failed')).toBe('auth')
    expect(classifyClaudeError('Not logged in · Please run /login')).toBe('auth')
    expect(classifyClaudeError('usage limit reached')).toBe('quota')
    expect(classifyClaudeError('rate_limit_event rejected')).toBe('quota')
    expect(classifyClaudeError('API overloaded (529)')).toBe('provider_down')
    expect(classifyClaudeError('something odd')).toBe('unknown')
  })
})

describe('probeClaude', () => {
  it('parses version, verifies flags from --help and the auth status JSON', async () => {
    const run = async (cmd: string, args: readonly string[]) => {
      if (args[0] === '--version') return { code: 0, stdout: '2.1.317 (Claude Code)\n', stderr: '' }
      if (args[0] === '--help')
        return {
          code: 0,
          stdout:
            '-p --verbose --output-format --session-id --resume --settings --mcp-config --strict-mcp-config --permission-prompt-tool --max-turns',
          stderr: '',
        }
      return {
        code: 0,
        stdout: '{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "subscriptionType": "max"\n}\n',
        stderr: '',
      }
    }
    const { capabilities, auth } = await probeClaude(run)
    expect(capabilities.engine_version).toBe('2.1.317')
    expect(capabilities.flags_verified).toContain('--permission-prompt-tool')
    expect(capabilities.resume).toBe(true)
    expect(capabilities.usage_mode).toBe('cumulative')
    expect(auth).toEqual({ logged_in: true, method: 'claude.ai', detail: 'max' })
  })

  it('auth failure: logged_in false, no throw', async () => {
    const run = async (_cmd: string, args: readonly string[]) =>
      args[0] === 'auth'
        ? { code: 1, stdout: '{"loggedIn": false, "authMethod": "none"}', stderr: '' }
        : { code: 0, stdout: 'help text without flags', stderr: '' }
    const { auth, capabilities } = await probeClaude(run)
    expect(auth.logged_in).toBe(false)
    expect(capabilities.flags_verified).toEqual([])
    expect(capabilities.structured_stream).toBe(false)
  })
})
