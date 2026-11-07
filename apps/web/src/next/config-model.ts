/**
 * The configuration surfaces' pure model: wire types, the save state of one block, and the words
 * and gates the views show. No React and no I/O, so vitest proves it without a browser.
 */

// ─── Wire types (decoded in config-decode.ts) ───────────────────────────────────

export type StepStatus = 'done' | 'missing' | 'skipped' | 'checking'
export type StepRoute = 'setup' | 'slots' | 'settings' | 'chat'
export interface ReadinessStep {
  id: string
  title: string
  status: StepStatus
  detail: string
  next: { label: string; route: StepRoute } | null
}
export interface MetaCandidate {
  id: string
  label: string
  engine: string
  kind: string
  state: string
  usable: boolean
  reason?: string
}
export interface EngineProbe {
  engine: string
  installed: boolean
  version?: string
}
export interface Readiness {
  steps: ReadinessStep[]
  engines: EngineProbe[]
  metaCandidates: MetaCandidate[]
  metaSlotId: string | null
  finish: { enabled: boolean; reason?: string }
  completion: {
    repository: { id: string; url: string }
    metaSlot: { id: string; label: string }
  } | null
}

export interface ConnectionRow {
  id: string
  label: string
  engine: string
  kind: string
  provider: string
  state: string
  linked: boolean
  credential: 'sign_in' | 'api_key'
  stateReason?: string
  engineVersion?: string
  identity?: { email?: string; plan?: string }
  lastProbeAt?: string
  fingerprint?: { provider: string; last4: string }
  /** Absent means unset: the scheduler's own default applies, and the row never invents one. */
  concurrency?: number
  slotClass?: string
  usage: null
  pin: null
  pair: null
}
/** One answer in the setup chat. `drafts` proposals wait in Settings. */
export interface SetupAnswer {
  reply: string
  drafts: number
}
export type ConnectionPath = 'link' | 'sign_in' | 'api_key'
export interface ConnectionOption {
  engine: string
  paths: ConnectionPath[]
  providers: Array<{ id: string; label: string }>
}
export interface Connections {
  rows: ConnectionRow[]
  options: ConnectionOption[]
}
export interface SlotImpact {
  slotId: string
  label: string
  running: number
  queued: number
  metaSlot: boolean
  keyStored: boolean
}

export interface Capabilities {
  switchWork: boolean
  drain: boolean
  backups: boolean
  isolationEdit: boolean
  pause: boolean
}

export interface PolicyView {
  text: string
  sha256: string
  revision: number
  source: 'saved' | 'default'
  activeSha256: string
  restartRequired: boolean
  updatedAt?: string
}
export interface ModelsSummary {
  tiers: readonly string[]
  engines: readonly { engine: string; models: readonly { id: string; tier: string }[] }[]
}
export interface ModelsText {
  yaml: string
  sha256: string
  source: 'user' | 'default'
  summary: ModelsSummary
}
export interface PromptPartView {
  path: string
  layer: string
  name: string
  edited: boolean
  defaultUpdated: boolean
  provenance: string
}
export interface PromptsConfig {
  revision: number
  parts: PromptPartView[]
  overrides: Record<string, string>
}
export interface PromptChange {
  path: string
  oldDefault?: string
  newDefault?: string
}
export interface RepositoryView {
  id: string
  url: string
  bootstrap: string[]
  checks: CheckProfile[]
  trust: boolean
  revision: string
  /** When the owner agreed to runs on this machine; null means nothing runs here. */
  hostRunAgreedAt: string | null
  /** Open work items only that agreement holds back. */
  waiting: number
}
export interface CheckProfile {
  name: string
  cmd: string
}
export interface DraftPreview {
  /** The version `before` was read at. */
  base: string | number
  changes: Array<{ label: string; before: string; after: string }>
}
export interface DraftView {
  id: string
  target: string
  reason: string
  diff: string
  status: string
  createdAt: string
  cls?: string
  /** Absent when there is nothing to compare with, as for a new repository. */
  preview?: DraftPreview
  /** A repository proposal carried a trust setting, which only Settings can set. */
  trustIgnored?: boolean
}
export interface BackupsRecord {
  lastAt?: string
  note: string
  excluded: string
}

// ─── One block's save state ─────────────────────────────────────────────────────

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'failed'; message: string; stale: boolean }

export interface Editor {
  /** The text last confirmed by the server. */
  base: string
  /** What a save names as its base: a hash or a revision. */
  version: string
  /** Null when nothing differs from `base`. */
  draft: string | null
  save: SaveState
}

/** A read fills an empty editor. It never moves a draft: that would hide a stale base. */
export function loadEditor(editor: Editor | undefined, base: string, version: string): Editor {
  if (editor !== undefined && (editor.draft !== null || editor.save.kind === 'saving')) return editor
  return { base, version, draft: null, save: editor?.save ?? { kind: 'idle' } }
}

