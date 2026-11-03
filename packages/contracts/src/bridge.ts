import { z } from 'zod'
import { AbsPath, type AttemptRef, type IsoTime, Json, Sha } from './common'

export const OperationKind = z.enum([
  'shell',
  'edit',
  'write',
  'network',
  'external_directory',
  'mcp_tool',
  'other',
])

export const Operation = z.strictObject({
  kind: OperationKind,
  summary: z.string().min(1),
  command: z.array(z.string()).min(1).optional(),
  paths: z.array(AbsPath).optional(),
  hosts: z.array(z.string().min(1)).optional(),
  tool: z.string().min(1).optional(),
})

export const Evidence = z.strictObject({
  raw: Json,
  worktree: AbsPath,
  head_sha: Sha.optional(),
})

/** `expired`: the deadline passed; the adapter denies the native request and emits `permission_result`. */
export const Decision = z.enum(['allow', 'deny', 'expired'])

export type OperationKind = z.infer<typeof OperationKind>
export type Operation = z.infer<typeof Operation>
export type Evidence = z.infer<typeof Evidence>
export type Decision = z.infer<typeof Decision>

/**
 * Stream A implements it in `mec-tools`. Claude Code reaches it through the MCP tool
 * `mcp__mec__confirm`; Codex and OpenCode adapters call `request` in-process with the native request id.
 */
export interface PermissionBridge {
  request(attempt: AttemptRef, operation: Operation, evidence: Evidence, deadline: IsoTime): Promise<Decision>
}
