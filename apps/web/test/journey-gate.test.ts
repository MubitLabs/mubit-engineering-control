import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import screens from '../playwright.config'
import { journeyMode, type ServerEnvInput, serverEnv } from './journey-gate'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const input = (fields: Partial<ServerEnvInput> = {}): ServerEnvInput => ({
  mode: 'fake',
  inherited: { PATH: '/usr/bin', TMPDIR: '/tmp/' },
  bin: '/scratch/bin',
  ownerHome: '/Users/owner',
  scratchHome: '/scratch/home',
  dataDir: '/scratch/home/.mec',
  gitConfig: '/scratch/gitconfig',
  ...fields,
})

describe('journeyMode', () => {
  it('is the fake CLI unless asked', () => {
    expect(journeyMode({})).toBe('fake')
    expect(journeyMode({ MEC_JOURNEY_REAL: '0' })).toBe('fake')
    expect(journeyMode({ MEC_REAL_ENGINE: '1' })).toBe('fake')
  })

  it('takes the real engine only on its own flag', () => {
    expect(journeyMode({ MEC_JOURNEY_REAL: '1' })).toBe('real')
    expect(journeyMode({ MEC_JOURNEY_REAL: '1', CI: 'false' })).toBe('real')
  })

  it('refuses a real pass on CI', () => {
    expect(() => journeyMode({ MEC_JOURNEY_REAL: '1', CI: 'true' })).toThrow(/never runs in CI/)
    expect(() => journeyMode({ MEC_JOURNEY_REAL: '1', CI: '1' })).toThrow(/never runs in CI/)
  })
})

describe('serverEnv', () => {
  it('fake: a scratch HOME, the scratch bin first, and the runner on', () => {
    expect(serverEnv(input())).toMatchObject({
      HOME: '/scratch/home',
      PATH: '/scratch/bin:/usr/bin',
      MEC_DATA_DIR: '/scratch/home/.mec',
      MEC_REAL_RUNNER: '1',
      GIT_CONFIG_GLOBAL: '/scratch/gitconfig',
    })
  })

  it('real: the owner HOME for the login, and still a scratch data dir', () => {
    expect(serverEnv(input({ mode: 'real' }))).toMatchObject({
      HOME: '/Users/owner',
      MEC_DATA_DIR: '/scratch/home/.mec',
    })
  })

  it("refuses the owner's data dir and anything inside it, in either mode", () => {
    for (const mode of ['fake', 'real'] as const) {
      expect(() => serverEnv(input({ mode, dataDir: '/Users/owner/.mec' }))).toThrow(/owner's data dir/)
      expect(() => serverEnv(input({ mode, dataDir: '/Users/owner/.mec/x' }))).toThrow(/owner's data dir/)
    }
    expect(serverEnv(input({ dataDir: '/Users/owner/.mec-scratch' })).MEC_DATA_DIR).toBe(
      '/Users/owner/.mec-scratch',
    )
  })

  it('carries in no MEC_ or GIT_ variable from the shell', () => {
    const env = serverEnv(
      input({
        inherited: { PATH: '/usr/bin', MEC_FAKE_ENGINE: '1', MEC_META_SLOT: '/x', GIT_DIR: '/y' },
      }),
    )
    expect(env.MEC_FAKE_ENGINE).toBeUndefined()
    expect(env.MEC_META_SLOT).toBeUndefined()
    expect(env.GIT_DIR).toBeUndefined()
  })
})

describe('the journey stays out of CI', () => {
  it('the screens suite, which the shared lock guards, does not match it', () => {
    const match = screens.testMatch as RegExp
    expect(match.test('next.screens.playwright.ts')).toBe(true)
    expect(match.test('journey.real.playwright.ts')).toBe(false)
  })

  it('no workflow names it or its flags', () => {
    const dir = `${ROOT}.github/workflows`
    const files = readdirSync(dir)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(`${dir}/${file}`, 'utf8')
      expect(text).not.toMatch(/journey|MEC_JOURNEY_REAL|MEC_REAL_SELF_APPROVAL|playwright test/)
    }
  })
})