export const editDraft = (editor: Editor, text: string): Editor => ({
  ...editor,
  draft: text === editor.base ? null : text,
  save: { kind: 'idle' },
})

export const saveStarted = (editor: Editor): Editor => ({ ...editor, save: { kind: 'saving' } })

export const saveFailed = (editor: Editor, failure: { message: string; stale: boolean }): Editor => ({
  ...editor,
  save: { kind: 'failed', ...failure },
})

/** Only this moves the base, and only after the server has answered. */
export const saveSucceeded = (editor: Editor, base: string, version: string): Editor => ({
  ...editor,
  base,
  version,
  draft: null,
  save: { kind: 'saved' },
})

/** The owner chose to carry their kept draft onto the newest version. */
export const rebaseDraft = (editor: Editor, base: string, version: string): Editor => ({
  ...editor,
  base,
  version,
  save: { kind: 'idle' },
})

export interface SaveBarView {
  visible: boolean
  message: string
  saving: boolean
  canSave: boolean
  stale: boolean
}

export function saveBar(editor: Editor): SaveBarView {
  const { save, draft } = editor
  const saving = save.kind === 'saving'
  const failed = save.kind === 'failed'
  const stale = failed && save.stale
  return {
    visible: draft !== null || saving || failed,
    message: saving
      ? 'Saving…'
      : stale
        ? 'A newer version was saved elsewhere. Your draft is kept and nothing was overwritten.'
        : failed
          ? `Not saved: ${save.message}`
          : 'Unsaved changes',
    saving,
    canSave: draft !== null && !saving && !stale,
    stale,
  }
}

// ─── Capabilities ───────────────────────────────────────────────────────────────

const CAPABILITY_REASONS: Record<keyof Capabilities, string> = {
  switchWork: 'This server cannot switch work to another connection.',
  drain: 'Draining a connection is not available in this release.',
  backups: 'This server cannot take a backup.',
  isolationEdit:
    'The specialist runner does not read a per-repository profile yet, so this cannot be edited here.',
  pause: 'This server cannot pause processing.',
}

export function capabilityGate(
  capabilities: Capabilities | null,
  name: keyof Capabilities,
): { enabled: true } | { enabled: false; reason: string } {
  if (capabilities?.[name] === true) return { enabled: true }
  return { enabled: false, reason: CAPABILITY_REASONS[name] }
}

// ─── Plain words ────────────────────────────────────────────────────────────────

const CLASS_WORDS: Readonly<Record<string, string>> = {
  install: 'Installing dependencies',
  migration: 'Database migrations',
  spend: 'Spending money',
  slot_switch: 'Switching connections',
  unsandboxed: 'Running outside the sandbox',
  close_own_pr: 'Closing its own pull requests',
}
const CAP_WORDS: Readonly<Record<string, { label: string; money?: boolean }>> = {
  globalActiveAttempts: { label: 'Runs at once' },
  budgetUsd: { label: 'Budget', money: true },
}
const ENGINE_WORDS: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function entryLine(cls: string, entries: readonly unknown[]): string {
  const name = CLASS_WORDS[cls] ?? cls
  if (entries.length > 1) return `${name}: allowed without asking, ${entries.length} rules.`
  const entry = isRecord(entries[0]) ? entries[0] : {}
  const scope = entry.scope === 'work_item' ? 'one piece of work' : 'one repository'
  const ceiling = typeof entry.maxUsd === 'number' ? `, up to $${entry.maxUsd}` : ''
  return `${name}: allowed without asking, for ${scope}${ceiling}.`
}

/** The saved policy as sentences, or null for text this cannot read: it never guesses at a rule. */
export function policySummary(text: string): string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const allowed = isRecord(parsed.preAuthorised) ? parsed.preAuthorised : {}
  const entries = Object.entries(allowed).flatMap(([cls, list]) =>
    Array.isArray(list) && list.length > 0 ? [entryLine(cls, list)] : [],
  )
  const caps = isRecord(parsed.capsOverride) ? Object.entries(parsed.capsOverride) : []
  const tightened = isRecord(parsed.repoTightening) ? Object.keys(parsed.repoTightening).length : 0
  return [
    ...(entries.length > 0 ? entries : ['MEC asks you before anything that needs a confirmation.']),
    ...caps.map(([key, value]) => {
      const cap = CAP_WORDS[key]
      return `${cap?.label ?? key}: at most ${cap?.money ? '$' : ''}${String(value)}.`
    }),
    ...(tightened > 0
      ? [`Tighter rules for ${tightened} ${tightened === 1 ? 'repository' : 'repositories'}.`]
      : []),
  ]
}

