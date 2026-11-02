import { z } from 'zod'

/**
 * Task specification, PDF §8. Produced by a coordinator (or written by hand), validated by
 * @mec/domain's task-graph rules, and approved as part of an exact plan revision.
 */

/** 'integration': start after prerequisites are integrated. 'contract': start once they are accepted. */
export const BasePolicy = z.enum(['integration', 'contract'])
export type BasePolicy = z.infer<typeof BasePolicy>

export const TaskKey = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/, 'task key: letters, digits, _ . - (max 40)')

export const Requirement = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/),
  text: z.string().min(1).max(2000),
})
export type Requirement = z.infer<typeof Requirement>

export const TaskSpec = z.object({
  key: TaskKey,
  title: z.string().min(1).max(200),
  objective: z.string().max(8000),
  requirementIds: z.array(z.string()).default([]),
  deliverables: z.array(z.string().min(1)).default([]),
  /** Names of checks from the repository validation profile, e.g. "test", "typecheck". */
  acceptanceChecks: z.array(z.string().min(1)).default([]),
  dependsOn: z.array(z.string()).default([]),
  basePolicy: BasePolicy.default('integration'),
  ownedPaths: z.array(z.string().min(1)).default([]),
  sharedContractRefs: z.array(z.string()).default([]),
  executionProfileId: z.string().nullable().default(null),
  maxAttempts: z.number().int().default(2),
  timeBudgetMinutes: z.number().int().default(60),
  concurrencyGroup: z.string().nullable().default(null),
  integrationOrder: z.number().int().default(0),
})
export type TaskSpec = z.infer<typeof TaskSpec>
export type TaskSpecInput = z.input<typeof TaskSpec>
