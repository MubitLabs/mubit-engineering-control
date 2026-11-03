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
export type AttemptBrief = z.infer<typeof AttemptBrief>