export function modelsSummaryLines(summary: ModelsSummary): string[] {
  return [
    `Tiers: ${summary.tiers.join(', ')}.`,
    ...summary.engines.map(({ engine, models }) => {
      const list = models.map((model) => `${model.id} (${model.tier})`).join(', ')
      return `${ENGINE_WORDS[engine] ?? engine}: ${list === '' ? 'no models listed' : list}.`
    }),
  ]
}

// ─── Parked work ────────────────────────────────────────────────────────────────

/** One parked attempt, as `GET /api/parked` states it (§5.10). */
export interface ParkedRow {
  workItemId: string
  workTitle: string
  attemptId: string
  slotId: string
  slotLabel: string
  state: string
  reason: string
  /** Null is what the provider left unsaid. */
  resetAt: string | null
  worktreeKept: boolean
}

const PARK_HEADINGS: Record<string, string> = {
  quota_wait: 'Parked: out of quota',
  auth_required: 'Parked: needs sign-in',
  provider_down: 'Parked: provider unreachable',
}

export function parkedFacts(row: ParkedRow, format: (iso: string) => string) {
  const known = row.resetAt !== null && !Number.isNaN(Date.parse(row.resetAt))
  return {
    heading: PARK_HEADINGS[row.state] ?? 'Parked',
    slot: row.slotLabel,
    reason: row.reason,
    reset: known ? `Resets ${format(row.resetAt as string)}` : 'Reset unknown',
    worktree: row.worktreeKept ? 'The worktree is kept' : 'No worktree on record',
  }
}

export interface ParkedMoves {
  signIn: boolean
  targets: ConnectionRow[]
  note: string | null
}

/**
 * What parked work may do. An auth park moves nowhere (§5.10), and the switch route answers for a
 * whole work item, so one auth park rules out a switch for its siblings too.
 */
export function parkedMoves(
  row: ParkedRow,
  all: readonly ParkedRow[],
  connections: readonly ConnectionRow[],
  capabilities: Capabilities | null,
): ParkedMoves {
  const siblings = all.filter((other) => other.workItemId === row.workItemId)
  if (siblings.some((other) => other.state === 'auth_required')) {
    return { signIn: row.state === 'auth_required', targets: [], note: null }
  }
  const gate = capabilityGate(capabilities, 'switchWork')
  if (!gate.enabled) return { signIn: false, targets: [], note: gate.reason }
  const parkedOn = new Set(siblings.map((other) => other.slotId))
  const targets = connections.filter(
    (connection) => connection.state === 'healthy' && !parkedOn.has(connection.id),
  )
  return {
    signIn: false,
    targets,
    note: targets.length === 0 ? 'No other healthy connection can take this work.' : null,
  }
}

export function switchPlan(row: ParkedRow, target: ConnectionRow) {
  return {
    title: `Switch this work to ${target.label}?`,
    lines: [
      `Moves ${row.workTitle} from ${row.slotLabel} to ${target.label}.`,
      'A new attempt starts on the same worktree with a handoff note. The session does not carry over.',
      'The parked attempt stays on the record and does not resume.',
    ],
    confirmLabel: `Switch to ${target.label}`,
  }
}

/** Only what the route answered: a card is not a move. */
export function switchResult(answer: { status: unknown }, target: ConnectionRow): string {
  if (answer.status === 'confirmation') {
    return `Confirmation opened. Approve it in Needs you to move this work to ${target.label}.`
  }
  if (answer.status === 'switched') return `Moved to ${target.label}. A new attempt is queued.`
  return 'The server gave no result. Check this work before trying again.'
}

const SWITCH_REFUSALS: Record<string, string> = {
  held: 'This work is on hold. Nothing moved.',
  nothing_parked: 'This work is no longer parked. Nothing moved.',
  auth_park_never_switches: 'Work waiting on a sign-in cannot move. Sign in again.',
  target_unhealthy: 'That connection is not healthy now. Nothing moved.',
  same_slot: 'This work is already on that connection.',
}

export const switchRefusal = (code: string): string =>
  SWITCH_REFUSALS[code] ?? `The switch was refused: ${code}. Nothing moved.`

// ─── Connections ────────────────────────────────────────────────────────────────

export interface ConnectionActions {
  /** A dedicated home signs in through a card; a linked one belongs to the vendor's own terminal. */
  signIn: 'card' | 'terminal' | null
  replaceKey: boolean
  validate: boolean
  probe: boolean
}

export function connectionActions(row: ConnectionRow): ConnectionActions {
  const apiKey = row.credential === 'api_key'
  const expired = row.stateReason === 'auth_expired'
  return {
    signIn: apiKey || !expired ? null : row.linked ? 'terminal' : 'card',
    replaceKey: apiKey,
    validate: apiKey,
    probe: !apiKey,
  }
}

