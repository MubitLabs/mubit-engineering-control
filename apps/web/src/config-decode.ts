/**
 * Decoders for the configuration routes, from `unknown` to the types in next/config-model.ts. A
 * payload that does not fit throws DecodeError and the screen shows its error state; a guess would
 * put invented configuration on screen. The harness feeds fixtures through these same functions.
 */

import { DecodeError } from './api-decode'
import type {
  BackupsRecord,
  Capabilities,
  ConnectionOption,
  ConnectionPath,
  ConnectionRow,
  Connections,
  DraftPreview,
  DraftView,
  MetaCandidate,
  ModelsText,
  ParkedRow,
  PolicyView,
  PromptChange,
  PromptPartView,
  PromptsConfig,
  Readiness,
  ReadinessStep,
  RepositoryView,
  SetupAnswer,
  SlotImpact,
  StepRoute,
  StepStatus,
} from './next/config-model'

type Obj = Record<string, unknown>

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function obj(path: string, value: unknown, what: string): Obj {
  if (!isObj(value)) throw new DecodeError(path, `${what} is not an object`)
  return value
}

function arr(path: string, value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new DecodeError(path, `${what} is not an array`)
  return value
}

function str(path: string, value: unknown, what: string): string {
  if (typeof value !== 'string') throw new DecodeError(path, `${what} is not a string`)
  return value
}

function num(path: string, value: unknown, what: string): number {
  if (typeof value !== 'number') throw new DecodeError(path, `${what} is not a number`)
  return value
}

const optional = <K extends string>(key: K, value: unknown) =>
  (typeof value === 'string' ? { [key]: value } : {}) as Partial<Record<K, string>>

const STATUSES: readonly StepStatus[] = ['done', 'missing', 'skipped', 'checking']
const ROUTES: readonly StepRoute[] = ['setup', 'slots', 'settings', 'chat']
const PATHS: readonly ConnectionPath[] = ['link', 'sign_in', 'api_key']

function decodeStep(path: string, raw: unknown, index: number): ReadinessStep {
  const step = obj(path, raw, `steps[${index}]`)
  const status = step.status as StepStatus
  if (!STATUSES.includes(status)) throw new DecodeError(path, `steps[${index}].status is unknown`)
  let next: ReadinessStep['next'] = null
  if (step.next !== null) {
    const raw = obj(path, step.next, `steps[${index}].next`)
    const route = raw.route as StepRoute
    if (!ROUTES.includes(route)) throw new DecodeError(path, `steps[${index}].next.route is unknown`)
    next = { label: str(path, raw.label, 'next.label'), route }
  }
  return {
    id: str(path, step.id, 'step.id'),
    title: str(path, step.title, 'step.title'),
    status,
    detail: str(path, step.detail, 'step.detail'),
    next,
  }
}

function decodeCandidate(path: string, raw: unknown): MetaCandidate {
  const slot = obj(path, raw, 'candidate')
  return {
    id: str(path, slot.id, 'candidate.id'),
    label: str(path, slot.label, 'candidate.label'),
    engine: str(path, slot.engine, 'candidate.engine'),
    kind: str(path, slot.kind, 'candidate.kind'),
    state: str(path, slot.state, 'candidate.state'),
    usable: slot.usable === true,
    ...optional('reason', slot.reason),
  }
}

export function decodeReadiness(raw: unknown): Readiness {
  const path = '/api/setup/readiness'
  const body = obj(path, raw, 'the body')
  const finish = obj(path, body.finish, 'finish')
  const completion =
    body.completion === null
      ? null
      : (() => {
          const done = obj(path, body.completion, 'completion')
          const repository = obj(path, done.repository, 'completion.repository')
          const metaSlot = obj(path, done.metaSlot, 'completion.metaSlot')
          return {
            repository: {
              id: str(path, repository.id, 'repository.id'),
              url: str(path, repository.url, 'repository.url'),
            },
            metaSlot: {
              id: str(path, metaSlot.id, 'metaSlot.id'),
              label: str(path, metaSlot.label, 'metaSlot.label'),
            },
          }
        })()
  return {
    steps: arr(path, body.steps, 'steps').map((step, index) => decodeStep(path, step, index)),
    engines: arr(path, body.engines, 'engines').map((entry) => {
      const engine = obj(path, entry, 'engine')
      return {
        engine: str(path, engine.engine, 'engine.engine'),
        installed: engine.installed === true,
        ...optional('version', engine.version),
      }
    }),
    metaCandidates: arr(path, body.metaCandidates, 'metaCandidates').map((slot) =>
      decodeCandidate(path, slot),
    ),
    metaSlotId: typeof body.metaSlotId === 'string' ? body.metaSlotId : null,
    finish: { enabled: finish.enabled === true, ...optional('reason', finish.reason) },
    completion,
  }
}

