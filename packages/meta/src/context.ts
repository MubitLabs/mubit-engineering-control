/**
 * The §5.1 context compiler (T5, review 2026-11-04 §5.1): the deterministic, bounded
 * snapshot of everything the meta agent sees per turn — conversation with routing, open
 * work with stage/tasks/questions/holds/blockers, pending confirmations, slots with
 * utilisation-or-unknown and available tiers, budgets, the policy digest, the capability
 * table (available entries only, vendor_says verbatim) and scorecard hints that accept
 * "unknown for now".
 *
 * Every section is bounded (sizes from plan §6's read-resource defaults — lists 20, text
 * pages 4000 — kept conservative): constants below, exported for the tests. Honesty rules:
 * a utilisation that does not exist prints "unknown", never 0% (§5.9); scorecards without
 * data print exactly that; table entries withheld for being unavailable everywhere are
 * counted and said, so the planner can trust what remains.
 *
 * `plannerContextFromStore` builds the input from a live store — the seam the service and
 * the desktop routes share. Availability marks are supplied by the caller (they are a
 * probe result, I/O); a slot without marks is honestly unlisted.
 */
import type { Store, StoreDoc } from '@mec/contracts'
import type { Caps, ModelAvailability, ModelTier, SlotModelsView, TierTableLike } from '@mec/domain'
import { availableTiersOnSlot, tableEntries, WORK_ITEM_TERMINAL, type WorkItemState } from '@mec/domain'
import { loadPolicy } from '../../policy/src/policy'
import type { AttemptOutcome } from '../../scorecards/src/project'
import { hintsFor, projectTiers } from '../../scorecards/src/tiers'

/**
 * The capability table as the context reads it — a structural stand-in for the T1
 * `@mec/prompts` models module, which is being rebuilt on this branch. The caller
 * supplies it (`opts.modelsTable`); with no supplier wired the models section says so
 * honestly instead of inventing a table. The integrator swaps the seam for the real
 * loader when T1/T4 land.
 */
export type ModelsTableLike = TierTableLike & {
  engines: Record<
    string,
    {
      models?: Record<string, { tier: ModelTier; speed?: number; cost?: number; vendor_says?: string }>
      providers?: Record<
        string,
        { models: Record<string, { tier: ModelTier; speed?: number; cost?: number; vendor_says?: string }> }
      >
    }
  >
}

export type ModelsTableSource = {
  table: ModelsTableLike
  provenance: { sha256: string; origin: 'default' | 'user' }
}

// ── Bounds (plan §6 read-resource defaults, conservative) ───────────────────────────────────

export const CONTEXT_BOUNDS = {
  /** The conversation tail the planner sees (§5.1 "the last N messages"). */
  conversationMessages: 20,
  /** One message's text, truncated with an honest marker when longer. */
  messageChars: 400,
  /** Open work items in the work section (§6 list default). */
  workItems: 20,
  /** Tasks listed per work item. */
  tasksPerWorkItem: 20,
  /** Pending confirmations listed. */
  confirmations: 20,
  /** Slots listed. */
  slots: 20,
  /** Capability-table entries shown (available entries only). */
  modelEntries: 40,
  /** Scorecard hint rows shown. */
  scorecardRows: 20,
  /** Characters of vendor_says shown — verbatim by design, so this only guards pathology. */
  vendorSaysChars: 400,
} as const

// ── The snapshot shape ──────────────────────────────────────────────────────────────────────

export type PlannerConversationEntry = {
  id: string
  at: string
  text: string
  routing: string
  acknowledged?: boolean
}

export type PlannerWorkTask = {
  id: string
  /** The planner's own key for the task; absent on spawned and legacy tasks. */
  localKey?: string
  role?: string
  tier?: string
  slotId?: string
  state?: string
  head?: string
}

export type PlannerWorkItem = {
  id: string
  state: string
  stage: string
  tasks: PlannerWorkTask[]
  openQuestions: string[]
  holds: string[]
  blockers: string[]
}

