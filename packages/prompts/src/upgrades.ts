/**
 * Default updates as reviewed candidates, plan §16.3: when a shipped default changes, every part
 * is re-planned against it — but nothing is mutated here. planUpgrades returns one decision per
 * component, and the caller (the server layer) turns 'apply' decisions into proposals the user
 * accepts: agents propose, only the user applies. No override text is ever lost — one written on
 * a base the upgrade can no longer rebase onto is preserved verbatim as a draft.
 *
 * 'keep' means two things, both no-ops for the compiled text: a part with no shipped change
 * carries over exactly as it is, and a user_override identical to the new default is *removed*
 * so the part follows future defaults (§16.2). The caller distinguishes them the same way this
 * function does: by whether a new default exists for the part.
 */

import type { BundleComponent, ComponentText } from './bundles'

/**
 * Everything the UI needs to surface one pending upgrade (§16.3): the affected part, the
 * previous default and the new default — a diff against each. Null when nothing needs attention.
 */
export type UpgradeCheck = {
  component: BundleComponent
  previousDefault: ComponentText
  newDefault: ComponentText
} | null

/**
 * One decision per input component: adopt or rebase ('apply' — a candidate, still user-applied),
 * preserve as a draft, keep as-is, or surface for review (the UpgradeCheck shape, no action —
 * a human weighs it; it is neither safe to adopt nor right to draft away).
 */
export type Decision =
  | { action: 'apply'; updated: BundleComponent }
  | { action: 'draft'; draft: BundleComponent; reason: string }
  | { action: 'keep' }
  | Exclude<UpgradeCheck, null>

export type UpgradeInput = {
  current: readonly BundleComponent[]
  previousDefaults: readonly ComponentText[]
  newDefaults: readonly ComponentText[]
}

/** Key defaults by part; with duplicates in a list the later entry wins (callers pass one per part). */
function byPart(list: readonly ComponentText[]): Map<string, ComponentText> {
  const map = new Map<string, ComponentText>()
  for (const part of list) {
    map.set(`${part.layer}/${part.name}`, part)
  }
  return map
}

export function planUpgrades(input: UpgradeInput): Decision[] {
  const previous = byPart(input.previousDefaults)
  const next = byPart(input.newDefaults)
  return input.current.map((component): Decision => {
    const newDefault = next.get(`${component.layer}/${component.name}`)
    if (newDefault === undefined) {
      // No shipped change for this part: it carries over exactly as it is.
      return { action: 'keep' }
    }
    if (component.origin === 'default') {
      // Parts without overrides follow new defaults (§16.3); an unchanged default stays put.
      if (component.text === newDefault.text) {
        return { action: 'keep' }
      }
      return { action: 'apply', updated: { ...newDefault, origin: 'default' } }
    }
    if (component.origin === 'delivery_specific') {
      // Specialised for one delivery: neither adopted nor rebased silently — surface both diffs
      // (the previous default may be part of why it differs).
      const previousDefault = previous.get(`${component.layer}/${component.name}`)
      if (previousDefault === undefined) {
        return { action: 'draft', draft: component, reason: 'no previous default to diff against' }
      }
      return { component, previousDefault, newDefault }
    }
    // A user override whose part has a shipped change.
    if (component.text === newDefault.text) {
      // Identical to the new default: the override is removed so the part follows future
      // defaults (§16.2). The compiled text is unchanged either way.
      return { action: 'keep' }
    }
    const base = component.defaultBaseHash
    if (base === previous.get(`${component.layer}/${component.name}`)?.hash || base === newDefault.hash) {
      // Written on the previous default — or already on the new one: the upgrade applies cleanly
      // on top. The override text stands; its base becomes the new default's hash.
      return { action: 'apply', updated: { ...component, defaultBaseHash: newDefault.hash } }
    }
    // Written on a different base (or none): rebasing would silently lose the user's context.
    // Preserve the override verbatim as a draft — never lose the draft.
    return { action: 'draft', draft: component, reason: 'stale base' }
  })
}