function decodeRow(path: string, raw: unknown): ConnectionRow {
  const row = obj(path, raw, 'row')
  const credential = row.credential
  if (credential !== 'sign_in' && credential !== 'api_key') {
    throw new DecodeError(path, 'row.credential is unknown')
  }
  const identity = isObj(row.identity)
    ? { ...optional('email', row.identity.email), ...optional('plan', row.identity.plan) }
    : undefined
  const fingerprint = isObj(row.fingerprint)
    ? {
        provider: str(path, row.fingerprint.provider, 'fingerprint.provider'),
        last4: str(path, row.fingerprint.last4, 'fingerprint.last4'),
      }
    : undefined
  return {
    id: str(path, row.id, 'row.id'),
    label: str(path, row.label, 'row.label'),
    engine: str(path, row.engine, 'row.engine'),
    kind: str(path, row.kind, 'row.kind'),
    provider: str(path, row.provider, 'row.provider'),
    state: str(path, row.state, 'row.state'),
    linked: row.linked === true,
    credential,
    ...optional('stateReason', row.stateReason),
    ...optional('engineVersion', row.engineVersion),
    ...optional('lastProbeAt', row.lastProbeAt),
    ...(typeof row.concurrency === 'number' && { concurrency: row.concurrency }),
    ...optional('slotClass', row.slotClass),
    ...(identity !== undefined && { identity }),
    ...(fingerprint !== undefined && { fingerprint }),
    usage: null,
    pin: null,
    pair: null,
  }
}

function decodeOption(path: string, raw: unknown): ConnectionOption {
  const option = obj(path, raw, 'option')
  return {
    engine: str(path, option.engine, 'option.engine'),
    paths: arr(path, option.paths, 'option.paths').map((entry) => {
      if (!PATHS.includes(entry as ConnectionPath)) throw new DecodeError(path, 'option.paths is unknown')
      return entry as ConnectionPath
    }),
    providers: arr(path, option.providers, 'option.providers').map((entry) => {
      const provider = obj(path, entry, 'provider')
      return {
        id: str(path, provider.id, 'provider.id'),
        label: str(path, provider.label, 'provider.label'),
      }
    }),
  }
}

export function decodeConnections(raw: unknown): Connections {
  const path = '/api/connections'
  const body = obj(path, raw, 'the body')
  return {
    rows: arr(path, body.rows, 'rows').map((row) => decodeRow(path, row)),
    options: arr(path, body.options, 'options').map((option) => decodeOption(path, option)),
  }
}

export function decodeImpact(raw: unknown): SlotImpact {
  const path = '/api/slots/:id/impact'
  const body = obj(path, raw, 'the body')
  return {
    slotId: str(path, body.slotId, 'slotId'),
    label: str(path, body.label, 'label'),
    running: num(path, body.running, 'running'),
    queued: num(path, body.queued, 'queued'),
    metaSlot: body.metaSlot === true,
    keyStored: body.keyStored === true,
  }
}