export type PlannerAttemptRow = {
  id: string
  taskId?: string
  workItemId?: string
  slotId?: string
  state?: string
  terminalReason?: string
}

export type PlannerConfirmationRow = { id: string; cls: string; expiresAt: string }

export type PlannerSlotRow = {
  id: string
  engine: string
  provider?: string
  state: string
  /** Absent means no reading exists — printed as unknown, never 0 (§5.9). */
  utilisation?: number
  resetAt?: string
  availableTiers: ModelTier[]
}

export type PlannerBudgetRow = {
  workItemId: string
  turnsRemaining?: number
  wallClockRemainingMs?: number
  usdRemaining?: number
}

export type PlannerPolicyDigest = {
  caps: Caps
  preAuthorisedClasses: string[]
  /** §3 frontier: requires preauthorised — false unless the policy carries the class. */
  frontierAllowed: boolean
  policyHash: string
}

export type PlannerModelRow = {
  /** The probe mark key: `provider/id` on opencode, the bare id elsewhere. */
  key: string
  engine: string
  provider?: string
  id: string
  tier: ModelTier
  speed?: number
  cost?: number
  vendorSays: string
  availability: ModelAvailability
  onSlots: string[]
}

export type PlannerScorecardRow = {
  role: string
  tier: string | undefined
  successRate?: number
  repairRate?: number
  meanWallClockMs?: number
  attempts?: number
  /**
   * The best-known tier for the row's role, from `hintsFor` (T6) — present only when the
   * role's cells passed the evidence gate; §5.3's "the scorecard will tell us" answer.
   */
  bestTier?: string
}

export type PlannerContextInput = {
  /** Why this turn runs: the wake reason and, for a user message, its id and text. */
  turn: { wake: string; messageId?: string; messageText?: string }
  conversation: PlannerConversationEntry[]
  work: PlannerWorkItem[]
  attempts: PlannerAttemptRow[]
  confirmations: PlannerConfirmationRow[]
  slots: PlannerSlotRow[]
  budgets: PlannerBudgetRow[]
  todaySpend?: { slotId: string; usd: number }[]
  policy: PlannerPolicyDigest
  models: {
    provenance: { sha256: string; origin: 'default' | 'user' }
    rows: PlannerModelRow[]
    withheldCount: number
    /** Present when no table supplier is wired — the honest not-in-this-build line. */
    note?: string
  }
  /** A provider that may answer "unknown for now" (§5.5: unknown until data exists). */
  scorecards?: () => PlannerScorecardRow[] | undefined
  bundleRevision?: string
}