export const canRetire = (typed: string, label: string): boolean => typed === label

const count = (n: number, word: string): string => `${n} ${word}`

/** What a retire does, in words, from the server's own impact read. */
export function impactLines(impact: SlotImpact): string[] {
  return [
    impact.keyStored
      ? 'The stored key is destroyed and cannot be recovered. You would need to paste it again.'
      : 'No key is stored here. MEC stops using this connection, and any vendor sign-in stays where it is.',
    impact.running + impact.queued === 0
      ? 'No work is running or queued on it.'
      : `${count(impact.running, 'running')} and ${count(impact.queued, 'queued')} on it will lose this connection.`,
    ...(impact.metaSlot ? ['It runs the meta agent. Choose another slot in Setup afterwards.'] : []),
  ]
}

// ─── Setup ──────────────────────────────────────────────────────────────────────

export const openStage = (steps: readonly ReadinessStep[]): string | null =>
  steps.find((step) => step.status === 'missing')?.id ?? null

/** Nothing is left to do here: every stage holds and the server names what setup ended on. */
export const setupDone = (readiness: Readiness): boolean =>
  readiness.completion !== null && readiness.steps.every((step) => step.status === 'done')

export function metaChoices(candidates: readonly MetaCandidate[]) {
  return {
    usable: candidates.filter((slot) => slot.usable),
    refused: candidates
      .filter((slot) => !slot.usable)
      .map((slot) => ({ id: slot.id, label: slot.label, reason: slot.reason ?? 'not usable' })),
  }
}

// ─── Repository forms ───────────────────────────────────────────────────────────

export const parseLines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

/** `name: command`, one a line. The `:` needs a space after it, so `a:b` stays a command. */
export function parseChecks(text: string): CheckProfile[] {
  return parseLines(text).map((line, index) => {
    const match = /^([^\s:]+):\s+(.+)$/.exec(line)
    return match?.[1] !== undefined && match[2] !== undefined
      ? { name: match[1], cmd: match[2] }
      : { name: `check_${index + 1}`, cmd: line }
  })
}

export const checksText = (checks: readonly CheckProfile[]): string =>
  checks.map((check) => `${check.name}: ${check.cmd}`).join('\n')

// ─── Proposals ──────────────────────────────────────────────────────────────────

export const draftsFor = (drafts: readonly DraftView[], target: string): DraftView[] =>
  drafts.filter((draft) => draft.target === target && draft.status === 'pending')

/** Apply answers for the comparison on screen: if the text moved since, the stale refusal fires. */
export const proposalBase = (draft: DraftView | undefined, newest: string | number | undefined) =>
  draft?.preview?.base ?? newest

/** `roles/reviewer.md` and `roles/meta_agent/protocol.md` both belong to a role by that name. */
export const roleOfPart = (path: string): string | null => /^roles\/([^/.]+)/.exec(path)?.[1] ?? null

// ─── Compare ────────────────────────────────────────────────────────────────────

export interface DiffLine {
  kind: 'same' | 'added' | 'removed'
  text: string
}

/** A longest-common-subsequence line diff; prompts are short enough for the square table. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const lengths = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  const at = (i: number, j: number): number => lengths[i]?.[j] ?? 0
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = lengths[i]
      if (row) row[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i] ?? '' })
      i += 1
      j += 1
    } else if (i < a.length && (j >= b.length || at(i + 1, j) >= at(i, j + 1))) {
      lines.push({ kind: 'removed', text: a[i] ?? '' })
      i += 1
    } else {
      lines.push({ kind: 'added', text: b[j] ?? '' })
      j += 1
    }
  }
  return lines
}

/** Unchanged lines kept on each side of a change. */
const DIFF_CONTEXT = 3

export type DiffRow = DiffLine | { kind: 'fold'; lines: DiffLine[] }

/**
 * Folds the unchanged runs, so the first change sits near the top of a block whatever the text's
 * length. A fold keeps the lines it hides, and one hidden line is shown: its fold would be no shorter.
 */
export function foldDiff(lines: readonly DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = []
  let at = 0
  while (at < lines.length) {
    const start = at
    while (lines[at]?.kind === 'same') at += 1
    const run = lines.slice(start, at)
    const head = start === 0 ? 0 : DIFF_CONTEXT
    const tail = at === lines.length ? 0 : DIFF_CONTEXT
    if (run.length - head - tail > 1) {
      rows.push(...run.slice(0, head))
      rows.push({ kind: 'fold', lines: run.slice(head, run.length - tail) })
      rows.push(...run.slice(run.length - tail))
    } else {
      rows.push(...run)
    }
    if (at < lines.length) {
      rows.push(lines[at] as DiffLine)
      at += 1
    }
  }
  return rows
}
