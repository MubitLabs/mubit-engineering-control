import { createHash } from 'node:crypto'
import type { Json } from '@mec/contracts'

/**
 * The specialist registry (plan §7): the built-in roster as editable prompt bundles, plus
 * ad-hoc task-specific roles ("AgentSpec, simplified"). Compiled roles are immutable — the
 * revision is the hash of the definition, so the same definition always yields the same
 * revision and running attempts stay pinned. The compiler validates tool registration,
 * check names and the policy budget ceiling; invalid proposals return actionable issues
 * (bounded repair happens in the meta agent; four consecutive failures escalate).
 */

export type BuiltinRole =
  | 'implementer'
  | 'test_author'
  | 'code_reviewer'
  | 'pr_reviewer'
  | 'security_checker'
  | 'integrator'
  | 'repair_agent'
  | 'release_agent'

/** §7: provider diversity is cheap — a role says which slot class it prefers. */
export type SlotClassPreference = 'same_engine_other_slot' | 'different_provider' | 'any_healthy'

export type ContextPolicy = 'task_only' | 'task_and_contract' | 'read_repo'

export type RoleDef = {
  name: string
  instructions: string
  allowedTools: string[]
  contextPolicy: ContextPolicy
  /** Plain JSON-Schema objects describing the role's input/output contract. */
  inputSchema?: Json
  outputSchema?: Json
  checks: string[]
  budgetTurns: number
  preferredSlotClass: SlotClassPreference
  readOnly: boolean
}

const def = (name: string, over: Partial<RoleDef>): RoleDef => ({
  name,
  instructions: '',
  allowedTools: ['read', 'report', 'ask_user'],
  contextPolicy: 'task_only',
  checks: [],
  budgetTurns: 12,
  preferredSlotClass: 'any_healthy',
  readOnly: false,
  ...over,
})

/** The built-in roster (plan §7 table); instructions ship as prompt-bundle defaults. */
export const BUILTIN_ROSTER: Readonly<Record<BuiltinRole, RoleDef>> = {
  implementer: def('implementer', {
    allowedTools: ['read', 'report', 'ask_user', 'request_confirmation', 'handback', 'edit', 'shell'],
    contextPolicy: 'task_and_contract',
    preferredSlotClass: 'any_healthy',
  }),
  test_author: def('test_author', {
    allowedTools: ['read', 'report', 'ask_user', 'request_confirmation', 'handback', 'edit', 'shell'],
    contextPolicy: 'task_and_contract',
  }),
  code_reviewer: def('code_reviewer', {
    contextPolicy: 'read_repo',
    preferredSlotClass: 'different_provider',
    readOnly: true,
  }),
  pr_reviewer: def('pr_reviewer', {
    contextPolicy: 'read_repo',
    preferredSlotClass: 'different_provider',
    readOnly: true,
  }),
  security_checker: def('security_checker', {
    allowedTools: ['read', 'report', 'ask_user', 'request_confirmation', 'handback', 'shell'],
    contextPolicy: 'read_repo',
    readOnly: true,
  }),
  integrator: def('integrator', {
    allowedTools: ['read', 'report', 'ask_user', 'request_confirmation', 'handback', 'shell'],
    contextPolicy: 'task_and_contract',
  }),
  repair_agent: def('repair_agent', {
    allowedTools: ['read', 'report', 'ask_user', 'request_confirmation', 'handback', 'edit', 'shell'],
    contextPolicy: 'task_and_contract',
  }),
  release_agent: def('release_agent', {
    contextPolicy: 'read_repo',
    readOnly: true,
  }),
}

export const BUILTIN_ROLE_NAMES: readonly string[] = Object.keys(BUILTIN_ROSTER)

/** Reserved prefixes the meta agent and humans own (plan §8: the planning task pattern). */
export const RESERVED_NAME_PREFIXES: readonly string[] = ['mec-', 'mec_']

export type RoleIssue =
  | { kind: 'name_taken'; detail: string }
  | { kind: 'reserved_name'; detail: string }
  | { kind: 'unknown_tool'; detail: string }
  | { kind: 'unknown_check'; detail: string }
  | { kind: 'budget_ceiling'; detail: string }
  | { kind: 'invalid_schema'; detail: string }

function isPlainObjectSchema(
  schema: Json | undefined,
  field: 'inputSchema' | 'outputSchema',
): RoleIssue | null {
  if (schema === undefined) return null
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { kind: 'invalid_schema', detail: `${field} must be a JSON object` }
  }
  if (!('type' in schema)) {
    return { kind: 'invalid_schema', detail: `${field} must carry a "type" (plain JSON-Schema object)` }
  }
  return null
}

export function compileAdHocRole(
  candidate: RoleDef,
  opts: { knownTools: readonly string[]; knownChecks: readonly string[]; maxBudgetTurns: number },
): { ok: true; revision: string } | { ok: false; issues: RoleIssue[] } {
  const issues: RoleIssue[] = []
  if (Object.hasOwn(BUILTIN_ROSTER, candidate.name) || candidate.name === 'meta_agent') {
    issues.push({ kind: 'name_taken', detail: `'${candidate.name}' is a built-in role` })
  }
  const reserved = RESERVED_NAME_PREFIXES.find((p) => candidate.name.startsWith(p))
  if (reserved) {
    issues.push({
      kind: 'reserved_name',
      detail: `'${candidate.name}' starts with reserved prefix '${reserved}'`,
    })
  }
  for (const tool of candidate.allowedTools) {
    if (!opts.knownTools.includes(tool)) {
      issues.push({ kind: 'unknown_tool', detail: `tool '${tool}' is not registered` })
    }
  }
  for (const check of candidate.checks) {
    if (!opts.knownChecks.includes(check)) {
      issues.push({ kind: 'unknown_check', detail: `check '${check}' is not registered for this repository` })
    }
  }
  if (candidate.budgetTurns < 1 || candidate.budgetTurns > opts.maxBudgetTurns) {
    issues.push({
      kind: 'budget_ceiling',
      detail: `budget ${candidate.budgetTurns} turns is outside 1..${opts.maxBudgetTurns}`,
    })
  }
  const inputIssue = isPlainObjectSchema(candidate.inputSchema, 'inputSchema')
  if (inputIssue) issues.push(inputIssue)
  const outputIssue = isPlainObjectSchema(candidate.outputSchema, 'outputSchema')
  if (outputIssue) issues.push(outputIssue)

  if (issues.length > 0) return { ok: false, issues }

  const revision = createHash('sha256').update(JSON.stringify(candidate)).digest('hex').slice(0, 16)
  return { ok: true, revision }
}
