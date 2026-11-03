import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SlotKeystore } from '../src/keystore'

let slotHome: string

beforeEach(() => {
  slotHome = mkdtempSync(join(tmpdir(), 'mec-keystore-'))
})

afterEach(() => {
  rmSync(slotHome, { recursive: true, force: true })
})

const mode = (path: string): number => statSync(path).mode & 0o777

const KEY_A = 'not-a-real-key-zai-plan-aaaaaaaa1111'
const KEY_B = 'not-a-real-key-zai-plan-bbbbbbbb2222'

describe('slot keystore', () => {
  it('store writes the file 0600 and returns a fingerprint (provider, last4, 64 hex)', () => {
    const keystore = new SlotKeystore(slotHome)
    const fingerprint = keystore.store('zai-coding-plan', KEY_A)
    expect(fingerprint).toEqual({
      provider: 'zai-coding-plan',
      last4: KEY_A.slice(-4),
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    const file = join(slotHome, 'keys', 'zai-coding-plan.key')
    expect(readFileSync(file, 'utf8')).toBe(KEY_A)
    expect(mode(file)).toBe(0o600)
    expect(mode(join(slotHome, 'keys'))).toBe(0o700)
    expect(mode(join(slotHome, 'keys', '.salt'))).toBe(0o600)
  })

  it('read round-trips the stored key; an absent provider reads undefined', () => {
    const keystore = new SlotKeystore(slotHome)
    expect(keystore.read('google-gemini')).toBeUndefined()
    keystore.store('google-gemini', KEY_A)
    expect(keystore.read('google-gemini')).toBe(KEY_A)
    expect(keystore.fingerprint('google-gemini')?.last4).toBe(KEY_A.slice(-4))
    expect(keystore.fingerprint('zai-coding-plan')).toBeUndefined()
  })

  it('rotate replaces the key and returns a new fingerprint', () => {
    const keystore = new SlotKeystore(slotHome)
    const before = keystore.store('anthropic-api', KEY_A)
    const after = keystore.rotate('anthropic-api', KEY_B)
    expect(keystore.read('anthropic-api')).toBe(KEY_B)
    expect(after.last4).toBe(KEY_B.slice(-4))
    expect(after.hash).not.toBe(before.hash)
    expect(after.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('shred removes the key file', () => {
    const keystore = new SlotKeystore(slotHome)
    keystore.store('openai-api', KEY_A)
    keystore.shred('openai-api')
    expect(existsSync(join(slotHome, 'keys', 'openai-api.key'))).toBe(false)
    expect(keystore.read('openai-api')).toBeUndefined()
    expect(() => keystore.shred('openai-api')).not.toThrow()
  })

  it('the salt persists across instances: a reopened keystore recomputes the same hash', () => {
    const first = new SlotKeystore(slotHome)
    const fingerprint = first.store('zai-coding-plan', KEY_A)
    const reopened = new SlotKeystore(slotHome)
    expect(reopened.fingerprint('zai-coding-plan')).toEqual(fingerprint)
    // And a different install (different slot home) salts differently.
    const otherHome = mkdtempSync(join(tmpdir(), 'mec-keystore-other-'))
    try {
      const other = new SlotKeystore(otherHome)
      expect(other.store('zai-coding-plan', KEY_A).hash).not.toBe(fingerprint.hash)
    } finally {
      rmSync(otherHome, { recursive: true, force: true })
    }
  })

  it('store refuses to clobber an existing key, and no error or return value ever carries the key', () => {
    const keystore = new SlotKeystore(slotHome)
    keystore.store('zai-coding-plan', KEY_A)
    expect(() => keystore.store('zai-coding-plan', KEY_B)).toThrow(/rotate/)
    try {
      keystore.store('zai-coding-plan', KEY_B)
    } catch (error) {
      expect(String(error)).not.toContain(KEY_A)
      expect(String(error)).not.toContain(KEY_B)
    }
    expect(() => keystore.store('google-gemini', '')).toThrow(/empty key/)
  })
})