export function decodeParked(raw: unknown): ParkedRow[] {
  const path = '/api/parked'
  return arr(path, obj(path, raw, 'the body').rows, 'rows').map((entry, index) => {
    const label = `rows[${index}]`
    const row = obj(path, entry, label)
    return {
      workItemId: str(path, row.workItemId, `${label}.workItemId`),
      workTitle: str(path, row.workTitle, `${label}.workTitle`),
      attemptId: str(path, row.attemptId, `${label}.attemptId`),
      slotId: str(path, row.slotId, `${label}.slotId`),
      slotLabel: str(path, row.slotLabel, `${label}.slotLabel`),
      state: str(path, row.state, `${label}.state`),
      reason: str(path, row.reason, `${label}.reason`),
      resetAt: typeof row.resetAt === 'string' ? row.resetAt : null,
      worktreeKept: row.worktreeKept === true,
    }
  })
}

/** A flag the server did not send, or sent as anything but `true`, is off: never assumed on. */
export function decodeCapabilities(raw: unknown): Capabilities {
  const flags = isObj(raw) && isObj(raw.capabilities) ? raw.capabilities : {}
  return {
    switchWork: flags.switchWork === true,
    drain: flags.drain === true,
    backups: flags.backups === true,
    isolationEdit: flags.isolationEdit === true,
    pause: flags.pause === true,
  }
}

export function decodePolicy(raw: unknown): PolicyView {
  const path = '/api/policy'
  const body = obj(path, raw, 'the body')
  const source = body.source
  if (source !== 'saved' && source !== 'default') throw new DecodeError(path, 'source is unknown')
  return {
    text: str(path, body.text, 'text'),
    sha256: str(path, body.sha256, 'sha256'),
    revision: num(path, body.revision, 'revision'),
    source,
    activeSha256: str(path, body.activeSha256, 'activeSha256'),
    restartRequired: body.restartRequired === true,
    ...optional('updatedAt', body.updatedAt),
  }
}

export function decodeModelsText(raw: unknown): ModelsText {
  const path = '/api/models/text'
  const body = obj(path, raw, 'the body')
  const source = body.source
  if (source !== 'user' && source !== 'default') throw new DecodeError(path, 'source is unknown')
  const summary = obj(path, body.summary, 'summary')
  return {
    yaml: str(path, body.yaml, 'yaml'),
    sha256: str(path, body.sha256, 'sha256'),
    source,
    summary: {
      tiers: arr(path, summary.tiers, 'summary.tiers').map((tier) => str(path, tier, 'tier')),
      engines: arr(path, summary.engines, 'summary.engines').map((raw) => {
        const entry = obj(path, raw, 'summary engine')
        return {
          engine: str(path, entry.engine, 'summary engine'),
          models: arr(path, entry.models, 'summary models').map((model) => {
            const row = obj(path, model, 'summary model')
            return { id: str(path, row.id, 'model id'), tier: str(path, row.tier, 'model tier') }
          }),
        }
      }),
    },
  }
}

export function decodePromptsConfig(raw: unknown): PromptsConfig {
  const path = '/api/prompts'
  const body = obj(path, raw, 'the body')
  const parts = arr(path, body.parts, 'parts').map((entry): PromptPartView => {
    const part = obj(path, entry, 'part')
    return {
      path: str(path, part.id, 'part.id'),
      layer: str(path, part.layer, 'part.layer'),
      name: str(path, part.name, 'part.name'),
      edited: part.edited === true,
      defaultUpdated: part.defaultUpdated === true,
      provenance: str(path, part.provenance, 'part.provenance'),
    }
  })
  const overrides: Record<string, string> = {}
  for (const entry of arr(path, body.overrides, 'overrides')) {
    const override = obj(path, entry, 'override')
    overrides[str(path, override.path, 'override.path')] = str(path, override.text, 'override.text')
  }
  return { revision: num(path, body.revision, 'revision'), parts, overrides }
}

/** `{ parts: [{ path, text }] }`: both `/api/prompts/defaults` and a revision snapshot. */
export function decodePartTexts(raw: unknown, path: string): Record<string, string> {
  const body = obj(path, raw, 'the body')
  const texts: Record<string, string> = {}
  for (const entry of arr(path, body.parts, 'parts')) {
    const part = obj(path, entry, 'part')
    texts[str(path, part.path, 'part.path')] = str(path, part.text, 'part.text')
  }
  return texts
}

