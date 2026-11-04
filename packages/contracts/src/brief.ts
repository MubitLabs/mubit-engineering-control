import { z } from 'zod'
import {
  AbsPath,
  AttemptId,
  EngineId,
  Generation,
  MessageId,
  Sha,
  SlotId,
  TaskId,
  WorkItemId,
} from './common'
import { isSecretEnvName, matchesSecret } from './secrets'

/** Stream A asks, Stream B builds (plan §8). Part 2's `slots.ts` re-exports it. */
export const IsolationProfile = z.strictObject({
  sandbox: z.enum(['required', 'preferred', 'off']),
  read_only: z.boolean(),
  allow_write: z.array(AbsPath),
  deny_read: z.array(AbsPath),
  allowed_domains: z.array(z.string().min(1)),
  blocked_commands: z.array(z.string().min(1)),
  background_cap_ms: z.int().min(0),
  permission_mode: z.enum(['bridge', 'none']),
  repo_trusted: z.boolean(),
})

/** The original request, verbatim or by read pointer; never both. */
const OriginMessage = z.union([
  z.strictObject({ id: MessageId, text: z.string().min(1) }),
  z.strictObject({ id: MessageId, pointer: z.string().min(1) }),
])

/** The tier ladder the planner reasons about (review 2026-11-04 §2). Additive v0.1. */
export const TierName = z.enum(['fast', 'balanced', 'strong', 'frontier'])

/**
 * The effort vocabulary across the three engines (review 2026-11-04 §3/§4): Claude and
 * Codex take `low…max` (plus Codex `ultra` — parallel subagents, gated by the subagent
 * policy); OpenCode expresses effort as the model's `#variant` (`minimal` exists only
 * on Gemini Flash-Lite). Additive v0.1.
 */
export const EffortLevel = z.enum(['low', 'minimal', 'medium', 'high', 'xhigh', 'max', 'ultra'])

/**
 * What the planner asks a slot to run (review 2026-11-04 §4): a tier from the ladder
 * OR an explicit engine-facing model id — exactly one, never both, never neither —
 * with an optional effort/variant lift and the reason the choice was made (§5.3:
 * every tier choice is recorded). Additive v0.1: optional on the brief, so every
 * contracts-v0 brief stays valid.
 */
export const ModelRequest = z
  .strictObject({
    tier: TierName.optional(),
    model: z.string().min(1).optional(),
    effort: EffortLevel.optional(),
    variant: EffortLevel.optional(),
    reason: z.string().min(1),
  })
  .superRefine((request, ctx) => {
    const named = [request.tier, request.model].filter((value) => value !== undefined).length
    if (named !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: named === 0 ? ['tier'] : ['model'],
        message: 'exactly one of tier or model is required — a ladder tier or an explicit model id',
      })
    }
  })

const ROUTING_NOTE_MAX_WORDS = 50

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length

const AttemptEnv = z.record(z.string().min(1), z.string()).superRefine((env, ctx) => {
  for (const [name, value] of Object.entries(env)) {
    if (isSecretEnvName(name)) {
      ctx.addIssue({
        code: 'custom',
        path: [name],
        message: 'secret-named variables never travel in a brief',
      })
    } else if (matchesSecret(value)) {
      ctx.addIssue({ code: 'custom', path: [name], message: 'value looks like a provider key' })
    }
  }
})

/** Stream A builds it, Stream B launches it. */
export const AttemptBrief = z.strictObject({
  attempt_id: AttemptId,
  generation: Generation,
  task_id: TaskId,
  work_item_id: WorkItemId,
  role: z.strictObject({ name: z.string().min(1), revision: z.string().min(1) }),
  engine: EngineId,
  slot_id: SlotId,
  worktree: AbsPath,
  base_sha: Sha,
  branch: z.string().min(1),
  origin: z.strictObject({ messages: z.array(OriginMessage).min(1) }),
  objective: z.string().min(1),
  owned_paths: z.array(z.string().min(1)),
  acceptance_checks: z.array(z.string().min(1)),
  /** Context only. */
  routing_note: z
    .string()
    .min(1)
    .refine((note) => countWords(note) <= ROUTING_NOTE_MAX_WORDS, {
      message: `at most ${ROUTING_NOTE_MAX_WORDS} words`,
    })
    .optional(),
  /** Additive v0.1 (review 2026-11-04 §4): what the planner asked this attempt to run. */
  model_request: ModelRequest.optional(),
  budget: z.strictObject({
    turns: z.int().min(1),
    wall_clock_ms: z.int().min(1),
    usd: z.number().positive().optional(),
  }),
  bundle_revision: z.string().min(1),
  /**
   * Attempt-scoped `mec-tools` access (plan §6). `token` is the one field the secret-field lint exempts:
   * `issueToken` mints it at launch, and it is never written to the effects payload or any table (plan §17).
   */
  tools: z.strictObject({
    url: z.url({ protocol: /^http$/, hostname: /^127\.0\.0\.1$/ }),
    token: z.string().min(1),
  }),
  /** Non-secret additions only (plan §5.12). */
  env: AttemptEnv,
  isolation: IsolationProfile,
})

export type IsolationProfile = z.infer<typeof IsolationProfile>
export type TierName = z.infer<typeof TierName>
export type EffortLevel = z.infer<typeof EffortLevel>
export type ModelRequest = z.infer<typeof ModelRequest>
export type AttemptBrief = z.infer<typeof AttemptBrief>
