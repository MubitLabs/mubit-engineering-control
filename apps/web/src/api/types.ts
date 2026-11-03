import type { Requirement, TaskSpec, ValidationProfile } from '@mec/contracts'
import type { Blocker, GraphValidation } from '@mec/domain'

/** Response shapes from apps/control (columns arrive camelCased). Dates arrive as ISO strings. */

export interface User {
  id: string
  login: string
  name: string | null
  avatarUrl: string | null
  isAdmin?: boolean
}

export type ProjectRole = 'owner' | 'member' | 'viewer'

export interface Me {
  user: User & { isAdmin: boolean }
  projectRoles: Record<string, ProjectRole>
  authMode: 'github' | 'dev'
}

export interface Project {
  id: string
  slug: string
  name: string
  createdAt: string
  pausedAt: string | null
  role?: ProjectRole | null
}

export interface Repository {
  id: string
  name: string
  cloneUrl: string
  defaultBranch: string
  validationProfile: ValidationProfile
}

export interface Member extends User {
  role: ProjectRole
}

export interface Delivery {
  id: string
  projectId: string
  repositoryId: string
  title: string
  ownerId: string
  ownerLogin?: string
  state: string
  baseRef: string
  baseSha: string | null
  integrationSha?: string | null
  integrationPushedSha?: string | null
  priority: number
  createdAt: string
  updatedAt: string
  taskCount?: number
  pendingApprovals?: number
}

export interface PlanRevision {
  id: string
  deliveryId: string
  number: number
  state: string
  planMarkdown: string
  constraints: string
  requirements: Requirement[]
  tasks: TaskSpec[]
  validation: GraphValidation | null
  version: number
  contentHash: string
  supersedesId: string | null
  impactSummary: string | null
  approvedBy: string | null
  approvedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface Task {
  id: string
  kind: 'work' | 'planning' | 'integration'
  deliveryId: string
  planRevisionId: string
  key: string
  title: string
  spec: TaskSpec
  state: string
  blocker: Blocker | null
  ownerId: string | null
  attemptsUsed: number
  acceptedSha: string | null
  repairContext?: { reason: string; notes: string; conflicts?: string[] } | null
  createdAt: string
  updatedAt: string
}

export interface Approval {
  id: string
  kind: 'plan' | 'tool' | 'question' | 'result' | 'merge'
  projectId: string
  deliveryId: string | null
  taskId: string | null
  attemptId: string | null
  planRevisionId: string | null
  title: string
  detail: Record<string, unknown>
  requestedByKind: string
  requestedBy: string | null
  allowedDeciderIds: string[]
  status: string
  expiresAt: string | null
  resolvedBy: string | null
  resolvedAt: string | null
  answer: Record<string, unknown> | null
  createdAt: string
  taskKey?: string | null
  deliveryTitle?: string | null
  resolvedByLogin?: string | null
}

export interface StoredEvent {
  id: number
  stream: string
  seq: number
  type: string
  projectId: string | null
  deliveryId: string | null
  taskId: string | null
  attemptId: string | null
  actorKind: string
  actorId: string | null
  payload: Record<string, unknown>
  occurredAt: string
  recordedAt: string
}

export interface DeliveryDetail {
  delivery: Delivery
  owner: User
  repository: Repository
  revisions: PlanRevision[]
  tasks: Task[]
  dependencies: { taskId: string; dependsOnTaskId: string }[]
  approvals: Approval[]
  pullRequests: PullRequest[]
  nextStep?: string | null
}

export interface PullRequest {
  id: string
  number: number
  url: string
  headBranch: string
  headSha: string
  baseRef: string
  state: 'open' | 'closed' | 'merged'
  checks: { total: number; failed: number; conclusion: string } | null
  mergedAt: string | null
}

export interface Setup {
  projectId: string | null
  steps: { project: boolean; repository: boolean; runner: boolean; profile: boolean; delivery: boolean }
}
