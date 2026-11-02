import { z } from 'zod'
import { Requirement, TaskSpec } from './task-spec'

/** Request bodies accepted by the control API. Responses are typed in apps/web/src/api/types.ts. */

export const ProjectRole = z.enum(['owner', 'member', 'viewer'])
export type ProjectRole = z.infer<typeof ProjectRole>

export const CreateProject = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase letters, digits and dashes'),
  name: z.string().min(1).max(100),
})

export const AddMember = z.object({
  login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/, 'a GitHub login'),
  role: ProjectRole,
})

/** One command in a repository validation profile, run as an argument array (never a shell string). */
export const CheckCommand = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  argv: z.array(z.string().min(1)).min(1),
  timeoutSec: z.number().int().min(1).max(3600).default(600),
})
export type CheckCommand = z.infer<typeof CheckCommand>

export const ValidationProfile = z.object({
  bootstrap: z.array(CheckCommand).default([]),
  checks: z.array(CheckCommand).default([]),
})
export type ValidationProfile = z.infer<typeof ValidationProfile>

export const CreateRepository = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
  cloneUrl: z.string().min(1).max(500),
  defaultBranch: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/)
    .default('main'),
  validationProfile: ValidationProfile.default({ bootstrap: [], checks: [] }),
})

export const UpdateRepository = z.object({
  defaultBranch: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/)
    .optional(),
  validationProfile: ValidationProfile.optional(),
})

export const CreateDelivery = z.object({
  projectId: z.uuid(),
  repositoryId: z.uuid(),
  title: z.string().min(1).max(200),
  baseRef: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/)
    .optional(),
  planMarkdown: z.string().max(200_000).default(''),
  constraints: z.string().max(20_000).default(''),
  requirements: z.array(Requirement).default([]),
  tasks: z.array(TaskSpec).default([]),
  idempotencyKey: z.string().min(8).max(100),
})

export const UpdatePlan = z.object({
  expectedVersion: z.number().int().positive(),
  planMarkdown: z.string().max(200_000).optional(),
  constraints: z.string().max(20_000).optional(),
  requirements: z.array(Requirement).optional(),
  tasks: z.array(TaskSpec).optional(),
})

export const ExpectedVersion = z.object({ expectedVersion: z.number().int().positive() })

export const Decision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approve') }),
  z.object({ kind: z.literal('reject'), reason: z.string().max(4000).optional() }),
  z.object({ kind: z.literal('answer'), answer: z.string().min(1).max(20_000) }),
])
export type Decision = z.infer<typeof Decision>

export const ResolveApproval = z.object({ decision: Decision })