/** §16.3: what a Default-updated part changed from. A default history no longer holds stays absent. */
export function decodeChanges(raw: unknown): PromptChange[] {
  const path = '/api/prompts/changes'
  const body = obj(path, raw, 'the body')
  const textOf = (value: unknown): string | undefined =>
    isObj(value) && typeof value.text === 'string' ? value.text : undefined
  return arr(path, body.changes, 'changes').map((entry) => {
    const change = obj(path, entry, 'change')
    const oldDefault = textOf(change.oldDefault)
    const newDefault = textOf(change.newDefault)
    return {
      path: str(path, change.path, 'change.path'),
      ...(oldDefault !== undefined && { oldDefault }),
      ...(newDefault !== undefined && { newDefault }),
    }
  })
}

export function decodePreview(raw: unknown): { revision: string; text: string } {
  const path = '/api/prompts/preview'
  const body = obj(path, raw, 'the body')
  return { revision: str(path, body.revision, 'revision'), text: str(path, body.text, 'text') }
}

export function decodeRepositories(raw: unknown): RepositoryView[] {
  const path = '/api/repositories'
  return arr(path, raw, 'the body').map((entry) => {
    const repo = obj(path, entry, 'repository')
    return {
      id: str(path, repo.id, 'repository.id'),
      url: str(path, repo.url, 'repository.url'),
      bootstrap: arr(path, repo.bootstrap, 'bootstrap').map((cmd) => str(path, cmd, 'bootstrap entry')),
      checks: arr(path, repo.checks, 'checks').map((check) => {
        const profile = obj(path, check, 'check')
        return { name: str(path, profile.name, 'check.name'), cmd: str(path, profile.cmd, 'check.cmd') }
      }),
      trust: repo.trust === true,
      revision: str(path, repo.revision, 'repository.revision'),
      hostRunAgreedAt: typeof repo.hostRunAgreedAt === 'string' ? repo.hostRunAgreedAt : null,
      waiting: typeof repo.waiting === 'number' ? repo.waiting : 0,
    }
  })
}

function decodeDraftPreview(path: string, raw: unknown): DraftPreview {
  const preview = obj(path, raw, 'draft.preview')
  const { base } = preview
  return {
    base: typeof base === 'number' ? base : str(path, base, 'draft.preview.base'),
    changes: arr(path, preview.changes, 'draft.preview.changes').map((entry) => {
      const change = obj(path, entry, 'draft.preview.change')
      return {
        label: str(path, change.label, 'change.label'),
        before: str(path, change.before, 'change.before'),
        after: str(path, change.after, 'change.after'),
      }
    }),
  }
}

/** POST /api/chat/messages with `setup: true`. The secret guard answers in `message` instead. */
export function decodeSetupAnswer(raw: unknown): SetupAnswer {
  const path = '/api/chat/messages'
  const body = obj(path, raw, 'the body')
  return {
    reply: str(path, body.reply ?? body.message, 'reply'),
    drafts: Array.isArray(body.drafts) ? body.drafts.length : 0,
  }
}

export function decodeDrafts(raw: unknown): DraftView[] {
  const path = '/api/setup/drafts'
  return arr(path, raw, 'the body').map((entry) => {
    const draft = obj(path, entry, 'draft')
    return {
      id: str(path, draft.id, 'draft.id'),
      target: str(path, draft.target, 'draft.target'),
      reason: str(path, draft.reason, 'draft.reason'),
      diff: str(path, draft.diff, 'draft.diff'),
      status: str(path, draft.status, 'draft.status'),
      createdAt: str(path, draft.createdAt, 'draft.createdAt'),
      ...optional('cls', draft.cls),
      ...(draft.preview !== undefined && { preview: decodeDraftPreview(path, draft.preview) }),
      ...(draft.trustIgnored === true && { trustIgnored: true }),
    }
  })
}

export function decodeBackupsRecord(raw: unknown): BackupsRecord {
  const path = '/api/backups'
  const body = obj(path, raw, 'the body')
  return {
    ...optional('lastAt', body.lastAt),
    note: str(path, body.note, 'note'),
    excluded: str(path, body.excluded, 'excluded'),
  }
}
