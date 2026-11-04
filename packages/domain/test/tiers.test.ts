import { describe, expect, it } from 'vitest'
import {
  availableTiersOnSlot,
  MODEL_TIERS,
  type ModelTier,
  markKeyFor,
  placeableTiers,
  type TierTableLike,
  tierMarkSummary,
  tierRank,
  tierWithin,
  validateTierPlan,
} from '../src/tiers'

/** A table shaped like the shipped default, trimmed to what tier validation reads. */
const TABLE: TierTableLike = {
  tiers: MODEL_TIERS,
  engines: {
    claude: {
      models: {
        haiku: { tier: 'fast' },
        sonnet: { tier: 'balanced' },
        opus: { tier: 'strong' },
        fable: { tier: 'frontier' },
      },
    },
    codex: { models: { 'gpt-6-luna': { tier: 'fast' }, 'gpt-6-astra': { tier: 'strong' } } },
    opencode: {
      providers: {
        'zai-coding-plan': { models: { 'glm-5.3-flash': { tier: 'fast' }, 'glm-5.3': { tier: 'balanced' } } },
        google: { models: { 'gemini-4-argon': { tier: 'strong' } } },
      },
    },
  },
  routing: {
    subagents: {
      default: { max_tier: 'fast' as ModelTier, depth: 1 },
      repair_agent: { max_tier: 'balanced' as ModelTier, depth: 1 },
    },
  },
}

const marks = (entries: Record<string, 'available' | 'unavailable' | 'unlisted'>) => entries

describe('tier ladder', () => {
  it('ranks the four rungs cheapest first', () => {
    expect(tierRank('fast')).toBeLessThan(tierRank('balanced'))
    expect(tierRank('balanced')).toBeLessThan(tierRank('strong'))
    expect(tierRank('strong')).toBeLessThan(tierRank('frontier'))
    expect(tierWithin('fast', 'balanced')).toBe(true)
    expect(tierWithin('strong', 'balanced')).toBe(false)
  })

  it('mark keys are provider/id on opencode, bare ids elsewhere', () => {
    expect(markKeyFor('opencode', 'zai-coding-plan', 'glm-5.3')).toBe('zai-coding-plan/glm-5.3')
    expect(markKeyFor('claude', undefined, 'opus')).toBe('opus')
  })
})

describe('availableTiersOnSlot', () => {
  it('lists only tiers with an available mark, and never from an unhealthy slot', () => {
    const slot = {
      slotId: 'slot_oc1',
      engine: 'opencode',
      healthy: true,
      marks: marks({
        'zai-coding-plan/glm-5.3-flash': 'available',
        'zai-coding-plan/glm-5.3': 'available',
        'gemini-4-argon': 'unavailable',
      }),
    }
    expect(availableTiersOnSlot(slot, TABLE)).toEqual(['fast', 'balanced'])
    expect(availableTiersOnSlot({ ...slot, healthy: false }, TABLE)).toEqual([])
  })

  it('a missing mark is unlisted, and unlisted never places a tier (probe before trust)', () => {
    const claudeAllUnlisted = {
      slotId: 'slot_cl',
      engine: 'claude',
      healthy: true,
      marks: marks({ opus: 'unlisted' }),
    }
    expect(availableTiersOnSlot(claudeAllUnlisted, TABLE)).toEqual([])
    expect(tierMarkSummary('strong', TABLE, [claudeAllUnlisted])).toBe('unlisted')
    expect(placeableTiers(TABLE, [claudeAllUnlisted])).toEqual([])
  })
})

