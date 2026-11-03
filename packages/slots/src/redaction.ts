/**
 * Redaction — plan §5.4 ("redaction before durability") and §22.
 *
 * Two layers:
 * - Pattern layer: the canonical key shapes, taken from the contracts mirror
 *   (`SECRET_PATTERNS`) and re-named to MEC provider ids, replaced with
 *   `[redacted:<name>]`.
 * - Exact layer: a fingerprint is a salted SHA-256 — one-way by design — so a
 *   fingerprint can never re-derive its key. The caller that transiently holds
 *   the key (one of the three §5.4 keystore read paths) passes it via `exacts`;
 *   in addition, a conservative last-four sweep over long, non-hex tokens catches
 *   key material whose format is not patterned. Redaction errs toward hiding:
 *   over-redaction is recoverable, a leaked key is not.
 */
import type { KeyFingerprint, ProviderId } from '@mec/contracts'
import { SECRET_PATTERNS } from '@mec/contracts'

/**
 * Pattern names are MEC provider ids where one exists (`google-gemini`,
 * `zai-coding-plan`), bare vendor names otherwise (`anthropic`, `openai`,
 * `github`). `anthropic` extends the union in the plan's sketch because
 * `ProviderId` has no bare-vendor member and both `anthropic-sub` and
 * `anthropic-api` share one key shape.
 */
export type ProviderKeyName = ProviderId | 'github' | 'openai' | 'anthropic'

/** contracts-mirror names → the names MEC redaction labels with. */
const CONTRACTS_NAME_MAP: Readonly<Record<string, ProviderKeyName>> = {
  anthropic: 'anthropic',
  'openai-scoped': 'openai',
  'openai-legacy': 'openai',
  google: 'google-gemini',
  'google-auth': 'google-gemini',
  zai: 'zai-coding-plan',
  github: 'github',
  'github-pat': 'github',
}

export const PROVIDER_KEY_PATTERNS: readonly { name: ProviderKeyName; pattern: RegExp }[] =
  SECRET_PATTERNS.map((entry) => {
    const name = CONTRACTS_NAME_MAP[entry.name]
    if (name === undefined) {
      throw new Error(`unmapped secret pattern '${entry.name}' in @mec/contracts — extend CONTRACTS_NAME_MAP`)
    }
    return { name, pattern: entry.pattern }
  })

const EXACT_LABEL = '[redacted:exact]'

/** Long tokens only; already-redacted labels are skipped, and pure-hex tokens are digests and SHAs, never a known key format. */
const LONG_TOKEN = /\S{20,}/g
const PURE_HEX = /^[0-9a-f]+$/i

export function redact(
  text: string,
  fingerprints: readonly KeyFingerprint[],
  exacts?: readonly string[],
): string {
  let out = text
  // 1. Exact keys first — most specific, and it protects the pattern pass from
  //    leaving a partial match of an unpatterned key behind.
  for (const key of exacts ?? []) {
    if (key !== '') out = out.replaceAll(key, EXACT_LABEL)
  }
  // 2. Known key shapes. The contracts patterns carry no `g` flag (stateless
  //    `test`), so redaction builds a global copy per use.
  for (const { name, pattern } of PROVIDER_KEY_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, 'g'), `[redacted:${name}]`)
  }
  // 3. Last-four sweep: any long, non-hex token ending in a fingerprinted key's
  //    last four characters is treated as that key.
  const last4 = new Set(fingerprints.map((fingerprint) => fingerprint.last4))
  if (last4.size > 0) {
    out = out.replace(LONG_TOKEN, (token) =>
      !token.startsWith('[') && !PURE_HEX.test(token) && last4.has(token.slice(-4)) ? EXACT_LABEL : token,
    )
  }
  return out
}
