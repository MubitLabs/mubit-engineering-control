import { z } from 'zod'
import type { PermissionBridge } from './bridge'
import type { AttemptBrief } from './brief'
import { type AttemptId, type Generation, InputId, MessageId } from './common'
import type { EngineEvent, ErrorClass } from './events'
import type { Report } from './report'
import type { Slot } from './slots'

/** How the adapter's `usage` events add up over an attempt (CONTRACTS §4). */
export const UsageMode = z.enum(['cumulative', 'delta', 'none'])

/** What the installed engine can do, as the capability probe verified it — never what the plan hopes. */
export const Capabilities = z.strictObject({
  engine_version: z.string().min(1),
  /** The flags the probe actually ran with for this `engine_version`. */
  flags_verified: z.array(z.string().min(1)),
  structured_stream: z.boolean(),
  questions: z.boolean(),
  tool_approval: z.boolean(),
  interrupt: z.boolean(),
  resume: z.boolean(),
  usage: z.boolean(),
  rate_limit_events: z.boolean(),
  sandbox: z.boolean(),
  restricted_mode: z.boolean(),
  mcp_http: z.boolean(),
  usage_mode: UsageMode,
})

/** The auth half of a probe; `expires_soon` comes from Claude's status warning (CONTRACTS §4). */
export const AuthHealth = z.strictObject({
  logged_in: z.boolean(),
  method: z.string().min(1).optional(),
  expires_soon: z.boolean().optional(),
  detail: z.string().optional(),
})

export const InputKind = z.enum(['message', 'note', 'policy_changed', 'recovery'])

/** A unit of two-way traffic the runtime delivers to a live attempt (CONTRACTS §4). */
export const Input = z.strictObject({
  id: InputId,
  kind: InputKind,
  text: z.string(),
  message_id: MessageId.optional(),
})

/** The slot identity an adapter needs to probe: where the engine lives and how it authenticates. */
export type SlotRef = Pick<Slot, 'id' | 'engine' | 'kind' | 'home' | 'credential_kind'>

/**
 * Everything `launch` needs. The runtime builds the environment, shims, gitconfig and worktree;
 * the adapter builds argv, the per-attempt settings/config files and the MCP configuration from
 * `brief.tools`, and starts the process inside the runtime's process group (CONTRACTS §4).
 */
export interface LaunchSpec {
  brief: AttemptBrief
  /** The attempt layer the runtime built on top of the allowlisted environment. */
  env: Record<string, string>
  cwd: string
  /** What a relaunch passes the engine so it continues the same conversation. */
  resume?: { session_id: string }
  bridge: PermissionBridge
}

export interface AttemptHandle {
  attempt_id: AttemptId
  generation: Generation
  pid?: number
  /** Known from the first `session_started` on, so a later relaunch can resume. */
  session_id?: string
}

/** Stream B implements one per engine (CONTRACTS §4). */
export interface EngineAdapter {
  probe(slot: SlotRef): Promise<{ capabilities: Capabilities; auth: AuthHealth }>
  launch(spec: LaunchSpec): Promise<AttemptHandle>
  send(handle: AttemptHandle, input: Input): Promise<void>
  interrupt(handle: AttemptHandle): Promise<void>
  stop(handle: AttemptHandle): Promise<void>
  events(handle: AttemptHandle): AsyncIterable<EngineEvent>
  classify(error: unknown): ErrorClass
  mapReport(final: unknown): Report
}

export type UsageMode = z.infer<typeof UsageMode>
export type Capabilities = z.infer<typeof Capabilities>
export type AuthHealth = z.infer<typeof AuthHealth>
export type InputKind = z.infer<typeof InputKind>
export type Input = z.infer<typeof Input>
