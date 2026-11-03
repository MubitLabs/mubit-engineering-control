/**
 * The API-key courier — plan §5.4/§5.7.
 *
 * User-owned API keys (Gemini, GLM, Anthropic API, OpenAI API) are pasted once into
 * the Slots panel and land here — `<slotHome>/keys/<provider>.key`, mode 0600 — and
 * in nothing else. The database keeps only a fingerprint (provider, last four
 * characters, SHA-256 of the key with a per-install salt) for display and
 * exact-match redaction.
 *
 * Custody rules baked into the API:
 * - The key never appears in any return value, error message or log this module
 *   produces; only `read` hands it back, for the three §5.4 code paths (launch,
 *   zero-token validity probe, redaction filter) plus this layer's own
 *   fingerprint bookkeeping.
 * - `store` refuses to clobber an existing key; `rotate` is the replacing path
 *   (§5.7: "rotating a key replaces the keystore file and re-probes").
 * - `shred` scrambles the file's bytes before unlinking, so the cleartext does not
 *   linger in place (§5.7: "deleting a slot shreds its keystore").
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KeyFingerprint, ProviderId } from '@mec/contracts'

const KEY_MODE = 0o600
const DIR_MODE = 0o700
const SALT_BYTES = 32

export class SlotKeystore {
  private readonly keysDir: string
  private readonly saltPath: string
  private saltCache: string | undefined

  constructor(slotHome: string) {
    this.keysDir = join(slotHome, 'keys')
    this.saltPath = join(this.keysDir, '.salt')
  }

  /** Writes a new key; refuses when one already exists (use `rotate`). */
  store(provider: ProviderId, key: string): KeyFingerprint {
    if (existsSync(this.keyPath(provider))) {
      throw new Error(`a key for '${provider}' already exists in this slot — use rotate()`)
    }
    return this.write(provider, key)
  }

  /** The key itself, or undefined when none is stored. One of the three §5.4 read paths. */
  read(provider: ProviderId): string | undefined {
    return this.readRaw(this.keyPath(provider))
  }

  /** Replaces the key (create or overwrite) and returns the new fingerprint. */
  rotate(provider: ProviderId, key: string): KeyFingerprint {
    return this.write(provider, key)
  }

  /** Scrambles then unlinks the key file; an absent key is a no-op. */
  shred(provider: ProviderId): void {
    const path = this.keyPath(provider)
    if (!existsSync(path)) return
    const key = this.readRaw(path)
    if (key !== undefined && key !== '') {
      try {
        writeFileSync(path, randomBytes(key.length), { mode: KEY_MODE })
      } catch {
        // Best-effort scramble; the unlink below is what removes the key.
      }
    }
    unlinkSync(path)
  }

  /** The DB-facing fingerprint, recomputed from the stored key; undefined when absent. */
  fingerprint(provider: ProviderId): KeyFingerprint | undefined {
    const key = this.read(provider)
    return key === undefined ? undefined : this.fingerprintOf(provider, key)
  }

  private keyPath(provider: ProviderId): string {
    return join(this.keysDir, `${provider}.key`)
  }

  private write(provider: ProviderId, key: string): KeyFingerprint {
    if (key === '') throw new Error(`refusing to store an empty key for '${provider}'`)
    mkdirSync(this.keysDir, { recursive: true, mode: DIR_MODE })
    writeFileSync(this.keyPath(provider), key, { mode: KEY_MODE })
    return this.fingerprintOf(provider, key)
  }

  /**
   * The per-install salt, created once and persisted at `<slotHome>/keys/.salt`
   * (0600) so fingerprints stay comparable across processes and restarts — and so
   * the hash cannot be precomputed against a known salt.
   */
  private salt(): string {
    if (this.saltCache !== undefined) return this.saltCache
    const existing = this.readRaw(this.saltPath)
    if (existing !== undefined && existing !== '') {
      this.saltCache = existing
      return existing
    }
    mkdirSync(this.keysDir, { recursive: true, mode: DIR_MODE })
    const salt = randomBytes(SALT_BYTES).toString('hex')
    writeFileSync(this.saltPath, salt, { mode: KEY_MODE })
    this.saltCache = salt
    return salt
  }

  private fingerprintOf(provider: ProviderId, key: string): KeyFingerprint {
    const hash = createHash('sha256').update(`${key}${this.salt()}`).digest('hex')
    return { provider, last4: key.slice(-4), hash }
  }

  private readRaw(path: string): string | undefined {
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
}
