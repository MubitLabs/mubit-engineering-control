/**
 * Setup readiness (§21.3, §6): five stages read from saved facts. Walking through the screens
 * changes none of them; only a real slot, repository, choice or request does. A skip is a note
 * that the owner moved on, stored apart from the facts, and it never counts as done.
 */
import type { Store, StoreDoc } from '@mec/contracts'
import { lacksHome } from './engine-registry'

export const SETUP_STEPS = ['engines', 'connection', 'repository', 'meta_slot', 'first_request'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

/** Finish needs these. A first request is what Finish leads to, so it cannot be a prerequisite. */
const PREREQUISITES: readonly SetupStep[] = ['engines', 'connection', 'repository', 'meta_slot']

export const SETUP_DOC_ID = 'settings/setup'
const META_SLOT_ID = 'settings/meta-slot'
const REPOSITORY_PREFIX = 'repo_'

export type StepStatus = 'done' | 'missing' | 'skipped'
export type ReadinessStep = {
  id: SetupStep
  title: string
  status: StepStatus
  detail: string
  next: { label: string; route: 'setup' | 'slots' | 'settings' | 'chat' } | null
}

export type MetaCandidate = {
  id: string
  label: string
  engine: string
  kind: string
  state: string
  usable: boolean
  reason?: string
}

export type Readiness = {
  steps: ReadinessStep[]
  engines: Array<{ engine: string; installed: boolean; version?: string }>
  metaCandidates: MetaCandidate[]
  metaSlotId: string | null
  finish: { enabled: boolean; reason?: string }
  completion: {
    repository: { id: string; url: string }
    metaSlot: { id: string; label: string }
  } | null
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * §5.3: a linked slot runs on the default login and any other under its home. Without either,
 * as with `slot_claude_probe`, the launcher refuses it, so it is no connection.
 */
const hasLogin = (slot: StoreDoc): boolean => !lacksHome(slot)

/**
 * Why this slot cannot run the meta agent, or null when it can. The one predicate: the route
 * refuses with this reason and the screen offers what it allows. The real brain launches Claude
 * with `CLAUDE_CONFIG_DIR` alone, so a slot must be a signed-in Claude home; an API key would
 * never reach it.
 */
export function metaSlotRefusal(slot: StoreDoc): string | null {
  const label = text(slot.label) || text(slot.id)
  if (slot.state === 'retired') return `${label} is retired`
  if (slot.engine !== 'claude')
    return `${label} runs ${text(slot.engine)}; the meta agent runs on Claude only`
  if (slot.kind !== 'claude-sub') {
    return `${label} is an API-key slot; the meta agent launches on a signed-in Claude home`
  }
  if (!hasLogin(slot)) return `${label} has no home of its own, so it cannot launch`
  if (slot.state !== 'healthy')
    return `${label} is not healthy (${text(slot.state_reason) || text(slot.state)})`
  return null
}

export function skippedSteps(store: Store): SetupStep[] {
  const skipped = store.engines.get(SETUP_DOC_ID)?.skipped
  return Array.isArray(skipped) ? SETUP_STEPS.filter((step) => skipped.includes(step)) : []
}

function repositoriesOf(store: Store): StoreDoc[] {
  return store.engines.list().filter((doc) => String(doc.id).startsWith(REPOSITORY_PREFIX))
}

const hasChecks = (repo: StoreDoc): boolean => Array.isArray(repo.checks) && repo.checks.length > 0

export function buildReadiness(store: Store, engines: Readiness['engines']): Readiness {
  const skipped = skippedSteps(store)
  const slots = store.slots.list()
  const repositories = repositoriesOf(store)
  const usableRepository = repositories.find(hasChecks)

  const metaCandidates: MetaCandidate[] = slots.map((slot) => {
    const reason = metaSlotRefusal(slot)
    return {
      id: String(slot.id),
      label: text(slot.label),
      engine: text(slot.engine),
      kind: text(slot.kind),
      state: text(slot.state),
      usable: reason === null,
      ...(reason !== null && { reason }),
    }
  })
  const chosenId = store.engines.get(META_SLOT_ID)?.slotId
  const metaSlotId = typeof chosenId === 'string' ? chosenId : null
  const chosen = metaSlotId === null ? undefined : store.slots.get(metaSlotId)
  const metaRefusal = chosen === undefined ? null : metaSlotRefusal(chosen)
  const metaReady = chosen !== undefined && metaRefusal === null

  const found = engines.filter((engine) => engine.installed)
  const connections = slots.filter(hasLogin)
  const healthy = connections.filter((slot) => slot.state === 'healthy')
  const firstRequest = store.workItems.list().some((work) => typeof work.repoId === 'string')

  const facts: Record<SetupStep, boolean> = {
    engines: found.length > 0,
    connection: healthy.length > 0,
    repository: usableRepository !== undefined,
    meta_slot: metaReady,
    first_request: firstRequest,
  }
  const statusOf = (id: SetupStep): StepStatus =>
    facts[id] ? 'done' : skipped.includes(id) ? 'skipped' : 'missing'

  const steps: ReadinessStep[] = [
    {
      id: 'engines',
      title: 'Engines',
      status: statusOf('engines'),
      detail: facts.engines
        ? `Found ${found.map((engine) => `${engine.engine} ${engine.version ?? ''}`.trim()).join(', ')}.`
        : 'No engine was found on PATH. Install Claude Code, Codex or OpenCode, then check again.',
      next: null,
    },
    {
      id: 'connection',
      title: 'Connection',
      status: statusOf('connection'),
      detail: facts.connection
        ? `${healthy.length} usable ${healthy.length === 1 ? 'connection' : 'connections'}.`
        : connections.length === 0
          ? 'No connection yet.'
          : 'A connection exists, but none has passed a health check.',
      next: facts.connection ? null : { label: 'Open Connections', route: 'slots' },
    },
    {
      id: 'repository',
      title: 'Repository',
      status: statusOf('repository'),
      detail: facts.repository
        ? `${text(usableRepository?.url)} has a check profile.`
        : repositories.length === 0
          ? 'No repository yet.'
          : 'A repository is registered, but none has a check profile.',
      next: facts.repository
        ? null
        : repositories.length === 0
          ? { label: 'Add a repository', route: 'setup' }
          : { label: 'Open Repositories', route: 'settings' },
    },
    {
      id: 'meta_slot',
      title: 'Meta agent',
      status: statusOf('meta_slot'),
      detail: metaReady
        ? `The meta agent runs on ${text(chosen?.label)}.`
        : metaRefusal !== null
          ? `The chosen slot cannot run it: ${metaRefusal}.`
          : metaSlotId !== null
            ? 'The chosen slot no longer exists.'
            : 'No slot chosen yet.',
      next: metaReady ? null : { label: 'Choose a slot', route: 'setup' },
    },
    {
      id: 'first_request',
      title: 'First request',
      status: statusOf('first_request'),
      detail: firstRequest ? 'A request has reached a repository.' : 'No request yet.',
      next: firstRequest ? null : { label: 'Open Conversation', route: 'chat' },
    },
  ]

  const blocked = steps.find((step) => PREREQUISITES.includes(step.id) && step.status !== 'done')
  const finish = blocked
    ? {
        enabled: false,
        reason:
          blocked.status === 'skipped'
            ? `${blocked.title} was skipped and is still needed.`
            : `${blocked.title} is still needed: ${blocked.detail}`,
      }
    : { enabled: true }

  return {
    steps,
    engines,
    metaCandidates,
    metaSlotId,
    finish,
    completion:
      blocked === undefined && usableRepository !== undefined && chosen !== undefined
        ? {
            repository: { id: String(usableRepository.id), url: text(usableRepository.url) },
            metaSlot: { id: String(chosen.id), label: text(chosen.label) },
          }
        : null,
  }
}