// ── The compiler ────────────────────────────────────────────────────────────────────────────

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…(truncated)`

const last = <T>(rows: readonly T[], max: number): T[] => (rows.length <= max ? [...rows] : rows.slice(-max))

function conversationSection(input: PlannerContextInput): string {
  const rows = last(input.conversation, CONTEXT_BOUNDS.conversationMessages)
  const omitted = input.conversation.length - rows.length
  const lines = rows.map((entry) => {
    const ack = entry.acknowledged ? ' acked' : ''
    return `- ${entry.id} [${entry.routing}${ack}] ${truncate(entry.text.replace(/\s+/g, ' ').trim(), CONTEXT_BOUNDS.messageChars)}`
  })
  return [
    `conversation: last ${rows.length} message(s)${omitted > 0 ? ` (${omitted} older omitted)` : ''}`,
    ...(lines.length > 0 ? lines : ['- (none yet — this is the first message)']),
  ].join('\n')
}

function workSection(input: PlannerContextInput): string {
  const open = input.work.filter((item) => !WORK_ITEM_TERMINAL.includes(item.state as WorkItemState))
  const rows = open.slice(0, CONTEXT_BOUNDS.workItems)
  const omitted = open.length - rows.length
  const lines = rows.map((item) => {
    const tasks = item.tasks.slice(0, CONTEXT_BOUNDS.tasksPerWorkItem)
    const taskOmitted = item.tasks.length - tasks.length
    const taskLines = tasks.map((task) => {
      const bits = [
        task.role ?? 'role:?',
        task.tier !== undefined ? `tier:${task.tier}` : 'tier:default',
        task.slotId !== undefined ? `slot:${task.slotId}` : 'slot:-',
        task.state !== undefined ? `state:${task.state}` : 'state:?',
        task.head !== undefined ? `head:${task.head}` : 'head:-',
      ].join(' ')
      return `    - ${task.id}${task.localKey !== undefined ? ` (key ${task.localKey})` : ''} [${bits}]`
    })
    return [
      `- ${item.id} stage="${item.stage}" state=${item.state}` +
        (item.openQuestions.length > 0 ? ` questions=${item.openQuestions.join(',')}` : '') +
        (item.holds.length > 0 ? ` holds=${item.holds.join(',')}` : '') +
        (item.blockers.length > 0 ? ` blockers=${item.blockers.join(',')}` : '') +
        (taskOmitted > 0 ? ` (+${taskOmitted} more tasks omitted)` : ''),
      ...taskLines,
    ].join('\n')
  })
  return [
    `work: ${rows.length} open work item(s)${omitted > 0 ? ` (${omitted} older omitted)` : ''}`,
    ...(lines.length > 0 ? lines : ['- (no open work — a fresh request)']),
  ].join('\n')
}

function confirmationsSection(input: PlannerContextInput): string {
  const rows = input.confirmations.slice(0, CONTEXT_BOUNDS.confirmations)
  const lines = rows.map((row) => `- ${row.id} class=${row.cls} expires=${row.expiresAt}`)
  return [
    `confirmations: ${rows.length} pending card(s)`,
    ...(lines.length > 0 ? lines : ['- (none pending)']),
  ].join('\n')
}

function slotsSection(input: PlannerContextInput): string {
  const rows = input.slots.slice(0, CONTEXT_BOUNDS.slots)
  const lines = rows.map(
    (slot) =>
      `- ${slot.id} · ${slot.engine}${slot.provider !== undefined ? ` · ${slot.provider}` : ''} · ${slot.state}` +
      ` · utilisation: ${slot.utilisation !== undefined ? `${Math.round(slot.utilisation * 100)}%` : 'unknown'}` +
      (slot.resetAt !== undefined ? ` · resets ${slot.resetAt}` : '') +
      ` · available tiers: ${slot.availableTiers.length > 0 ? slot.availableTiers.join(', ') : 'none marked available'}`,
  )
  return [
    `slots: ${rows.length} slot(s)${input.slots.length > rows.length ? ` (${input.slots.length - rows.length} omitted)` : ''}`,
    ...(lines.length > 0 ? lines : ['- (no slots configured)']),
  ].join('\n')
}

function budgetsSection(input: PlannerContextInput): string {
  const rows = input.budgets.slice(0, CONTEXT_BOUNDS.workItems)
  const lines = rows.map(
    (row) =>
      `- ${row.workItemId}: turns ${
        row.turnsRemaining !== undefined ? String(row.turnsRemaining) : 'unknown'
      }, wall-clock ${
        row.wallClockRemainingMs !== undefined ? `${row.wallClockRemainingMs}ms` : 'unknown'
      }, usd ${row.usdRemaining !== undefined ? String(row.usdRemaining) : 'unknown'}`,
  )
  const spend =
    input.todaySpend !== undefined && input.todaySpend.length > 0
      ? input.todaySpend.map((row) => `${row.slotId}=$${row.usd}`).join(', ')
      : 'unknown (no spend ledger on subscription slots in this build)'
  return [
    `budgets: ${rows.length} work item(s) with a budget`,
    ...(lines.length > 0 ? lines : ['- (none recorded — no budget ledger yet)']),
    `today's spend per API slot: ${spend}`,
  ].join('\n')
}

