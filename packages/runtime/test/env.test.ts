import { describe, expect, it } from 'vitest'
import { buildAgentEnv, EnvValidationError } from '../src/env'

const home = '/mec/slots/s1/home'
const shimPath = '/mec/att/1/shim'
const shapedValue = `sk-ant-${'x'.repeat(24)}`

const seededInherited: Record<string, string | undefined> = {
  // allowlisted (§5.12)
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/Users/shankha',
  USER: 'shankha',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  LC_CTYPE: 'UTF-8',
  TERM: 'xterm-256color',
  TMPDIR: '/tmp',
  SSH_AUTH_SOCK: '/tmp/launch-abcd/Listeners',
  HTTP_PROXY: 'http://127.0.0.1:8888',
  HTTPS_PROXY: 'http://127.0.0.1:8888',
  NO_PROXY: 'localhost,127.0.0.1',
  http_proxy: 'http://127.0.0.1:8888',
  https_proxy: 'http://127.0.0.1:8888',
  no_proxy: 'localhost,127.0.0.1',
  XDG_RUNTIME_DIR: '/run/user/501',
  // scrubbed: credentials and vendor/XDG homes are simply not on the allowlist
  ANTHROPIC_API_KEY: 'sk-ant-test',
  ANTHROPIC_MODEL: 'claude-sonnet-4',
  CLAUDE_CONFIG_DIR: '/Users/shankha/.claude',
  OPENAI_API_KEY: 'sk-openai-test',
  CODEX_HOME: '/Users/shankha/.codex',
  GEMINI_API_KEY: 'AIza-test',
  GOOGLE_APPLICATION_CREDENTIALS: '/Users/shankha/gcp.json',
  ZAI_API_KEY: 'zai-test',
  ZHIPU_API_KEY: 'zhipu-test',
  OPENCODE_CONFIG_DIR: '/Users/shankha/.config/opencode',
  GH_TOKEN: 'ghp_short',
  GITHUB_TOKEN: 'ghp_short',
  XDG_CONFIG_HOME: '/Users/shankha/.config',
  XDG_DATA_HOME: '/Users/shankha/.local/share',
  XDG_STATE_HOME: '/Users/shankha/.local/state',
  XDG_CACHE_HOME: '/Users/shankha/.cache',
  MY_APP_PASSWORD: 'hunter2',
  AWS_SECRET_ACCESS_KEY: 'aws-test',
  NPM_TOKEN: 'npm_test',
  // ordinary shell names that are not allowlisted either
  SHELL: '/bin/zsh',
  TERM_PROGRAM: 'Apple_Terminal',
}

