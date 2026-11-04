/**
 * Layered prompt bundles, plan §16: every prompt an agent runs is assembled from versioned parts
 * with provenance — shipped defaults, the user's overrides on top of a named default, and
 * delivery-specific sections — and compiled into a bundle whose revision pins exactly the text an
 * attempt ran with (§16.1: a compiled bundle is pinned to each attempt before launch).
 *
 * Composition order is fixed (§16.1): shared → role → conventions → delivery → engine → skills →
 * generated. Within a layer parts keep the order given here, so callers load parts in a canonical
 * order. The generated sections come last so an environment or policy change leaves the preceding
 * text unchanged and prompt caches stay warm (§16.1).
 */

import { createHash } from 'node:crypto'

/**
 * The seven layers a bundle is assembled from. `engine` carries the engine-specific notes for the
 * slot an attempt runs on (tool names, protocol quirks); `generated` carries per-attempt sections
 * compiled by the core (environment, slot health, policy, models) — review 2026-11-04 §6.1.
 */
export type BundleLayer = 'shared' | 'role' | 'conventions' | 'delivery' | 'engine' | 'skills' | 'generated'

/** A part's identity and text — the shape defaults, overrides and proposals are all made of. */
export type ComponentText = {
  layer: BundleLayer
  name: string
  text: string
  hash: string
}

/**
 * A part inside a bundle. `origin` records provenance (§16.2): 'default' ships with the app,
 * 'user_override' is the user's edit of a shipped default and names the default it was based on
 * through `defaultBaseHash`, 'delivery_specific' is a section specialised for one delivery.
 */
export type BundleComponent = ComponentText & {
  defaultBaseHash?: string
  origin: 'default' | 'user_override' | 'delivery_specific'
}

/** Composition order, plan §16.1. The compiled text follows this order layer by layer. */
export const LAYER_ORDER: readonly BundleLayer[] = [
  'shared',
  'role',
  'conventions',
  'delivery',
  'engine',
  'skills',
  'generated',
]

/** A compiled bundle: the revision an attempt pins, the assembled text, the ordered part hashes. */
export type CompiledBundle = {
  revision: string
  text: string
  componentHashes: string[]
}

/** The hash of a part's text: sha256, first 16 hex characters. The one definition of the rule. */
export function componentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

export function compileBundle(components: readonly BundleComponent[]): CompiledBundle {
  const roles = components.filter((c) => c.layer === 'role').length
  if (roles !== 1) {
    throw new Error(`A bundle needs exactly one 'role' component, found ${roles}`)
  }
  const seen = new Set<string>()
  for (const c of components) {
    const part = `${c.layer}/${c.name}`
    if (seen.has(part)) {
      throw new Error(`Duplicate bundle component '${part}'`)
    }
    seen.add(part)
    const computed = componentHash(c.text)
    if (c.hash !== computed) {
      throw new Error(`Component '${part}' carries hash '${c.hash}' but its text hashes to '${computed}'`)
    }
    if (c.origin === 'user_override' && c.defaultBaseHash === undefined) {
      throw new Error(`Component '${part}' overrides a default but names no defaultBaseHash`)
    }
  }
  const ordered = LAYER_ORDER.flatMap((layer) => components.filter((c) => c.layer === layer))
  if (ordered.length !== components.length) {
    throw new Error('A bundle component carries a layer outside LAYER_ORDER')
  }
  const componentHashes = ordered.map((c) => c.hash)
  const revision = createHash('sha256').update(componentHashes.join('\n'), 'utf8').digest('hex')
  const text = ordered.map((c) => `## ${c.layer}/${c.name}\n${c.text}`).join('\n\n')
  return { revision, text, componentHashes }
}