function policySection(input: PlannerContextInput): string {
  const caps = input.policy.caps
  return [
    'policy:',
    `- caps: global ${caps.globalActiveAttempts}, per work item ${caps.perWorkItem}, per slot ${caps.perSlot}, fan-out ${caps.fanOut}, depth ${caps.agentDepth}, repairs ${caps.repairAttemptsPerTask}`,
    `- pre-authorised classes: ${
      input.policy.preAuthorisedClasses.length > 0 ? input.policy.preAuthorisedClasses.join(', ') : 'none'
    }`,
    `- frontier allowed: ${input.policy.frontierAllowed ? 'yes (pre-authorised)' : 'no — frontier is never autonomous; it needs a frontier_model confirmation'}`,
    `- policy hash: ${input.policy.policyHash}`,
  ].join('\n')
}

function modelsSection(input: PlannerContextInput): string {
  const rows = input.models.rows.slice(0, CONTEXT_BOUNDS.modelEntries)
  const lines = rows.map((row) => {
    const provider = row.provider !== undefined ? `${row.provider}/` : ''
    const facts = [
      `tier:${row.tier}`,
      row.speed !== undefined ? `speed:${row.speed}` : null,
      row.cost !== undefined ? `cost:${row.cost}` : null,
      `on:${row.onSlots.length > 0 ? row.onSlots.join('+') : 'no slot'}`,
    ]
      .filter((part): part is string => part !== null)
      .join(' ')
    return `- ${row.engine} ${provider}${row.id} [${facts}] vendor_says: "${truncate(row.vendorSays, CONTEXT_BOUNDS.vendorSaysChars)}"`
  })
  return [
    `models: capability table ${input.models.provenance.origin} (sha256 ${input.models.provenance.sha256.slice(0, 16)}…), available entries only — ${rows.length} shown`,
    ...(lines.length > 0
      ? lines
      : [
          '- (no entry is marked available on any healthy slot — tiers cannot be validated; drop model_request or probe the slots)',
        ]),
    ...(input.models.note !== undefined ? [`(${input.models.note})`] : []),
    ...(input.models.withheldCount > 0
      ? [
          `(${input.models.withheldCount} table entr${input.models.withheldCount === 1 ? 'y is' : 'ies are'} withheld: unavailable or unlisted everywhere — unlisted means unprobed on that engine, not offered)`,
        ]
      : []),
  ].join('\n')
}

function scorecardsSection(input: PlannerContextInput): string {
  const rows = input.scorecards?.() ?? undefined
  if (rows === undefined || rows.length === 0) {
    return 'scorecard hints: unknown for now (no role×tier data exists yet — choose tiers on the planning rules)'
  }
  const shown = rows.slice(0, CONTEXT_BOUNDS.scorecardRows)
  const lines = shown.map((row) => {
    const cell = (value: number | undefined, unit: string): string =>
      value !== undefined ? `${value}${unit}` : '?'
    return `- ${row.role} × ${row.tier}: success ${cell(row.successRate !== undefined ? row.successRate * 100 : undefined, '%')}, repair ${cell(row.repairRate !== undefined ? row.repairRate * 100 : undefined, '%')}, wall-clock ${cell(row.meanWallClockMs, 'ms')}${row.bestTier !== undefined ? `, best so far: ${row.bestTier}` : ''}${row.attempts !== undefined ? `, ${row.attempts} attempts` : ''}`
  })
  return [
    `scorecard hints: ${shown.length} row(s)${rows.length > shown.length ? ` (${rows.length - shown.length} omitted)` : ''}`,
    ...lines,
  ].join('\n')
}

// ── The T6 scorecard-hints wiring (review 2026-11-04 §5.5) ─────────────────────────────────

/**
 * The §5.1 scorecard-hint rows for one repository, built on T6's committed projection:
 * `projectTiers` supplies the role×tier cells (gate-respecting — a cell below
 * `MIN_TIER_CELL_ATTEMPTS` carries nulls, which map to absent fields and print '?' — never
 * a thin-sample rate), and `hintsFor` names the best-known tier per role, set as
 * `bestTier` only when the evidence gate passed. Unknown-tier cells and other repositories
 * are excluded: the planner cannot choose a rung the rows failed to name. The rows come
 * from the nightly `scorecards/tiers` job once attempts carry tier decoration; until then
 * the honest provider is "unknown for now".
 */
