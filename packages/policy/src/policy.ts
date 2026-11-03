/**
 * The executable policy document, plan §13: user-owned, deterministic, never written by an
 * agent, its version hash recorded with every mandate and plan. v0 keeps the file JSON — a
 * deliberate format choice so loading is dependency-free and exact-text hashing is trivial;
 * the plan's YAML file is a later serialisation of the same shape, not a schema change.
 */

import { createHash } from 'node:crypto'

/** Every class plan §13 names; always-confirm and confirm-by-default rows plus the rest. */
export type ConfirmationClass =
  | 'push'
  | 'pr_create'
  | 'pr_edit'
  | 'pr_merge'
  | 'branch_delete'
  | 'force_op'
  | 'install'
  | 'migration'
  | 'spend'
  | 'slot_switch'
  | 'unsandboxed'
  | 'close_own_pr'

/**
 * §13 "Always confirm": on by default and *cannot be turned off by policy* — `git push`,
 * PR create/edit/merge, branch delete, force operations. `loadPolicy` refuses a document
 * that tries to pre-authorise any of them, so no code path may skip the human.
 */
export const ALWAYS_CONFIRM: readonly ConfirmationClass[] = [
  'push',
  'pr_create',
  'pr_edit',
  'pr_merge',
  'branch_delete',
  'force_op',
]

/** One pre-authorisation: what it covers and how far (§13 "explicit policy entries, recorded per use"). */
export type PreAuthorisedEntry = {
  scope: 'repo' | 'work_item'
  repoId?: string
  maxUsd?: number
}

/** The parsed, validated policy document. `versionHash` is sha256 of the exact text. */
export type PolicyDoc = {
  versionHash: string
  capsOverride?: Record<string, number>
  preAuthorised: Partial<Record<ConfirmationClass, PreAuthorisedEntry[]>>
  /** Per-repo overrides that may only tighten (see `repoOverridesOnlyTighten`). */
  repoTightening?: Record<string, Partial<PolicyDoc['preAuthorised']>>
}

const CONFIRMATION_CLASSES: readonly ConfirmationClass[] = [
  ...ALWAYS_CONFIRM,
  'install',
  'migration',
  'spend',
  'slot_switch',
  'unsandboxed',
  'close_own_pr',
]

const ALLOWED_DOC_KEYS = new Set(['capsOverride', 'preAuthorised', 'repoTightening'])
const ALLOWED_ENTRY_KEYS = new Set(['scope', 'repoId', 'maxUsd'])

/**
 * v0 core throws plain Errors whose message starts with the contracts error code (§8,
 * `policy_violation`); the API layer maps them to `UserError` later — same discipline as
 * the domain package's transition errors.
 */
const policyViolation = (detail: string): Error => new Error(`policy_violation: ${detail}`)

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const unknownKeys = (value: Record<string, unknown>, allowed: Set<string>): string[] =>
  Object.keys(value).filter((key) => !allowed.has(key))

const validateEntry = (raw: unknown, where: string): PreAuthorisedEntry => {
  if (!isPlainObject(raw)) throw policyViolation(`${where} must be an object`)
  const unknownFields = unknownKeys(raw, ALLOWED_ENTRY_KEYS)
  if (unknownFields.length > 0)
    throw policyViolation(`${where} has unknown field(s) ${unknownFields.join(', ')}`)

  const { scope, repoId, maxUsd } = raw
  if (scope !== 'repo' && scope !== 'work_item')
    throw policyViolation(`${where}.scope must be 'repo' or 'work_item'`)
  if (repoId !== undefined && typeof repoId !== 'string')
    throw policyViolation(`${where}.repoId must be a string`)
  if (scope === 'repo' && repoId === undefined)
    throw policyViolation(`${where}: scope 'repo' must name its repoId`)
  if (maxUsd !== undefined && (typeof maxUsd !== 'number' || !Number.isFinite(maxUsd) || maxUsd < 0))
    throw policyViolation(`${where}.maxUsd must be a non-negative number`)

  return {
    scope,
    ...(repoId !== undefined && { repoId }),
    ...(maxUsd !== undefined && { maxUsd }),
  }
}