describe('validateTierPlan', () => {
  const slots = [
    {
      slotId: 'slot_cl',
      engine: 'claude',
      healthy: true,
      marks: marks({ haiku: 'available', sonnet: 'available', opus: 'available', fable: 'available' }),
    },
    {
      slotId: 'slot_oc',
      engine: 'opencode',
      healthy: true,
      marks: marks({ 'zai-coding-plan/glm-5.3-flash': 'available', 'zai-coding-plan/glm-5.3': 'available' }),
    },
  ]

  it('passes an available tier and names the slot-independent union across engines', () => {
    const issues = validateTierPlan({
      tasks: [{ taskId: 'task_1', modelRequest: { tier: 'strong', reason: 'touches concurrency' } }],
      table: TABLE,
      slots,
      frontierPreAuthorised: false,
    })
    expect(issues).toEqual([])
    expect(placeableTiers(TABLE, slots)).toEqual(['fast', 'balanced', 'strong', 'frontier'])
  })

  it('rejects a tier no healthy slot marks available, naming the alternatives', () => {
    const glmOnly = [slots[1]!]
    const issues = validateTierPlan({
      tasks: [{ taskId: 'task_1', modelRequest: { tier: 'strong', reason: 'hard repair' } }],
      table: TABLE,
      slots: glmOnly,
      frontierPreAuthorised: false,
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.kind).toBe('tier_unavailable')
    expect(issues[0]?.detail).toContain('placeable tiers: fast, balanced')
  })

  it('rejects a tier that is not in the table at all', () => {
    const issues = validateTierPlan({
      tasks: [{ taskId: 'task_1', modelRequest: { tier: 'meh' as ModelTier, reason: 'typo' } }],
      table: TABLE,
      slots,
      frontierPreAuthorised: false,
    })
    expect(issues[0]?.kind).toBe('tier_not_in_table')
  })

  it('frontier is gated on pre-authorisation and opens when the user pre-authorised', () => {
    const task = {
      taskId: 'task_1',
      modelRequest: { tier: 'frontier' as ModelTier, reason: 'investigation' },
    }
    const gated = validateTierPlan({ tasks: [task], table: TABLE, slots, frontierPreAuthorised: false })
    expect(gated[0]?.kind).toBe('frontier_not_authorised')
    expect(gated[0]?.detail).toContain('never autonomous')
    const open = validateTierPlan({ tasks: [task], table: TABLE, slots, frontierPreAuthorised: true })
    expect(open).toEqual([])
  })

  it('an explicit model must exist in the table and be available on a healthy slot', () => {
    const unknown = validateTierPlan({
      tasks: [{ taskId: 'task_1', modelRequest: { model: 'gpt-4', reason: 'stale id' } }],
      table: TABLE,
      slots,
      frontierPreAuthorised: false,
    })
    expect(unknown[0]?.kind).toBe('unknown_model')

    const unavailable = validateTierPlan({
      tasks: [
        {
          taskId: 'task_2',
          modelRequest: { model: 'zai-coding-plan/glm-5.3', reason: 'balanced on GLM' },
        },
      ],
      table: TABLE,
      slots: [slots[0]!], // claude slot only: the GLM entry is not even probeable there
      frontierPreAuthorised: false,
    })
    expect(unavailable[0]?.kind).toBe('model_unavailable')
  })

  it('a task with no model_request is always allowed (the role default resolves it)', () => {
    const issues = validateTierPlan({
      tasks: [{ taskId: 'task_1' }, { taskId: 'task_2', modelRequest: undefined }],
      table: TABLE,
      slots: [],
      frontierPreAuthorised: false,
    })
    expect(issues).toEqual([])
  })

  it('subagent policies must stay within the role ceiling (role-specific, then default)', () => {
    const over = validateTierPlan({
      tasks: [
        {
          taskId: 'task_1',
          role: 'implementer',
          subagentPolicy: { maxTier: 'strong', depth: 1 },
        },
      ],
      table: TABLE,
      slots,
      frontierPreAuthorised: false,
    })
    expect(over[0]?.kind).toBe('subagent_policy_over_ceiling')
    expect(over[0]?.detail).toContain("ceiling for role 'implementer' (fast)")

    const deeper = validateTierPlan({
      tasks: [
        {
          taskId: 'task_1',
          role: 'implementer',
          subagentPolicy: { maxTier: 'fast', depth: 2 },
        },
      ],
      table: TABLE,
      slots,
      frontierPreAuthorised: false,
    })
    expect(deeper[0]?.detail).toContain('depth 2 exceeds')

    const repair = validateTierPlan({
      tasks: [
        {
          taskId: 'task_1',
          role: 'repair_agent',
          subagentPolicy: { maxTier: 'balanced', depth: 1 },
        },
      ],
      table: TABLE,
      slots,
      frontierPreAuthorised: false,
    })
    expect(repair).toEqual([])
  })
})
