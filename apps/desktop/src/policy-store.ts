/**
 * The saved policy (§13, §18, handoff M3.3): one revisioned doc under `settings/policy` in the
 * engines kind, written only here. The text is the policy file's JSON; its version hash is the
 * sha-256 `loadPolicy` computes, so what this module shows is what a mandate pins.
 *
 * A save takes effect at the next start: composition reads this doc at boot and the meta service
 * reads policy at construction. The running server's text stays the one it started with, and
 * `readPolicy` reports both so the screen can say which is in force.
 */
import type { Store, StoreDoc } from '@mec/contracts'
import { matchesSecret } from '@mec/contracts'
import { loadPolicy } from '@mec/policy'

export const POLICY_DOC_ID = 'settings/policy'
const POLICY_STREAM = 'policy'

export type PolicyRecord = {
  text: string
  sha256: string
  revision: number
  source: 'saved' | 'default'
  updatedAt?: string
}

export type PolicySave =
  | { status: 'saved'; record: PolicyRecord }
  | { status: 'invalid'; detail: string }
  | { status: 'stale'; currentSha256: string }

function savedDoc(store: Store): (StoreDoc & { text: string; revision: number }) | undefined {
  const doc = store.engines.get(POLICY_DOC_ID)
  if (doc === undefined || typeof doc.text !== 'string') return undefined
  return { ...doc, text: doc.text, revision: typeof doc.revision === 'number' ? doc.revision : 0 }
}

/** The text to start with, or undefined. One that no longer loads falls back: nothing pre-authorised. */
export function savedPolicyText(store: Store): string | undefined {
  const doc = savedDoc(store)
  if (doc === undefined) return undefined
  try {
    loadPolicy(doc.text)
    return doc.text
  } catch {
    return undefined
  }
}

/** The saved record, or the text the server started with when nothing has been saved. */
export function readPolicy(store: Store, fallbackText: string): PolicyRecord {
  const doc = savedDoc(store)
  if (doc === undefined) {
    return {
      text: fallbackText,
      sha256: loadPolicy(fallbackText).versionHash,
      revision: 0,
      source: 'default',
    }
  }
  return {
    text: doc.text,
    sha256: loadPolicy(doc.text).versionHash,
    revision: doc.revision,
    source: 'saved',
    ...(typeof doc.updatedAt === 'string' && { updatedAt: doc.updatedAt }),
  }
}

/** The one write path. Validates, then compares the base; a refusal writes nothing. */
export function savePolicy(
  store: Store,
  input: { text: string; baseSha256: string; fallbackText: string; at: string; origin: 'panel' | 'draft' },
): PolicySave {
  // Redaction before durability: a key-shaped string is refused outright, the text never stored.
  if (matchesSecret(input.text)) return { status: 'invalid', detail: 'the text carries a key-shaped string' }
  let sha256: string
  try {
    sha256 = loadPolicy(input.text).versionHash
  } catch (error) {
    return { status: 'invalid', detail: error instanceof Error ? error.message : 'the policy did not load' }
  }
  const current = readPolicy(store, input.fallbackText)
  if (current.sha256 !== input.baseSha256) return { status: 'stale', currentSha256: current.sha256 }

  const revision = current.revision + 1
  store.atomic(() => {
    store.engines.save({
      id: POLICY_DOC_ID,
      text: input.text,
      revision,
      updatedAt: input.at,
    })
    const seq = (store.events.read(POLICY_STREAM).at(-1)?.seq ?? 0) + 1
    store.events.append(POLICY_STREAM, {
      stream: POLICY_STREAM,
      seq,
      at: input.at,
      type: 'policy_updated',
      body: { revision, sha256, origin: input.origin, at: input.at },
    })
  })
  return {
    status: 'saved',
    record: { text: input.text, sha256, revision, source: 'saved', updatedAt: input.at },
  }
}
