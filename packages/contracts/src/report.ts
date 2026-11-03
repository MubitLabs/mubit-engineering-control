import { z } from 'zod'
import { InputId, MessageId, QuestionId, Sha } from './common'

/** Plan §10: one concrete question. Same `text` as the open question reuses it; different text replaces it. */
export const Question = z.strictObject({
  id: QuestionId.optional(),
  text: z.string().min(1).max(400),
  options: z.array(z.string().min(1)).optional(),
  for_message_id: MessageId.optional(),
  evidence_ref: z.string().min(1).optional(),
})

export const ReportKind = z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'])

export const Report = z.strictObject({
  kind: ReportKind,
  summary: z.string().min(1).max(2000),
  head_sha: Sha.optional(),
  checks_run: z.array(z.string().min(1)).optional(),
  artifacts: z.array(z.strictObject({ kind: z.string().min(1), ref: z.string().min(1) })).optional(),
  /** Absent keeps the open question; `null` clears it. Parsing preserves the difference. */
  question: Question.nullable().optional(),
  round: z.strictObject({ reviewer: z.string().min(1).optional(), count: z.int().min(0) }).optional(),
  handled_inputs: z.array(InputId).optional(),
  /** Once per message. */
  handback: z.strictObject({ message_id: MessageId, reason: z.string().min(1) }).optional(),
})

export type Question = z.infer<typeof Question>
export type ReportKind = z.infer<typeof ReportKind>
export type Report = z.infer<typeof Report>
