import { describe, expect, it } from 'vitest'
import { BUILTIN_ROLE_NAMES, BUILTIN_ROSTER, compileAdHocRole, type RoleDef } from '../src/registry'

const OPTS = {
  knownTools: ['read', 'report', 'ask_user', 'request_confirmation', 'handback', 'edit', 'shell'],
  knownChecks: ['unit', 'lint', 'integration'],
  maxBudgetTurns: 24,
}

const adHoc = (over: Partial<RoleDef> = {}): RoleDef => ({
  name: 'migration_author',
  instructions: 'Write forward-compatible migrations only.',
  allowedTools: ['read', 'report', 'edit'],
  contextPolicy: 'task_and_contract',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  checks: ['unit'],
  budgetTurns: 8,
  preferredSlotClass: 'any_healthy',
  readOnly: false,
  ...over,
})

describe('built-in roster', () => {
  it('has exactly the eight §7 roles and each compiles against the registry itself', () => {
    expect([...BUILTIN_ROLE_NAMES].sort()).toEqual(
      [
        'code_reviewer',
        'implementer',
        'integrator',
        'pr_reviewer',
        'release_agent',
        'repair_agent',
        'security_checker',
        'test_author',
      ].sort(),
    )
    for (const role of Object.values(BUILTIN_ROSTER)) {
      const result = compileAdHocRole({ ...role, name: `x_${role.name}` }, OPTS)
      expect(result.ok, role.name).toBe(true)
    }
  })

  it('review roles prefer a different provider and are read-only', () => {
    expect(BUILTIN_ROSTER.code_reviewer.preferredSlotClass).toBe('different_provider')
    expect(BUILTIN_ROSTER.pr_reviewer.readOnly).toBe(true)
    expect(BUILTIN_ROSTER.implementer.readOnly).toBe(false)
  })
})

describe('compileAdHocRole', () => {
  it('compiles a valid definition with a stable immutable revision', () => {
    const a = compileAdHocRole(adHoc(), OPTS)
    const b = compileAdHocRole(adHoc(), OPTS)
    expect(a.ok).toBe(true)
    expect(b.ok && a.ok ? b.revision : '').toBe(a.ok ? a.revision : '')
  })

  it('different content yields a different revision', () => {
    const a = compileAdHocRole(adHoc(), OPTS)
    const b = compileAdHocRole(adHoc({ instructions: 'different' }), OPTS)
    expect(a.ok && b.ok && a.revision !== b.revision).toBe(true)
  })

  it('collects actionable issues: taken name, reserved prefix, unknown tool, unknown check, budget, bad schema', () => {
    const result = compileAdHocRole(
      adHoc({
        name: 'implementer',
        allowedTools: ['read', 'teleport'],
        checks: ['smoke'],
        budgetTurns: 99,
        inputSchema: 'nope' as never,
      }),
      OPTS,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.map((i) => i.kind).sort()).toEqual([
        'budget_ceiling',
        'invalid_schema',
        'name_taken',
        'unknown_check',
        'unknown_tool',
      ])
    }
    const reserved = compileAdHocRole(adHoc({ name: 'mec-plan-1' }), OPTS)
    expect(reserved.ok).toBe(false)
    if (!reserved.ok) expect(reserved.issues[0]?.kind).toBe('reserved_name')
  })
})