describe('buildAgentEnv', () => {
  it('matches the allowlist exactly: survivors + HOME + slot/attempt keys (§26 env-scrubbing)', () => {
    const env = buildAgentEnv({
      inherited: seededInherited,
      home,
      shimPath,
      slot: {
        CLAUDE_CONFIG_DIR: '/mec/slots/s1/home/.claude',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      attempt: {
        MEC_ATTEMPT_ID: 'att_0001',
        MEC_WORKTREE: '/mec/worktrees/wi-1',
        MEC_BASE_SHA: '0123456789abcdef0123456789abcdef01234567',
        MEC_TASK: 'task_0001',
        MEC_TOOLS_URL: 'http://127.0.0.1:8123/mcp',
        MEC_TOOLS_TOKEN: 'mec-bearer-att-0001',
        GIT_CONFIG_GLOBAL: '/mec/att/1/gitconfig',
        GIT_TERMINAL_PROMPT: '0',
      },
    })

    const expectedKeys = [
      // allowlisted survivors
      'USER',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'TERM',
      'TMPDIR',
      'SSH_AUTH_SOCK',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'no_proxy',
      'XDG_RUNTIME_DIR',
      'PATH',
      // always set by MEC
      'HOME',
      // slot layer
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      // attempt layer
      'MEC_ATTEMPT_ID',
      'MEC_WORKTREE',
      'MEC_BASE_SHA',
      'MEC_TASK',
      'MEC_TOOLS_URL',
      'MEC_TOOLS_TOKEN',
      'GIT_CONFIG_GLOBAL',
      'GIT_TERMINAL_PROMPT',
    ]
    expect(Object.keys(env).sort()).toEqual([...expectedKeys].sort())

    expect(env.HOME).toBe(home)
    expect(env.PATH).toBe('/mec/att/1/shim:/usr/local/bin:/usr/bin:/bin')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.XDG_CONFIG_HOME).toBeUndefined()
    expect(env.CLAUDE_CONFIG_DIR).toBe('/mec/slots/s1/home/.claude')
  })

  it('drops empty-string and undefined inherited values', () => {
    const env = buildAgentEnv({
      inherited: { USER: '', TERM: undefined, LANG: 'C' },
      home,
      attempt: {},
    })
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG'])
  })

  it('matches LC_ and proxy prefixes case-insensitively', () => {
    const env = buildAgentEnv({
      inherited: { lc_all: 'C.UTF-8', HTTP_proxy: 'http://127.0.0.1:9', no_Proxy: 'localhost' },
      home,
      attempt: {},
    })
    expect(Object.keys(env).sort()).toEqual(['HOME', 'HTTP_proxy', 'lc_all', 'no_Proxy'])
  })

  it('sets HOME from input, never from the inherited shell', () => {
    const env = buildAgentEnv({
      inherited: { HOME: '/Users/shankha' },
      home: '/mec/wt/home',
      attempt: {},
    })
    expect(env.HOME).toBe('/mec/wt/home')
  })

  describe('PATH construction', () => {
    it('prepends the shim directory to the inherited PATH', () => {
      const env = buildAgentEnv({
        inherited: { PATH: '/usr/bin:/bin' },
        home,
        shimPath: '/mec/shim',
        attempt: {},
      })
      expect(env.PATH).toBe('/mec/shim:/usr/bin:/bin')
    })

    it('keeps the inherited PATH when there is no shim', () => {
      const env = buildAgentEnv({
        inherited: { PATH: '/usr/bin:/bin' },
        home,
        attempt: {},
      })
      expect(env.PATH).toBe('/usr/bin:/bin')
    })

    it('uses the shim alone when no PATH is inherited', () => {
      const env = buildAgentEnv({ inherited: {}, home, shimPath: '/mec/shim', attempt: {} })
      expect(env.PATH).toBe('/mec/shim')
    })

    it('omits PATH when neither shim nor inherited PATH exists', () => {
      const env = buildAgentEnv({ inherited: {}, home, attempt: {} })
      expect('PATH' in env).toBe(false)
    })
  })

  describe('slot/attempt validation', () => {
    it("refuses a secret-named slot key ('ANTHROPIC_API_KEY')", () => {
      const fn = () =>
        buildAgentEnv({ inherited: {}, home, slot: { ANTHROPIC_API_KEY: 'sk-ant-test' }, attempt: {} })
      expect(fn).toThrow(EnvValidationError)
      expect(fn).toThrow(/ANTHROPIC_API_KEY/)
    })

    it("refuses a secret-named attempt key ('FOO_TOKEN')", () => {
      const fn = () => buildAgentEnv({ inherited: {}, home, attempt: { FOO_TOKEN: 'abc' } })
      expect(fn).toThrow(EnvValidationError)
      expect(fn).toThrow(/FOO_TOKEN/)
    })

    it('admits exactly MEC_TOOLS_TOKEN in the attempt layer', () => {
      const env = buildAgentEnv({ inherited: {}, home, attempt: { MEC_TOOLS_TOKEN: 'mec-bearer-att-1' } })
      expect(env.MEC_TOOLS_TOKEN).toBe('mec-bearer-att-1')
    })

    it('still refuses a secret-shaped MEC_TOOLS_TOKEN value', () => {
      const fn = () => buildAgentEnv({ inherited: {}, home, attempt: { MEC_TOOLS_TOKEN: shapedValue } })
      expect(fn).toThrow(EnvValidationError)
      expect(fn).toThrow(/MEC_TOOLS_TOKEN/)
    })

    it("refuses a secret-shaped value under a benign name ('NOTE')", () => {
      const fn = () => buildAgentEnv({ inherited: {}, home, slot: { NOTE: shapedValue }, attempt: {} })
      expect(fn).toThrow(EnvValidationError)
      expect(fn).toThrow(/NOTE/)
    })
  })

  it('lets the attempt layer override the slot layer on collision', () => {
    const env = buildAgentEnv({
      inherited: {},
      home,
      slot: { MEC_TASK: 'task_from_slot', CLAUDE_CONFIG_DIR: '/a' },
      attempt: { MEC_TASK: 'task_from_attempt' },
    })
    expect(env.MEC_TASK).toBe('task_from_attempt')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/a')
  })
})
