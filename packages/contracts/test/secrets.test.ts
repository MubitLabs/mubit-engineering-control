import { describe, expect, it } from 'vitest'
import { isSecretEnvName, matchesSecret, SECRET_PATTERNS } from '../src'
import { FAKE_KEYS } from './fake-keys'

describe('SECRET_PATTERNS', () => {
  it.each(SECRET_PATTERNS.map((p) => [p.name, p.pattern] as const))(
    '%s matches its key format',
    (name, re) => {
      expect(re.test(`key: ${FAKE_KEYS[name]}`)).toBe(true)
    },
  )

  it('has a fake key for every pattern', () => {
    expect(Object.keys(FAKE_KEYS).sort()).toEqual(SECRET_PATTERNS.map((p) => p.name).sort())
  })

  it('leaves ordinary text alone', () => {
    for (const text of [
      'MEC pre-flight smoke ok.',
      'use sk-learn-compatible-estimators-for-this-task',
      `commit ${'0123456789abcdef'.repeat(2)}01234567 is on main`,
      'the api key lives in the slot keystore',
      'ghp_short',
    ]) {
      expect(matchesSecret(text), text).toBe(false)
    }
  })
})

describe('isSecretEnvName', () => {
  it('flags names containing KEY, PASSWORD, SECRET or TOKEN in any case', () => {
    for (const name of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'db_password', 'CLIENT_SECRET', 'MONKEY']) {
      expect(isSecretEnvName(name), name).toBe(true)
    }
  })

  it('passes ordinary names', () => {
    for (const name of ['PATH', 'HOME', 'MEC_TASK', 'MEC_TOOLS_URL', 'LANG']) {
      expect(isSecretEnvName(name), name).toBe(false)
    }
  })
})