export function plannerScorecardHints(
  repository: string,
  rows: readonly AttemptOutcome[],
): PlannerScorecardRow[] {
  const cells = projectTiers(rows).filter((cell) => cell.repository === repository && cell.tier !== undefined)
  const hints = hintsFor(repository, undefined, rows)
  const bestTierByRole = hints.known
    ? new Map(hints.orderings.map((ordering) => [ordering.role, ordering.ordering[0]]))
    : new Map<string, string | undefined>()
  return cells.map((cell) => ({
    role: cell.role,
    tier: cell.tier,
    ...(cell.successRate !== null && { successRate: cell.successRate }),
    ...(cell.repairRate !== null && { repairRate: cell.repairRate }),
    ...(cell.meanWallClockMs !== null && { meanWallClockMs: cell.meanWallClockMs }),
    attempts: cell.attempts,
    ...(bestTierByRole.get(cell.role) !== undefined && { bestTier: bestTierByRole.get(cell.role) }),
  }))
}

/**
 * Compiles the `<state>` block (§5.1). Deterministic: the same input always compiles to
 * the same text, section order fixed, every section bounded.
 */
export function compilePlannerContext(input: PlannerContextInput): string {
  const wake =
    input.turn.messageText !== undefined
      ? `${input.turn.wake} (message ${input.turn.messageId ?? '?'}): ${input.turn.messageText}`
      : input.turn.wake
  return [
    '<state>',
    `turn: woken by ${truncate(wake.replace(/\s+/g, ' ').trim(), CONTEXT_BOUNDS.messageChars * 2)}`,
    conversationSection(input),
    workSection(input),
    confirmationsSection(input),
    slotsSection(input),
    budgetsSection(input),
    policySection(input),
    modelsSection(input),
    scorecardsSection(input),
    ...(input.bundleRevision !== undefined ? [`bundle: pinned to revision ${input.bundleRevision}`] : []),
    '</state>',
  ].join('\n')
}

// ── The store snapshot builder ──────────────────────────────────────────────────────────────

/** Slot docs as the slot section sees them (marks supplied by the caller; unlisted without). */
export function slotViewsFromStore(
  store: Store,
  marks?: Record<string, Record<string, ModelAvailability>>,
): SlotModelsView[] {
  return store.slots.list().map((doc) => ({
    slotId: String(doc.id ?? ''),
    engine: typeof doc.engine === 'string' ? doc.engine : '',
    healthy: String(doc.state ?? '') === 'healthy',
    marks: marks?.[String(doc.id ?? '')] ?? {},
  }))
}

/** Builds the planner's model rows: table entries that are AVAILABLE somewhere (§3 rule 2). */
export function modelRowsFromTable(
  table: ModelsTableLike,
  slots: readonly SlotModelsView[],
): { rows: PlannerModelRow[]; withheldCount: number } {
  const rows: PlannerModelRow[] = []
  let withheld = 0
  for (const entry of tableEntries(table)) {
    const engineDef = table.engines[entry.engine] as
      | {
          models?: Record<string, { speed?: number; cost?: number; vendor_says: string }>
          providers?: Record<
            string,
            { models: Record<string, { speed?: number; cost?: number; vendor_says: string }> }
          >
        }
      | undefined
    const modelEntry =
      engineDef?.models?.[entry.id] ??
      (entry.provider !== undefined ? engineDef?.providers?.[entry.provider]?.models?.[entry.id] : undefined)
    const key = entry.provider !== undefined ? `${entry.provider}/${entry.id}` : entry.id
    const sameEngine = slots.filter((slot) => slot.healthy && slot.engine === entry.engine)
    const mark = (slot: SlotModelsView): ModelAvailability => slot.marks[key] ?? 'unlisted'
    const onSlots = sameEngine.filter((slot) => mark(slot) === 'available').map((slot) => slot.slotId)
    if (onSlots.length === 0) {
      // Unavailable everywhere, or unlisted (unprobed on this engine — Claude/Codex in v0):
      // withheld from the planner with the count said out loud, never shown as usable.
      withheld += 1
      continue
    }
    rows.push({
      key,
      engine: entry.engine,
      ...(entry.provider !== undefined && { provider: entry.provider }),
      id: entry.id,
      tier: entry.tier,
      ...(modelEntry?.speed !== undefined && { speed: modelEntry.speed }),
      ...(modelEntry?.cost !== undefined && { cost: modelEntry.cost }),
      vendorSays: modelEntry?.vendor_says ?? '(the table carries no vendor note for this entry)',
      availability: 'available',
      onSlots,
    })
  }
  return { rows, withheldCount: withheld }
}