const validatePreAuthorised = (
  raw: unknown,
  where: string,
): Partial<Record<ConfirmationClass, PreAuthorisedEntry[]>> => {
  if (!isPlainObject(raw)) throw policyViolation(`${where} must be an object`)
  const result: Partial<Record<ConfirmationClass, PreAuthorisedEntry[]>> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!(CONFIRMATION_CLASSES as readonly string[]).includes(key))
      throw policyViolation(`${where} has unknown confirmation class '${key}'`)
    const cls = key as ConfirmationClass
    if (ALWAYS_CONFIRM.includes(cls))
      throw policyViolation(
        `${where}: class '${cls}' is always-confirm (§13) and can never be pre-authorised`,
      )
    if (!Array.isArray(value)) throw policyViolation(`${where}.${cls} must be an array`)
    result[cls] = value.map((entry, i) => validateEntry(entry, `${where}.${cls}[${i}]`))
  }
  return result
}

const validateCapsOverride = (raw: unknown): Record<string, number> => {
  if (!isPlainObject(raw)) throw policyViolation('capsOverride must be an object')
  const result: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      throw policyViolation(`capsOverride.${key} must be a non-negative number`)
    result[key] = value
  }
  return result
}

/**
 * Parse and validate a policy document. The document is authored by the user only (§13);
 * unknown fields are refused rather than ignored, so a typo can never silently loosen a
 * guardrail, and any attempt to pre-authorise an always-confirm class is a violation.
 * `versionHash` is the sha256 of the exact text, so formatting changes count as new versions.
 */
export function loadPolicy(text: string): PolicyDoc {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw policyViolation(
      `policy document is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  if (!isPlainObject(parsed)) throw policyViolation('policy document must be a JSON object')
  const unknownFields = unknownKeys(parsed, ALLOWED_DOC_KEYS)
  if (unknownFields.length > 0) throw policyViolation(`unknown field(s) ${unknownFields.join(', ')}`)

  // `versionHash` is derived, never stored: a hash inside the text it hashes is wrong by
  // construction, so its presence is an unknown field like any other.
  if (parsed.preAuthorised === undefined)
    throw policyViolation('preAuthorised is required (an empty object means none)')

  const preAuthorised = validatePreAuthorised(parsed.preAuthorised, 'preAuthorised')
  const capsOverride =
    parsed.capsOverride !== undefined ? validateCapsOverride(parsed.capsOverride) : undefined
  let repoTightening: Record<string, Partial<PolicyDoc['preAuthorised']>> | undefined
  if (parsed.repoTightening !== undefined) {
    if (!isPlainObject(parsed.repoTightening)) throw policyViolation('repoTightening must be an object')
    repoTightening = {}
    for (const [repoId, value] of Object.entries(parsed.repoTightening)) {
      repoTightening[repoId] = validatePreAuthorised(value, `repoTightening.${repoId}`)
    }
  }

  return {
    versionHash: createHash('sha256').update(text).digest('hex'),
    ...(capsOverride !== undefined && { capsOverride }),
    preAuthorised,
    ...(repoTightening !== undefined && { repoTightening }),
  }
}

/** Does `entry` cover at most what `base` covers — same scope or narrower, same repo or narrower, spend bound no higher? */
const entryNarrows = (entry: PreAuthorisedEntry, base: PreAuthorisedEntry): boolean => {
  const scopeNarrows = entry.scope === base.scope || (base.scope === 'repo' && entry.scope === 'work_item')
  const repoNarrows = base.repoId === undefined || entry.repoId === base.repoId
  const usdNarrows = base.maxUsd === undefined || (entry.maxUsd !== undefined && entry.maxUsd <= base.maxUsd)
  return scopeNarrows && repoNarrows && usdNarrows
}

/**
 * §13: per-repo overrides can only *tighten*. Every class the override still pre-authorises
 * must exist in the base with entries at least as broad; a class the base never granted is
 * an addition, a wider scope, another repo, or a raised spend bound is a refusal. Cap
 * ceilings follow the same rule: an override may lower or add a ceiling, never raise one.
 */
export function repoOverridesOnlyTighten(base: PolicyDoc, repo: PolicyDoc): boolean {
  for (const cls of Object.keys(repo.preAuthorised) as ConfirmationClass[]) {
    const repoEntries = repo.preAuthorised[cls] ?? []
    const baseEntries = base.preAuthorised[cls]
    if (baseEntries === undefined) return false
    if (!repoEntries.every((entry) => baseEntries.some((b) => entryNarrows(entry, b)))) return false
  }
  for (const [key, ceiling] of Object.entries(repo.capsOverride ?? {})) {
    const baseCeiling = base.capsOverride?.[key]
    if (baseCeiling !== undefined && ceiling > baseCeiling) return false
  }
  return true
}
