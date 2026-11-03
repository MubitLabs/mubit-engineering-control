import { z } from 'zod'

const prefixedId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}[A-Za-z0-9_-]+$`), `expected an id starting with ${prefix}`)

export const WorkItemId = prefixedId('wi_')
export const TaskId = prefixedId('task_')
export const AttemptId = prefixedId('att_')
export const SlotId = prefixedId('slot_')
/** A row in the `engines` table (an installed binary), not the engine kind; see `EngineId`. */
export const EngineInstallId = prefixedId('eng_')
export const MessageId = prefixedId('msg_')
export const ConfirmationId = prefixedId('conf_')
export const QuestionId = prefixedId('q_')
export const ReportId = prefixedId('rep_')
export const InputId = prefixedId('inp_')

/** Increases with every relaunch of an attempt; stale generations are fenced out. */
export const Generation = z.int().min(0)

/** Exactly the `Date#toISOString` form (UTC, milliseconds), so times compare correctly as text. */
export const IsoTime = z.iso.datetime({ precision: 3 })

export const Sha = z.string().regex(/^[0-9a-f]{40}$/, 'expected 40 lowercase hex characters')

export const AbsPath = z.string().regex(/^\/[^\0]*$/, 'expected an absolute path')

export const Json = z.json()

export const EngineId = z.enum(['claude', 'codex', 'opencode'])

/** Names one run of an attempt; every runtime call and fact carries it. */
export const AttemptRef = z.strictObject({ attempt_id: AttemptId, generation: Generation })

export type WorkItemId = z.infer<typeof WorkItemId>
export type TaskId = z.infer<typeof TaskId>
export type AttemptId = z.infer<typeof AttemptId>
export type SlotId = z.infer<typeof SlotId>
export type EngineInstallId = z.infer<typeof EngineInstallId>
export type MessageId = z.infer<typeof MessageId>
export type ConfirmationId = z.infer<typeof ConfirmationId>
export type QuestionId = z.infer<typeof QuestionId>
export type ReportId = z.infer<typeof ReportId>
export type InputId = z.infer<typeof InputId>
export type Generation = z.infer<typeof Generation>
export type IsoTime = z.infer<typeof IsoTime>
export type Sha = z.infer<typeof Sha>
export type AbsPath = z.infer<typeof AbsPath>
export type Json = z.infer<typeof Json>
export type EngineId = z.infer<typeof EngineId>
export type AttemptRef = z.infer<typeof AttemptRef>