/**
 * Assembles the full §5.1 input from a live store: conversation tail, open work with
 * tasks and latest attempts, pending confirmations, slots (marks supplied or honestly
 * unlisted), the policy digest from the policy text, and — when a table supplier is
 * wired (`opts.modelsTable`) — the capability table filtered to available entries.
 * Budgets read off task docs when they carry one — no budget ledger exists yet, so
 * absence prints unknown, never a made-up number.
 */
export function plannerContextFromStore(
  store: Store,
  opts: {
    turn: PlannerContextInput['turn']
    policyText: string
    caps: Caps
    marks?: Record<string, Record<string, ModelAvailability>>
    modelsTable?: () => ModelsTableSource | undefined
    scorecards?: () => PlannerScorecardRow[] | undefined
    bundleRevision?: string
    todaySpend?: { slotId: string; usd: number }[]
    /**
     * One repository's view (§12.1, decision #10). An Unassigned turn sees only its own work
     * item, so a legacy row is out of the planner's reach. Absent means every repository.
     */
    repoScope?: { repoId?: string; workItemId?: string }
  },
): PlannerContextInput {
  const scope = opts.repoScope
  const inScope = (doc: StoreDoc): boolean => {
    if (scope === undefined) return true
    if (scope.repoId !== undefined) return doc.repoId === scope.repoId
    return doc.repoId === undefined && doc.id === scope.workItemId
  }
  const scopedWork = new Set(
    store.workItems
      .list()
      .filter(inScope)
      .map((doc) => doc.id),
  )
  const conversation = [...store.messages.list()]
    .filter((doc) => scope === undefined || doc.repoId === scope.repoId)
    .sort(
      (a, b) =>
        String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) ||
        String(a.id).localeCompare(String(b.id)),
    )
    .map((doc) => ({
      id: String(doc.id),
      at: String(doc.createdAt ?? ''),
      text: String(doc.text ?? ''),
      routing: typeof doc.routing === 'string' ? doc.routing : 'unrouted',
      ...(doc.ackText !== undefined && { acknowledged: true }),
    }))

  const slots = slotViewsFromStore(store, opts.marks)
  const open = store.workItems
    .list()
    .filter((doc) => !WORK_ITEM_TERMINAL.includes(String(doc.state) as WorkItemState))
    .filter(inScope)
  const work: PlannerWorkItem[] = open.map((doc) => {
    const id = String(doc.id)
    const tasks = store.tasks.list({ workItemId: id }).map((task) => {
      const latest = store.attempts
        .list({ taskId: String(task.id) })
        .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
        .at(-1)
      const modelRequest = task.modelRequest as { tier?: string } | undefined
      return {
        id: String(task.id),
        ...(typeof task.localKey === 'string' && { localKey: task.localKey }),
        ...(typeof task.role === 'string' && { role: task.role }),
        ...(modelRequest?.tier !== undefined && { tier: modelRequest.tier }),
        ...(latest !== undefined && typeof latest.slotId === 'string' && { slotId: latest.slotId }),
        ...(typeof task.status === 'string' && { state: task.status }),
        ...(latest !== undefined && typeof latest.headSha === 'string' && { head: latest.headSha }),
      }
    })
    const hold = doc.hold as { reason?: string; at?: string; liftedAt?: string } | undefined
    return {
      id,
      state: String(doc.state ?? ''),
      stage: String(doc.stage ?? doc.state ?? 'unknown'),
      tasks,
      openQuestions: store.engines
        .list()
        .filter((q) => String(q.id).startsWith('question/') && q.status === 'open' && q.workItemId === id)
        .map((q) => String(q.id)),
      holds: hold !== undefined && hold.liftedAt === undefined ? [`held since ${hold.at ?? '?'}`] : [],
      blockers: typeof doc.blockedReason === 'string' ? [doc.blockedReason] : [],
    }
  })

  const attempts: PlannerAttemptRow[] = store.attempts
    .list()
    .filter((doc) => scope === undefined || scopedWork.has(doc.workItemId))
    .map((doc) => ({
      id: String(doc.id ?? ''),
      ...(typeof doc.taskId === 'string' && { taskId: doc.taskId }),
      ...(typeof doc.workItemId === 'string' && { workItemId: doc.workItemId }),
      ...(typeof doc.slotId === 'string' && { slotId: doc.slotId }),
      ...(typeof doc.state === 'string' && { state: doc.state }),
      ...(typeof doc.terminalReason === 'string' && { terminalReason: doc.terminalReason }),
    }))

  // A card bound to no work item is not repo-scoped, so every repository still sees it.
  const confirmations = store.confirmations
    .list({ status: 'pending' })
    .filter((doc) => scope === undefined || doc.workItemId === undefined || scopedWork.has(doc.workItemId))
    .map((doc) => ({
      id: String(doc.id),
      cls: String(doc.cls ?? ''),
      expiresAt: String(doc.expiresAt ?? ''),
    }))

  const tableSource = opts.modelsTable?.() ?? undefined
  const slotRows: PlannerSlotRow[] = slots.map((slot) => {
    const doc = store.slots.get(slot.slotId) as
      | (StoreDoc & { provider?: unknown; usageUtilization?: unknown; resetAt?: unknown })
      | undefined
    return {
      id: slot.slotId,
      engine: slot.engine,
      ...(typeof doc?.provider === 'string' && { provider: doc.provider }),
      state: String(doc?.state ?? 'unknown'),
      ...(typeof doc?.usageUtilization === 'number' && { utilisation: doc.usageUtilization }),
      ...(typeof doc?.resetAt === 'string' && { resetAt: doc.resetAt }),
      availableTiers: tableSource !== undefined ? availableTiersOnSlot(slot, tableSource.table) : [],
    }
  })

  const budgets: PlannerBudgetRow[] = work.map((item) => {
    const docs = store.tasks.list({ workItemId: item.id })
    const turns = docs
      .map((task) => (task.budget as { turns?: unknown } | undefined)?.turns)
      .filter((value): value is number => typeof value === 'number')
    return {
      workItemId: item.id,
      ...(turns.length > 0 && { turnsRemaining: turns.reduce((sum, value) => sum + value, 0) }),
    }
  })

  const policy = loadPolicy(opts.policyText)
  const frontierAllowed = Object.keys(policy.preAuthorised).includes('frontier_model')
  const digest: PlannerPolicyDigest = {
    caps: opts.caps,
    preAuthorisedClasses: Object.keys(policy.preAuthorised),
    frontierAllowed,
    policyHash: policy.versionHash,
  }

  const models =
    tableSource !== undefined
      ? (() => {
          const { rows, withheldCount } = modelRowsFromTable(tableSource.table, slots)
          return {
            provenance: { sha256: tableSource.provenance.sha256, origin: tableSource.provenance.origin },
            rows,
            withheldCount,
          }
        })()
      : {
          provenance: { sha256: 'unknown', origin: 'default' as const },
          rows: [] as PlannerModelRow[],
          withheldCount: 0,
          note: 'no capability table is wired in this build — tiers cannot be validated; propose tasks without model_request',
        }

  return {
    turn: opts.turn,
    conversation,
    work,
    attempts,
    confirmations,
    slots: slotRows,
    budgets,
    ...(opts.todaySpend !== undefined && { todaySpend: opts.todaySpend }),
    policy: digest,
    models,
    ...(opts.scorecards !== undefined && { scorecards: opts.scorecards }),
    ...(opts.bundleRevision !== undefined && { bundleRevision: opts.bundleRevision }),
  }
}
