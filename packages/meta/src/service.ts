/**
 * The meta-agent runtime (plan §6/§12): one user message in, one acknowledged turn out.
 * A turn routes the message (§12.1), and for new work plans it: creates the work item in
 * `planning`, asks the brain for an acknowledgement and a task plan, validates the plan
 * (§10), and — inside ONE transaction — writes the task docs, plans dispatches (§11),
 * writes the queued attempt docs and enqueues their `launch` effects. The acknowledgement
 * is recorded exactly once per message id, after the writes it receipts have committed.
 *
 * v0 simplifications, all deliberate and to be replaced by later milestones:
 *
 * - **The brain is injectable.** The real one is the Claude adapter (packages/engines)
 *   given the platform tools; everything here is engine-agnostic and only consumes its
 *   decision. `fakeBrain` scripts one decision for tests and composition wiring.
 * - **Checks are the repository's.** A plan names registered checks and an unknown one is
 *   refused by name. `manual-review` only marks a repository with none, and it never passes
 *   by itself (§15).
 * - **No owned paths from the brain.** Tasks carry no `ownedPaths`, so the path-conflict
 *   signal cannot fire; the graph check still catches cycles, missing dependencies,
 *   unknown roles and budgets.
 * - **One fake slot under `MEC_FAKE_ENGINE=1`** stands in for the slot views the health
 *   layer will serve later; without the flag there is no slot at all, so every task
 *   defers `slot_unhealthy` and nothing launches.
 * - **Plans are self-contained.** A dependency must name a task in the same plan; the
 *   graph check rejects anything else as `missing_dependency`.
 * - **The escalation streak is per meta agent** (one counter key), not per v1 planning
 *   attempt: v0 runs one proposal per turn, so "four consecutive invalids" spans four
 *   messages and any valid plan resets it.
 *
 * A rejected turn (invalid plan, or a brain failure) stops work still in `planning` —
 * reason in the event body — so the request never leaves half-live work behind: follow-up
 * messages route as fresh work, and a reference to the stopped item is refused (§12.1:
 * stopped mandates never resume silently). Work already running keeps running.
 *
 * Authority (`authority.ts`): the brain's await is a race window, so a commit re-reads the
 * work first, and only the owner's commands stop, hold or lift it (§12.5, decision #20).
 *
 * Durability (§6, §17, §20): a message keeps one id across retries and the key is stored
 * before the brain runs, so a retry finds the message instead of admitting it twice. A turn
 * that needs no user waiting on it is a `relay` row: wakes key on what caused them, and a
 * message's id derives from that cause, so a row replayed after a crash finds the receipt and
 * runs nothing. During a pause a new message is stored and its turn waits for a `resume` row
 * (decision #27), so nothing spends quota.
 */
import { createHash } from 'node:crypto'
import type { Effects, Json, Store, StoreDoc } from '@mec/contracts'
import { Later } from '@mec/contracts'
import type { BasePolicy, Caps, PlanImpact, PlanTaskLike, WorkItemState } from '@mec/domain'
import {
  ATTEMPT_MACHINE,
  BUILTIN_ROLE_NAMES,
  canTransition,
  computeImpact,
  createMandate,
  DEFAULT_CAPS,
  NO_CHECKS_MARKER,
  TASK_MACHINE,
  transition,
  validateGraph,
  WORK_ITEM_MACHINE,
  WORK_ITEM_TERMINAL,
} from '@mec/domain'
import { loadPolicy } from '../../policy/src/policy'
import { redact } from '../../slots/src/redaction'
import { Acknowledger } from './acks'
import {
  assertRepoAdmission,
  canonicalizePlan,
  isReadOnlyWork,
  planSnapshotId,
  RepoAdmissionError,
  repoFields,
  repoOf,
} from './admission'
import {
  type HoldOutcome,
  holdWorkItem,
  isHeld,
  isTerminal,
  type LiftOutcome,
  liftHoldRecord,
  mandateOf,
  processingOf,
  revalidateWork,
  type StopOutcome,
  stopWorkItem,
} from './authority'
import {
  type ModelsTableSource,
  type PlannerContextInput,
  plannerContextFromStore,
  slotViewsFromStore,
} from './context'
import { EscalationCounter } from './escalation'
import { enqueueWake, FollowUps } from './followups'
import type { Continuation } from './repair'
import { isQuestion, routeMessage } from './routing'
import { type LaunchRecord, type PlacementTable, type SchedulerDeps, schedulePass } from './scheduler'
import type { PlannerConfirmationDraft, PlannerQuestionRecord, PlannerTurnJournal } from './tools'
import { PlannerTools } from './tools'
import { wakeHasNoNews } from './wakes'
import { cutAtWord, TITLE_WORDS } from './words'
import { knownChecks, PLANNER_CANCELLED, workResultOf } from './work-facts'

/** One planned task as the service persists it: the v0 four fields, plus the §5.2 brief fields. */
export type MetaPlanTask = {
  taskId: string
  objective: string
  dependsOn: string[]
  role: string
  /** §10, §14: what this task builds on. Absent is `integration`. */
  basePolicy?: BasePolicy
  /** §6: the original message this task serves (defaults to the originating message id). */
  originalRequestRef?: string
  ownedPaths?: string[]
  acceptanceChecks?: string[]
  /** Decision #33: the planner says the task touches sensitive ground, so it gets one review. */
  sensitive?: boolean
  /** §10: a no-change outcome is acceptable for this task; absent, an unchanged head is no work. */
  noChangeOk?: boolean
  modelRequest?: { tier?: string; model?: string; effort?: string; variant?: string; reason: string }
  slotHint?: { slotClass?: string; slotId?: string }
  budget?: { turns: number; wallClockMs: number; usd?: number }
  subagentPolicy?: { maxTier: string; depth: number }
}

/** What the brain decided for one message: the ack, optionally a task plan, and the §5.2 extras. */
export type MetaDecision = {
  ack: string
  plan?: { tasks: MetaPlanTask[] }
  /** ask_user records the service persists for /api/questions (§5.2). */
  questions?: PlannerQuestionRecord[]
  /** request_confirmation cards the service persists as pending confirmations (§13). */
  confirmations?: PlannerConfirmationDraft[]
  /** route decisions the tools executed (attach/stop/hold; §12.1/§12.5). A lift is the owner's. */
  routes?: PlannerTurnJournal['routes']
  /** ad-hoc spawns bounded by caps (§5.2 spawn_agent). */
  spawns?: PlannerTurnJournal['spawns']
  reports?: PlannerTurnJournal['reports']
  stops?: PlannerTurnJournal['stops']
  cancels?: PlannerTurnJournal['cancels']
  escalated?: boolean
  /** The compiled prompt revision the turn ran under, recorded on the plan snapshot. */
  bundleRevision?: string
  /** The planner ended without finishing the protocol, even after its corrective retry. */
  protocolIncomplete?: boolean
}

/** The wake descriptor: why a turn runs (user message, specialist report, answered question). */
export type MetaWake = { reason: string; detail?: string }

/** How far a running planner turn has got, from the tools it has called. */
export type MetaTurnPhase = 'reading' | 'planning' | 'delegating' | 'asking' | 'answering' | 'opening_card'

/** A planner turn running now. `wake` is why a turn no person started began. */
export type MetaTurn = {
  messageId: string
  workItemId: string
  repoId: string | null
  wake: string | null
  startedAt: string
  phase: MetaTurnPhase
}

/**
 * The planning brain: sees the message and the live work, returns the acknowledgement
 * text and (for new work) the proposed task graph. Production is the engine-backed
 * planner (PlannerBrain over the executed platform tools); tests and composition wire
 * `fakeBrain`. Must be side-effect free — the service owns every write.
 */
export type MetaBrain = (context: {
  messageId?: string
  messageText: string
  liveWork: { workItemId: string; stage: string }[]
  workItemId?: string
  /** §6 wakes: a specialist report or an answered question re-invokes the planner. */
  wake?: MetaWake
  /** The executed tool set for the turn (§5.2) — the engine-backed planner executes it. */
  tools?: PlannerTools
  /** The compiled §5.1 snapshot for the turn. */
  snapshot?: PlannerContextInput
}) => Promise<MetaDecision>

/** What one message's turn did — the receipt the caller shows the user, plus the counts. */
export type TurnOutcome = {
  acknowledged: string
  workItemId?: string
  tasksCreated: number
  launchesEnqueued: string[]
  escalated: boolean
}

/**
 * The message a turn serves; `repoId` is its repository's conversation (absent is Unassigned).
 * `wake` marks a turn no user message started: it speaks with no person's authority.
 */
type TurnInput = {
  messageId: string
  text: string
  repoId?: string
  wake?: true
  idempotencyKey?: string
  /** A wake's cause, so a plan can tell the owner's go-ahead from the planner's own turn. */
  causationId?: string
}

/** §12.1: what the owner submitted, which a key's retry must repeat exactly. */
type SubmissionIntent = 'new' | 'follow_up'

/** A user message's turn: what it names, and whether the owner asked for a New request (§12.1). */
type MessageTurn = TurnInput & {
  referencesWorkItem?: string
  explicitNew?: boolean
  intent?: SubmissionIntent
}

/** A wake's queue key is its cause, and the message it runs as derives from the same cause. */
export type WakeRequest = { causationId: string; reason: string; detail?: string; workItemId?: string }

/**
 * The honest empty table used when no capability-table seam is wired: no tiers, no models,
 * an empty subagent routing block. Tier-carrying proposals fail validation with the
 * repair issue naming the escape (drop model_request) — never a silent pass.
 */
const FALLBACK_EMPTY_TABLE = {
  tiers: [],
  engines: {},
  routing: { subagents: {} },
}

const PAUSED_ACK = 'Recorded. Processing is paused, so planning starts when you resume.'

/** §10 leaves a mandate's scope open: for now, the head of the origin message (#36). */
const MANDATE_SCOPE_CHARS = 200

/** v0 escalation is one streak per meta agent (see the module doc). */
const PLANNING_STREAK_KEY = 'meta-planning'

/** Whether a replan changed what a task runs on: its objective, its dependencies or its base. */
function inputsChanged(
  prior: StoreDoc,
  next: { objective: string; dependsOn: readonly string[]; basePolicy: BasePolicy },
): boolean {
  const ids = (list: readonly unknown[]) => [...list].map(String).sort().join('\n')
  const before = Array.isArray(prior.dependsOn) ? prior.dependsOn : []
  const policy = prior.basePolicy === 'contract' ? 'contract' : 'integration'
  return (
    prior.objective !== next.objective || ids(before) !== ids(next.dependsOn) || policy !== next.basePolicy
  )
}

/**
 * A report from a replan that left a task blocked says so beside the planner's own words, so it
 * can never read as that task starting (owner, 9 November 2026).
 */
function withBlockedNote(
  decision: MetaDecision,
  workItemId: string,
  blocked: readonly string[],
): MetaDecision {
  if (blocked.length === 0 || decision.reports === undefined) return decision
  const note = blocked
    .map((key) => `${key} is still blocked: this plan changed nothing it runs on, so it did not start.`)
    .join(' ')
  return {
    ...decision,
    reports: decision.reports.map((report) =>
      report.workItemId === workItemId ? { ...report, summary: `${report.summary} ${note}` } : report,
    ),
  }
}

/** Long enough that two keys never collide in one store; short enough to read in a log. */
const STABLE_ID_HEX_CHARS = 24

let idCounter = 0

/** A contract-shaped id (`wi_…`): clock + counter + random, url-safe by construction. */
function freshId(prefix: string): string {
  idCounter += 1
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

const digest = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, STABLE_ID_HEX_CHARS)

/** A client's retry keeps the message id: the same key always names the same message. */
export function stableMessageId(idempotencyKey: string): string {
  return `msg_${digest(idempotencyKey)}`
}

/** Every string in a value, keys included, with key shapes gone. */
function redactDeep<T>(value: T): T {
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') return redact(item, [], [])
    if (Array.isArray(item)) return item.map(walk)
    if (typeof item !== 'object' || item === null) return item
    return Object.fromEntries(Object.entries(item).map(([key, entry]) => [redact(key, [], []), walk(entry)]))
  }
  return walk(value) as T
}

/** A brain that always answers with `scripted` — the seam tests and composition wire first. */
export function fakeBrain(scripted: MetaDecision): MetaBrain {
  return async () => scripted
}

export class MetaAgentService {
  readonly #store: Store
  readonly #effects: Effects
  readonly #brain: MetaBrain
  readonly #caps: Caps
  readonly #now: () => string
  readonly #policyText: string
  readonly #marks?: () => Record<string, Record<string, import('@mec/domain').ModelAvailability>>
  readonly #modelsTable?: () => ModelsTableSource | undefined
  readonly #launchableSlots?: () => ReadonlySet<string>
  readonly #metaEngine?: SchedulerDeps['metaEngine']
  readonly #launchRowState?: SchedulerDeps['launchRowState']
  readonly #followups: FollowUps
  readonly #acks = new Acknowledger()
  readonly #escalation = new EscalationCounter()
  /** Turns running in this process: a concurrent retry joins one instead of starting another. */
  readonly #turns = new Map<string, Promise<TurnOutcome>>()
  /** The planner turns running now. In memory on purpose: a crash leaves no turn claiming to run. */
  readonly #thinking = new Map<string, { turn: Omit<MetaTurn, 'phase'>; tools: PlannerTools }>()

  constructor(deps: {
    store: Store
    effects: Effects
    brain: MetaBrain
    caps?: Caps
    now?: () => string
    /** The executable policy text (§13); the empty-authorisation document when absent. */
    policyText?: string
    /** Probe marks per slot, supplied per turn (slots appear after boot); absent → honestly unlisted. */
    marks?: () => Record<string, Record<string, import('@mec/domain').ModelAvailability>>
    /** The capability-table seam (T1's loader); absent means the planner is told so honestly. */
    modelsTable?: () => ModelsTableSource | undefined
    /** The slots a launch can start on; absent means every slot. Plans and dispatch both obey it. */
    launchableSlots?: () => ReadonlySet<string>
    /** The meta slot's engine, which unpinned work prefers; absent, no engine is preferred. */
    metaEngine?: SchedulerDeps['metaEngine']
    /** A launch row's state, so a row that gave up stops holding capacity (§11). */
    launchRowState?: SchedulerDeps['launchRowState']
    /** Follow-ups, with what can deliver them; absent, nothing can. */
    followups?: FollowUps
  }) {
    this.#store = deps.store
    this.#effects = deps.effects
    this.#brain = deps.brain
    this.#caps = deps.caps ?? DEFAULT_CAPS
    this.#now = deps.now ?? (() => new Date().toISOString())
    this.#policyText = deps.policyText ?? '{"preAuthorised":{}}'
    this.#marks = deps.marks
    this.#modelsTable = deps.modelsTable
    this.#launchableSlots = deps.launchableSlots
    this.#metaEngine = deps.metaEngine
    this.#launchRowState = deps.launchRowState
    this.#followups =
      deps.followups ?? new FollowUps({ store: deps.store, effects: deps.effects, now: this.#now })
  }

  /** One scheduler pass (§11), in its own transaction. It runs nothing while paused. */
  runPass(): void {
    this.#store.atomic(() => schedulePass(this.#scheduler(), { at: this.#now() }))
  }

  #scheduler(): SchedulerDeps {
    return {
      store: this.#store,
      effects: this.#effects,
      caps: this.#caps,
      slots: () => this.#placementSlots(),
      ...(this.#metaEngine !== undefined && { metaEngine: this.#metaEngine }),
      table: () => this.#modelsTable?.()?.table as PlacementTable | undefined,
      followups: this.#followups,
      ...(this.#launchRowState !== undefined && { launchRowState: this.#launchRowState }),
    }
  }

  async onUserMessage(input: {
    messageId: string
    text: string
    referencesWorkItem?: string
    /** §12.1, decision #10: the repository's conversation. Absent is Unassigned. */
    repoId?: string
    /** §12.1: the owner asked for a New request, so it starts work beside any live work. */
    explicitNew?: boolean
    /** Stored in the message's first transaction, so a retry finds it before the brain returns. */
    idempotencyKey?: string
    /** Stored with the key: a retry during planning is compared against what was sent. */
    intent?: SubmissionIntent
  }): Promise<TurnOutcome> {
    return this.#messageTurn(input, false)
  }

  /** `resumed` is a relay running the stored turn: only it may start a planner turn in a pause. */
  async #messageTurn(input: MessageTurn, resumed: boolean): Promise<TurnOutcome> {
    assertRepoAdmission(this.#store, input)
    const prior = this.#store.messages.get(input.messageId)
    if (prior !== undefined && repoOf(prior) !== input.repoId) {
      throw new RepoAdmissionError('repo_mismatch', `${input.messageId} belongs to another repository`)
    }
    // A message already carrying a receipt replays verbatim: same ack, same launch keys —
    // the effects queue coalesces the re-enqueue to the existing rows (CONTRACTS §7).
    if (prior !== undefined && typeof prior.ackText === 'string') return this.#replay(prior)
    return this.#once(input.messageId, () => this.#admit(input, prior, resumed))
  }

  /** What the planner is doing now, read off the tools it has really called this turn. */
  turnsInFlight(): MetaTurn[] {
    return [...this.#thinking.values()].map(({ turn, tools }) => ({
      ...turn,
      phase: phaseOf(tools.journal()),
    }))
  }

  /** Holds a brain call in `#thinking` for exactly as long as it runs. */
  async #think<T>(turn: Omit<MetaTurn, 'phase'>, tools: PlannerTools, run: () => Promise<T>): Promise<T> {
    this.#thinking.set(turn.messageId, { turn, tools })
    try {
      return await run()
    } finally {
      this.#thinking.delete(turn.messageId)
    }
  }

  /** One turn per message id in this process; the entry leaves when the turn settles. */
  #once(messageId: string, run: () => Promise<TurnOutcome>): Promise<TurnOutcome> {
    const running = this.#turns.get(messageId)
    if (running !== undefined) return running
    const turn = run().finally(() => this.#turns.delete(messageId))
    this.#turns.set(messageId, turn)
    return turn
  }

  async #admit(input: MessageTurn, prior: StoreDoc | undefined, resumed: boolean): Promise<TurnOutcome> {
    // A receipt-less message with work is an interrupted turn, and that work is its own. Routing
    // would read it as live work and file the message as conversation (§20 App crash).
    if (typeof prior?.workItemId === 'string') {
      const fenced = this.#fencedTurn(input, prior.workItemId)
      if (fenced !== undefined) return fenced
      if (String(this.#store.workItems.get(prior.workItemId)?.state) === 'planning') {
        return this.#startNewWork(input, prior, resumed)
      }
      return this.#noteAttached(input, prior.workItemId)
    }

    const routing = routeMessage({
      referencesWorkItem: input.referencesWorkItem,
      liveWork: this.#routingWork(input.repoId),
      explicitNew: input.explicitNew,
      text: input.text,
    })
    switch (routing.action) {
      case 'attach':
        // §12.1 and §12.3 (decision #52, applied to references 8 November 2026): a question sent to
        // running work gets the planner's answer in chat, and the running work is left as it is.
        // Anything else lands with it, and with nothing running the work's own turn still takes it.
        if (isQuestion(input.text) && this.#followups.ownerOf(routing.workItemId) !== undefined) {
          return await this.#startNewWork(input, prior, resumed, true)
        }
        return this.#noteAttached(input, routing.workItemId)
      case 'stopped_refused':
        return this.#refuseStopped(input)
      case 'conversation':
        return this.#noteConversation(input)
      case 'question':
        return await this.#startNewWork(input, prior, resumed, true)
      case 'new_work':
        return await this.#startNewWork(input, prior, resumed)
    }
  }

  // ── Routing views ────────────────────────────────────────────────────────────────────────

  /**
   * The routing set (§12.1): every work item except `done` ones — done work is history, so
   * a reference to it resolves to nothing and the message falls through to the
   * reference-absent rules. Stopped items stay visible with `stopped: true` so a reference
   * to them is refused instead of silently attaching or resuming. One repository's work
   * never routes another's request, so the set is that repository's alone.
   */
  #routingWork(repoId: string | undefined) {
    return this.#store.workItems
      .list()
      .filter((doc) => repoOf(doc) === repoId)
      .filter((doc) => String(doc.state) !== 'done')
      .map((doc) => ({
        workItemId: String(doc.id),
        tasks: this.#store.tasks.list({ workItemId: doc.id }).map((task) => ({
          taskId: String(task.id),
          status: typeof task.status === 'string' ? task.status : 'ready',
        })),
        openQuestions: this.#store.engines
          .list({ workItemId: doc.id, status: 'open' })
          .filter((row) => String(row.id).startsWith('question/'))
          .map((row) => String(row.id)),
        stopped: String(doc.state) === 'stopped',
      }))
  }

  /** Live work for the brain's context: this repository's items in no terminal state (§10). */
  #liveForBrain(repoId: string | undefined): { workItemId: string; stage: string }[] {
    return this.#store.workItems
      .list()
      .filter((doc) => repoOf(doc) === repoId)
      .filter((doc) => !WORK_ITEM_TERMINAL.includes(String(doc.state) as WorkItemState))
      .map((doc) => ({ workItemId: String(doc.id), stage: String(doc.state) }))
  }

  // ── Turns ────────────────────────────────────────────────────────────────────────────────

  /** One slot list for tier validation and dispatch: a tier passes only where it can land. */
  #placementSlots(): ReturnType<typeof slotViewsFromStore> {
    const views = slotViewsFromStore(this.#store, this.#marks?.())
    const launchable = this.#launchableSlots?.()
    return launchable === undefined ? views : views.filter((view) => launchable.has(view.slotId))
  }

  /** The executed tool set for one turn (§5.2): built from the store, single source. */
  #buildTools(turn: { messageId: string; workItemId?: string }, repoId: string | undefined): PlannerTools {
    const modelsTable = this.#modelsTable?.()
    const table = modelsTable?.table ?? FALLBACK_EMPTY_TABLE
    return new PlannerTools({
      turn,
      snapshot: this.#buildSnapshot({
        messageId: turn.messageId,
        repoId,
        turn: { wake: 'user message' },
        ...(turn.workItemId !== undefined && { workItemId: turn.workItemId }),
      }),
      caps: this.#caps,
      table,
      slots: this.#placementSlots(),
      frontierPreAuthorised:
        (loadPolicy(this.#policyText).preAuthorised as Record<string, unknown>).frontier_model !== undefined,
      now: () => new Date(this.#now()),
      liveWork: this.#routingWork(repoId),
      knownChecks: knownChecks(this.#store, repoId),
    })
  }

  #buildSnapshot(opts: {
    messageId: string
    repoId: string | undefined
    workItemId?: string
    turn: { wake: string; detail?: string }
  }): ReturnType<typeof plannerContextFromStore> {
    return plannerContextFromStore(this.#store, {
      turn: {
        wake: opts.turn.wake,
        ...(opts.turn.detail !== undefined && { detail: opts.turn.detail }),
        messageId: opts.messageId,
      },
      policyText: this.#policyText,
      caps: this.#caps,
      repoScope: {
        ...(opts.repoId !== undefined && { repoId: opts.repoId }),
        ...(opts.workItemId !== undefined && { workItemId: opts.workItemId }),
      },
      ...(this.#marks !== undefined && { marks: this.#marks() }),
      ...(this.#modelsTable !== undefined && { modelsTable: this.#modelsTable }),
    })
  }

  /**
   * §6 WAKES: a specialist report, an answered question, a resolved confirmation — anything
   * that starts a planner turn without a user message. The wake reason travels to the brain
   * and the decision commits exactly like a message turn. A wake belongs to an existing
   * work item and inherits its repo; it never creates work, and read-only work stays as it is.
   */
  async onWake(input: Omit<WakeRequest, 'causationId'> & { causationId?: string }): Promise<TurnOutcome> {
    const messageId =
      input.causationId === undefined ? freshId('msg_wake_') : `msg_wake_${digest(input.causationId)}`
    // Success deletes a relay row, so a repeat is a new row; the receipt is what dedupes it.
    const prior = this.#store.messages.get(messageId)
    if (typeof prior?.ackText === 'string') return this.#replay(prior)
    return this.#once(messageId, () => this.#wakeTurn(input, messageId))
  }

  async #wakeTurn(
    input: { reason: string; detail?: string; workItemId?: string; causationId?: string },
    messageId: string,
  ): Promise<TurnOutcome> {
    const work = input.workItemId === undefined ? undefined : this.#store.workItems.get(input.workItemId)
    if (input.workItemId === undefined || work === undefined) return this.#unboundWake(input)
    const workItemId = input.workItemId
    if (isReadOnlyWork(work, this.#store.tasks.list({ workItemId }))) {
      return {
        acknowledged: `${workItemId} has no repository, so it is read-only.`,
        workItemId,
        tasksCreated: 0,
        launchesEnqueued: [],
        escalated: false,
      }
    }
    if (isTerminal(work) || mandateOf(work).status === 'withdrawn') return this.#refuseWake(input, work)
    const repoId = repoOf(work)
    const repo = repoId !== undefined ? { repoId } : {}
    const turn = {
      messageId,
      wake: true as const,
      ...repo,
      ...(input.causationId !== undefined && { causationId: input.causationId }),
    }
    let decision: MetaDecision
    const tools = this.#buildTools({ messageId, workItemId }, repoId)
    const started = {
      messageId,
      workItemId,
      repoId: repoId ?? null,
      wake: input.reason,
      startedAt: this.#now(),
    }
    try {
      decision = await this.#think(started, tools, () =>
        this.#brain({
          messageId,
          messageText: input.detail ?? input.reason,
          liveWork: this.#liveForBrain(repoId),
          workItemId,
          wake: { reason: input.reason, ...(input.detail !== undefined && { detail: input.detail }) },
          tools,
          snapshot: this.#buildSnapshot({
            messageId,
            repoId,
            workItemId,
            turn: { wake: input.reason, ...(input.detail !== undefined && { detail: input.detail }) },
          }),
        }),
      )
    } catch (error) {
      if (error instanceof Later) throw error
      return this.#failTurn(
        { ...turn, text: input.detail ?? input.reason },
        workItemId,
        error instanceof Error ? error.message : String(error),
      )
    }
    const guarded = this.#store.atomic(() => this.#followups.guardTurn(decision, workItemId, this.#now()))
    const plan = 'plan' in guarded ? guarded.plan : undefined
    if (plan === undefined) {
      return this.#ackOnlyTurn({ ...turn, text: input.reason }, workItemId, guarded)
    }
    return this.#commitPlan({ ...turn, text: input.reason }, workItemId, plan, guarded)
  }

  /** §13 invariant 4: nothing wakes ended work, so no old question or timer spends quota on it. */
  #refuseWake(input: { reason: string }, work: StoreDoc): TurnOutcome {
    const workItemId = String(work.id)
    const at = this.#now()
    this.#store.atomic(() => {
      this.#appendEvent(`work:${workItemId}`, 'wake_refused', { workItemId, reason: input.reason, at }, at)
    })
    return {
      acknowledged: `${workItemId} has ended, so nothing will run.`,
      workItemId,
      tasksCreated: 0,
      launchesEnqueued: [],
      escalated: false,
    }
  }

  /** A wake naming no existing work item is recorded and goes no further. */
  #unboundWake(input: { reason: string; workItemId?: string }): TurnOutcome {
    const at = this.#now()
    this.#store.atomic(() => {
      this.#appendEvent(
        'wakes',
        'wake_unbound',
        { reason: input.reason, ...(input.workItemId !== undefined && { workItemId: input.workItemId }), at },
        at,
      )
    })
    return { acknowledged: 'Noted.', tasksCreated: 0, launchesEnqueued: [], escalated: false }
  }

  /**
   * Queues a wake (§17 `relay`). Call inside the transaction of what caused it, so a crash
   * loses neither or both. The key coalesces a repeat while the row is queued; `onWake` covers
   * a repeat after the row drained.
   */
  enqueueWake(wake: WakeRequest): void {
    enqueueWake(this.#effects, wake)
  }

  /**
   * Queues a relay for each new-work message with no receipt whose work is still planning: at
   * boot for a turn a crash cut short (§20), and on resume for a message a pause held back
   * (decision #27). The brain runs from the queue, never inline.
   */
  enqueueResumes(): void {
    const waiting = this.#store.messages
      .list({ routing: 'new_work' })
      .filter(
        (doc) =>
          typeof doc.ackText !== 'string' &&
          typeof doc.workItemId === 'string' &&
          String(this.#store.workItems.get(doc.workItemId)?.state) === 'planning',
      )
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    this.#store.atomic(() => {
      for (const doc of waiting) {
        this.#effects.enqueue('relay', `resume:${String(doc.id)}`, { messageId: String(doc.id) })
      }
    })
  }

  /** The `relay` handler: a stored message's turn, or a wake. */
  async runRelay(payload: Json): Promise<void> {
    const fields = (payload ?? {}) as Record<string, unknown>
    if (typeof fields.messageId === 'string') {
      const doc = this.#store.messages.get(fields.messageId)
      if (doc === undefined || typeof doc.ackText === 'string') return
      const repoId = repoOf(doc)
      await this.#messageTurn(
        { messageId: String(doc.id), text: String(doc.text), ...(repoId !== undefined && { repoId }) },
        true,
      )
      return
    }
    await this.onWake({
      reason: String(fields.reason),
      ...(typeof fields.causationId === 'string' && { causationId: fields.causationId }),
      ...(typeof fields.detail === 'string' && { detail: fields.detail }),
      ...(typeof fields.workItemId === 'string' && { workItemId: fields.workItemId }),
    })
    // The turn that routed a handed-back message is the rerouting §12.4 settles on.
    if (typeof fields.settles === 'string') this.#followups.settle(fields.settles)
  }

  /**
   * §5.2/§12.6: the answer and its wake commit together, first answer wins, and the planner
   * runs from the queue, so the caller never waits on a turn. The answer is redacted before
   * any write, the wake's detail included (AGENTS non-negotiable 5). A specialist's question
   * has its answer delivered to the attempt that asked, and the planner gets a note (§12.6).
   */
  onQuestionAnswered(
    questionId: string,
    answer: string,
  ): { status: 'answered'; answer: string } | { status: 'not_open' | 'missing' } {
    const docId = questionId.startsWith('question/') ? questionId : `question/${questionId}`
    const at = this.#now()
    return this.#store.atomic(() => {
      const doc = this.#store.engines.get(docId)
      if (doc === undefined) return { status: 'missing' as const }
      if (String(doc.status ?? 'open') !== 'open') return { status: 'not_open' as const }
      const stored = redact(answer, [], [])
      this.#store.engines.save({
        ...doc,
        status: 'answered',
        answer: stored,
        answeredAt: at,
        updatedAt: at,
      })
      this.#appendEvent(
        docId,
        'question_answered',
        { questionId: typeof doc.questionId === 'string' ? doc.questionId : questionId, answer: stored, at },
        at,
      )
      if (typeof doc.attemptId === 'string') {
        this.#followups.answerSpecialist(doc, stored, at)
        return { status: 'answered' as const, answer: stored }
      }
      const reason = 'question answered'
      const workItemId = typeof doc.workItemId === 'string' ? doc.workItemId : undefined
      const work = workItemId === undefined ? undefined : this.#store.workItems.get(workItemId)
      // A replan may have moved on since it was asked: the planner sees under which plan it was.
      const asked = typeof doc.planRevision === 'number' ? ` (plan revision ${doc.planRevision})` : ''
      if (work !== undefined && (isTerminal(work) || mandateOf(work).status === 'withdrawn')) {
        this.#refuseWake({ reason }, work)
      } else {
        this.enqueueWake({
          causationId: docId,
          reason,
          detail: `question "${String(doc.question ?? '')}"${asked} answered: ${stored}`,
          ...(workItemId !== undefined && { workItemId }),
        })
      }
      return { status: 'answered' as const, answer: stored }
    })
  }

  // ── Owner commands (§12.5, decision #20) ─────────────────────────────────────────────────

  /** Holds work; `sourceMessageId` names the message that caused it, when one did (§10). */
  holdWork(workItemId: string, reason: string, sourceMessageId?: string): HoldOutcome {
    const at = this.#now()
    return this.#store.atomic(() =>
      holdWorkItem(this.#store, workItemId, {
        reason,
        ...(sourceMessageId !== undefined && { sourceMessageId }),
        at,
      }),
    )
  }

  stopWork(workItemId: string): StopOutcome {
    const at = this.#now()
    return this.#store.atomic(() =>
      stopWorkItem(this.#store, workItemId, { reason: 'stopped by the owner', at }),
    )
  }

  /**
   * The only release of a hold (#20): the mandate revalidates first (§10 "before every resume"),
   * then the hold lifts and a pass places what is ready, in one transaction. A launch already
   * queued starts on its row's next pass.
   */
  liftHold(workItemId: string): LiftOutcome {
    const at = this.#now()
    return this.#store.atomic((): LiftOutcome => {
      const work = this.#store.workItems.get(workItemId)
      if (work === undefined) return { status: 'missing' }
      if (!isHeld(work)) return { status: 'free' }
      const tasks = this.#store.tasks.list({ workItemId })
      if (isReadOnlyWork(work, tasks)) return { status: 'refused', error: 'read_only' }
      const authority = revalidateWork(work, at, loadPolicy(this.#policyText).versionHash)
      if (!authority.ok) return { status: 'refused', error: `mandate_${authority.reason}` }
      liftHoldRecord(this.#store, work, at)
      const records = schedulePass(this.#scheduler(), { at, workItemId })
      return { status: 'lifted', launches: records.map((record) => record.attemptId) }
    })
  }

  /**
   * §12.3: a message on existing work reaches the attempt that owns it, unchanged and by way of
   * the queue, and the meta agent stays out of it. With nothing running, it gets a turn instead.
   */
  #noteAttached(input: TurnInput, workItemId: string): TurnOutcome {
    const at = this.#now()
    const running = this.#followups.ownerOf(workItemId) !== undefined
    // A short title: the whole request is already on the page, and an id is not for a person.
    const origin = this.#store.messages.get(String(this.#store.workItems.get(workItemId)?.originMessageId))
    const first = typeof origin?.text === 'string' ? (origin.text.trim().split('\n', 1)[0] ?? '') : ''
    const named = first === '' ? workItemId : `“${cutAtWord(redact(first, [], []), TITLE_WORDS)}”`
    const ack = running
      ? `Noted on ${named}: it lands with the running work.`
      : `Noted on ${named}: nothing is running on it, so I'll pick this up.`
    this.#store.atomic(() => {
      this.#appendEvent(
        `work:${workItemId}`,
        'message_attached',
        { workItemId, messageId: input.messageId, at },
        at,
      )
      this.#saveMessage(input, { routing: 'attach', at, workItemId, ackText: ack })
      this.#followups.attach(input.messageId, workItemId, at)
    })
    this.#acks.acknowledge(input.messageId, ack)
    return { acknowledged: ack, workItemId, tasksCreated: 0, launchesEnqueued: [], escalated: false }
  }

  /** §12.1: a stopped work item never resumes silently — the reference is refused, not attached. */
  #refuseStopped(input: TurnInput): TurnOutcome {
    const at = this.#now()
    const ack = 'That work is stopped — it will not resume silently; send it again as a new request.'
    this.#store.atomic(() => {
      this.#saveMessage(input, { routing: 'stopped_refused', at, ackText: ack })
    })
    this.#acks.acknowledge(input.messageId, ack)
    return { acknowledged: ack, tasksCreated: 0, launchesEnqueued: [], escalated: false }
  }

  /** §12.1 conversation: with live work present, a reference-less message is context only. */
  #noteConversation(input: TurnInput): TurnOutcome {
    const at = this.#now()
    const liveIds = this.#liveForBrain(input.repoId).map((work) => work.workItemId)
    const ack =
      liveIds.length > 0 ? `Noted as context on the running work (${liveIds.join(', ')}).` : 'Noted.'
    this.#store.atomic(() => {
      this.#saveMessage(input, { routing: 'conversation', at, ackText: ack })
    })
    this.#acks.acknowledge(input.messageId, ack)
    return { acknowledged: ack, tasksCreated: 0, launchesEnqueued: [], escalated: false }
  }

  /**
   * New work (§12.1): the work item is created in `planning` and its message recorded in
   * one transaction; then the brain runs outside any transaction (it is slow I/O and
   * `atomic` is synchronous); then the turn commits — plan or no plan — in a second
   * transaction. A crash between the two leaves a receipt-less message doc, and a replay
   * resumes planning on the same work item instead of minting a second one.
   */
  async #startNewWork(
    input: MessageTurn,
    prior: StoreDoc | undefined,
    resumed: boolean,
    questionOnly = false,
  ): Promise<TurnOutcome> {
    const known = typeof prior?.workItemId === 'string' ? prior.workItemId : undefined
    const workItemId = known ?? freshId('wi_')
    if (known === undefined) {
      const at = this.#now()
      this.#store.atomic(() => {
        this.#store.workItems.save({
          id: workItemId,
          state: 'planning',
          // On the doc, so a turn a crash cut short resumes as what it was.
          ...(questionOnly && { questionOnly: true }),
          originMessageId: input.messageId,
          mandate: createMandate({
            id: `mandate_${workItemId}`,
            originMessageId: input.messageId,
            scope: input.text.slice(0, MANDATE_SCOPE_CHARS),
            policyHash: loadPolicy(this.#policyText).versionHash,
            budgetTurns: 0,
            expiresAt: null,
          }) as unknown as Json,
          ...repoFields(this.#store, input.repoId, this.#policyText),
          createdAt: at,
          updatedAt: at,
        })
        this.#appendEvent(
          `work:${workItemId}`,
          'planning_started',
          { workItemId, messageId: input.messageId, at },
          at,
        )
        this.#saveMessage(input, { routing: 'new_work', at, workItemId })
      })
    }

    // Decision #27: stored, and no receipt, so resuming finds it and runs its turn then.
    if (!resumed && processingOf(this.#store).paused) {
      // Not `ackText`: that is the receipt, and having one would stop the resume finding this.
      this.#store.atomic(() => {
        const doc = this.#store.messages.get(input.messageId)
        if (doc !== undefined) this.#store.messages.save({ ...doc, pausedAck: PAUSED_ACK })
      })
      return {
        acknowledged: PAUSED_ACK,
        workItemId,
        tasksCreated: 0,
        launchesEnqueued: [],
        escalated: false,
      }
    }

    const answerOnly = this.#store.workItems.get(workItemId)?.questionOnly === true
    const reason = answerOnly ? QUESTION_WAKE : 'user message'
    // A question sent by reference says which work it asks about, on resume as well.
    const about = answerOnly
      ? (input.referencesWorkItem ??
        (typeof prior?.referencesWorkItem === 'string' ? prior.referencesWorkItem : undefined))
      : undefined
    const detail = (about === undefined ? input.text : `about ${about}: ${input.text}`).slice(0, 200)
    let decision: MetaDecision
    const tools = this.#buildTools({ messageId: input.messageId, workItemId }, input.repoId)
    const started = {
      messageId: input.messageId,
      workItemId,
      repoId: input.repoId ?? null,
      wake: null,
      startedAt: this.#now(),
    }
    try {
      decision = await this.#think(started, tools, () =>
        this.#brain({
          messageId: input.messageId,
          messageText: input.text,
          liveWork: this.#liveForBrain(input.repoId),
          workItemId,
          wake: { reason, detail },
          tools,
          snapshot: this.#buildSnapshot({
            messageId: input.messageId,
            repoId: input.repoId,
            workItemId,
            turn: { wake: reason, detail },
          }),
        }),
      )
    } catch (error) {
      // A shutdown cut the turn short (§20): no receipt, so the next start resumes it.
      if (error instanceof Later) throw error
      // The brain failing must never throw outward (§6): the user gets the failure ack,
      // the work item is stopped with the error on its stream, and the turn ends.
      return this.#failTurn(input, workItemId, error instanceof Error ? error.message : String(error))
    }

    if (answerOnly) return this.#ackOnlyTurn(input, workItemId, answerOf(decision, workItemId))
    const plan = 'plan' in decision ? decision.plan : undefined
    if (plan === undefined) return this.#ackOnlyTurn(input, workItemId, decision)
    return this.#commitPlan(input, workItemId, plan, decision)
  }

  /**
   * A turn with no plan. Its questions/confirmations/routes persist — the turn's whole write
   * set, not just the words. What it asked waits on the person, so its acknowledgement stands;
   * otherwise its report is what is spoken (§6), wherever the planner aimed it, and that is the
   * chat's line for the message that asked (§12.2). A report with nothing asked ends the work,
   * or it would read as Working and turn every later message into conversation (§12.1). A turn
   * that stopped at its acknowledgement finished nothing, so its work stays open. A wake's text
   * is its reason, and a wake with nothing new stays off the chat (§12.7).
   */
  #ackOnlyTurn(input: TurnInput, workItemId: string, decision: MetaDecision): TurnOutcome {
    const fenced = this.#fencedTurn(input, workItemId)
    if (fenced !== undefined) return fenced
    const at = this.#now()
    const reply = this.#store.atomic(() => {
      const scoped = this.#withoutRepeats(
        workItemId,
        this.#withinRepo(input.messageId, workItemId, decision, at),
        at,
      )
      this.#persistExtras(workItemId, scoped, at, input.wake === true)
      const asked = (scoped.questions?.length ?? 0) + (scoped.confirmations?.length ?? 0) > 0
      const spoken = asked ? undefined : scoped.reports?.at(-1)?.summary
      const text = spoken === undefined ? decision.ack : redact(spoken, [], [])
      const quiet = input.wake === true && !asked && this.#hasNoNews(workItemId, input.text)
      if (input.wake === true && !quiet) this.#recordTold(workItemId)
      if (spoken !== undefined) this.#endIfAnswered(workItemId, input.messageId, at)
      if (spoken === undefined && decision.protocolIncomplete === true && !asked) {
        // Nothing more runs on this turn, and Work says No answer from it. The record says why.
        const facts = { workItemId, messageId: input.messageId, at }
        this.#appendEvent(`work:${workItemId}`, 'turn_incomplete', facts, at)
      }
      this.#saveMessage(input, {
        routing: 'new_work',
        at,
        workItemId,
        ackText: text,
        tasksCreated: 0,
        launches: [],
        escalated: decision.escalated === true,
        quiet,
      })
      return text
    })
    this.#acks.acknowledge(input.messageId, reply)
    return {
      acknowledged: reply,
      workItemId,
      tasksCreated: 0,
      launchesEnqueued: [],
      escalated: decision.escalated === true,
    }
  }

  #hasNoNews(workItemId: string, reason: string): boolean {
    const work = this.#store.workItems.get(workItemId)
    return work !== undefined && wakeHasNoNews(reason, work)
  }

  /** The block the chat has now spoken about: the same one is no news next time (§12.7). */
  #recordTold(workItemId: string): void {
    const work = this.#store.workItems.get(workItemId)
    if (work === undefined || String(work.state) !== 'blocked') return
    this.#store.workItems.save({ ...work, toldBlock: work.blockedReason ?? null })
  }

  /** §12.2: a turn that planned nothing and waits on nobody is finished. A hold is the owner's. */
  #endIfAnswered(workItemId: string, messageId: string, at: string): void {
    const work = this.#store.workItems.get(workItemId)
    if (work === undefined || isHeld(work)) return
    if (!canTransition(WORK_ITEM_MACHINE, String(work.state), 'answered')) return
    if (this.#store.tasks.list({ workItemId }).length > 0) return
    const open = this.#store.engines.list({ workItemId, status: 'open' })
    if (open.some((doc) => String(doc.id).startsWith('question/'))) return
    if (this.#store.confirmations.list({ workItemId, status: 'pending' }).length > 0) return
    const state = transition(WORK_ITEM_MACHINE, String(work.state), 'answered')
    this.#store.workItems.save({ ...work, state, updatedAt: at })
    this.#appendEvent(`work:${workItemId}`, 'work_answered', { workItemId, messageId, at }, at)
  }

  /**
   * The commit fence (§10, §13 invariant 4): the brain's await is the race window, so every
   * commit re-reads the work first. Work that ended meanwhile keeps nothing from the turn, not
   * even an extra: only a message saying so.
   */
  #fencedTurn(input: TurnInput, workItemId: string): TurnOutcome | undefined {
    const work = this.#store.workItems.get(workItemId)
    if (work !== undefined && !isTerminal(work) && mandateOf(work).status !== 'withdrawn') return undefined
    const at = this.#now()
    const ended = String(work?.state) === 'done' ? 'finished' : 'stopped'
    const ack = `That work was ${ended}, so nothing from this turn will run.`
    this.#store.atomic(() => {
      this.#saveMessage(input, {
        routing: 'new_work',
        at,
        workItemId,
        ackText: ack,
        tasksCreated: 0,
        launches: [],
        escalated: false,
      })
    })
    this.#acks.acknowledge(input.messageId, ack)
    return { acknowledged: ack, workItemId, tasksCreated: 0, launchesEnqueued: [], escalated: false }
  }

  /** A failed turn ends only work still being planned; running work keeps running. */
  #stopIfPlanning(workItemId: string, messageId: string, at: string, reason: string): void {
    if (String(this.#store.workItems.get(workItemId)?.state) !== 'planning') return
    stopWorkItem(this.#store, workItemId, { reason, messageId, at })
  }

  /** A brain failure ends the turn safely: failure ack, stopped planning work, error event. */
  #failTurn(input: TurnInput, workItemId: string, detail: string): TurnOutcome {
    const at = this.#now()
    const ack = 'I could not start that'
    this.#store.atomic(() => {
      this.#appendEvent(
        `work:${workItemId}`,
        'meta_agent_error',
        { workItemId, messageId: input.messageId, error: detail, at },
        at,
      )
      this.#stopIfPlanning(workItemId, input.messageId, at, 'meta_agent_error')
      this.#saveMessage(input, {
        routing: 'new_work',
        at,
        workItemId,
        ackText: ack,
        tasksCreated: 0,
        launches: [],
        escalated: false,
      })
    })
    this.#acks.acknowledge(input.messageId, ack)
    return { acknowledged: ack, workItemId, tasksCreated: 0, launchesEnqueued: [], escalated: false }
  }

  /**
   * Whether this turn is the owner's go-ahead on blocked work: a person's own turn, or a wake the
   * owner caused (their follow-up, released or handed back, or their answer to a question), made
   * after the work blocked. A wake from a report, a parked task or a timer is the planner's own.
   */
  #ownerWentAhead(input: TurnInput, workItemId: string): boolean {
    const blockedAt =
      this.#store.events
        .read(`work:${workItemId}`)
        .filter((event) => event.type === 'work_blocked')
        .at(-1)?.at ?? ''
    if (input.wake !== true) return true
    const cause = input.causationId ?? ''
    const said = /^(message|released|handback):(.+)$/.exec(cause)
    const when = said
      ? this.#store.messages.get(said[2] as string)?.createdAt
      : cause.startsWith('question/')
        ? this.#store.engines.get(cause)?.answeredAt
        : undefined
    return typeof when === 'string' && when >= blockedAt
  }

  /** Validate the brain's plan (§10); an invalid one is answered with the first issue. */
  #commitPlan(
    input: TurnInput,
    workItemId: string,
    plan: { tasks: MetaPlanTask[] },
    unscoped: MetaDecision,
  ): TurnOutcome {
    const fenced = this.#fencedTurn(input, workItemId)
    if (fenced !== undefined) return fenced
    const tasks = plan.tasks
    // §15: the repository's registered checks; the marker stands in only where it has none.
    const known = knownChecks(this.#store, repoOf(this.#store.workItems.get(workItemId)) ?? input.repoId)
    const issues = validateGraph(
      tasks.map((task) => ({
        id: task.taskId,
        dependsOn: [...task.dependsOn],
        ownedPaths: task.ownedPaths ?? [],
        acceptanceChecks:
          task.acceptanceChecks !== undefined && task.acceptanceChecks.length > 0
            ? [...task.acceptanceChecks]
            : known,
        maxAttempts: this.#caps.repairAttemptsPerTask + 1,
        basePolicy: task.basePolicy ?? 'integration',
        role: task.role,
      })),
      { knownChecks: known, knownRoles: BUILTIN_ROLE_NAMES },
    )
    if (issues.length > 0) {
      const first = issues[0]!
      const escalated = this.#escalation.addInvalid(PLANNING_STREAK_KEY) === 'escalate'
      const at = this.#now()
      const text = `I could not start that: ${first.detail}${
        escalated ? ' Four plans in a row were invalid, so this one goes to you.' : ''
      }`
      this.#store.atomic(() => {
        this.#appendEvent(
          `work:${workItemId}`,
          'plan_rejected',
          { workItemId, messageId: input.messageId, issue: first, at },
          at,
        )
        this.#stopIfPlanning(workItemId, input.messageId, at, 'plan_rejected')
        this.#saveMessage(input, {
          routing: 'new_work',
          at,
          workItemId,
          ackText: text,
          tasksCreated: 0,
          launches: [],
          escalated,
        })
      })
      this.#acks.acknowledge(input.messageId, text)
      return { acknowledged: text, workItemId, tasksCreated: 0, launchesEnqueued: [], escalated }
    }
    this.#escalation.reset(PLANNING_STREAK_KEY)

    // One transaction for the whole acceptance: work item executing, task docs, attempt
    // docs and their launch effects — a partial plan can never be visible (CONTRACTS §7:
    // effects.enqueue only runs inside atomic, and this is that atomic).
    const at = this.#now()
    const { launches, ack } = this.#store.atomic(() => {
      const decision = this.#withoutRepeats(
        workItemId,
        this.#withinRepo(input.messageId, workItemId, unscoped, at),
        at,
      )
      const work = this.#store.workItems.get(workItemId)
      const repoId = repoOf(work)
      const planRevision = (typeof work?.planRevision === 'number' ? work.planRevision : 0) + 1
      const stored = this.#store.tasks.list({ workItemId })
      const canonical = canonicalizePlan(tasks, stored, () => freshId('task_'))
      const ownerAhead = this.#ownerWentAhead(input, workItemId)
      if (work !== undefined) {
        // A replan (#19) finds the work past planning, where it stays.
        if (canTransition(WORK_ITEM_MACHINE, String(work.state), 'execution_started')) {
          work.state = transition(WORK_ITEM_MACHINE, String(work.state), 'execution_started')
          this.#appendEvent(
            `work:${workItemId}`,
            'execution_started',
            { workItemId, messageId: input.messageId, at },
            at,
          )
        }
        work.planRevision = planRevision
        work.updatedAt = at
        if (work.state === 'blocked' && ownerAhead) {
          // Owner ruling 2026-11-07: the owner's go-ahead, and the plan it led to, lift the block
          // for that plan's new work. Tasks still blocked stay blocked, and re-block the work if
          // nothing else is open. A planner turn the owner did not cause never gets here.
          work.state = transition(WORK_ITEM_MACHINE, 'blocked', 'resume_executing')
          delete work.blockedReason
          this.#appendEvent(
            `work:${workItemId}`,
            'block_lifted',
            { workItemId, messageId: input.messageId, by: 'owner', at },
            at,
          )
        }
        this.#store.workItems.save(work)
      }

      // Decision #19: a key this work item already holds is the same task, so its id, status
      // and creation stay and only what the plan says about it changes.
      const stillBlocked: string[] = []
      for (const { prior, ...task } of canonical) {
        // A no-change allowance is what this revision says, never one an earlier revision gave.
        const { noChangeOk: _earlier, ...kept } = prior ?? {}
        const basePolicy = task.basePolicy ?? (prior?.basePolicy as BasePolicy | undefined) ?? 'integration'
        // Owner, 9 November 2026: a blocked task whose objective, dependencies or base the owner's
        // replan changed starts again, fresh, on the base the plan now gives it (a repair would
        // reuse the old worktree, §15). One the plan did not change stays blocked, and says so.
        const restart =
          prior?.status === 'blocked' && ownerAhead && inputsChanged(prior, { ...task, basePolicy })
        if (prior?.status === 'blocked' && !restart) stillBlocked.push(task.localKey)
        const { blockedReason: _blocked, deferred: _deferred, next: _next, ...free } = kept
        const next: Continuation = {
          kind: 'restart',
          role: task.role,
          evidence: String(prior?.blockedReason ?? 'the task was blocked'),
          round: 0,
        }
        if (restart) {
          this.#appendEvent(
            `work:${workItemId}`,
            'task_restarted',
            { taskId: task.taskId, planRevision, at },
            at,
          )
        }
        this.#store.tasks.save({
          ...(restart ? { ...free, next: next as unknown as Json } : kept),
          id: task.taskId,
          workItemId,
          ...(repoId !== undefined && { repoId }),
          localKey: task.localKey,
          planRevision,
          objective: task.objective,
          dependsOn: task.dependsOn,
          role: task.role,
          basePolicy,
          status: restart ? 'ready' : (prior?.status ?? 'ready'),
          acceptanceChecks:
            task.acceptanceChecks !== undefined && task.acceptanceChecks.length > 0
              ? [...task.acceptanceChecks]
              : known,
          ...((task.sensitive ?? prior?.sensitive) === true && { sensitive: true }),
          ...(task.noChangeOk === true && { noChangeOk: true }),
          // §5.2's brief fields persist verbatim; the runtime's resolveModel reads them.
          originalRequestRef: task.originalRequestRef ?? input.messageId,
          ...(task.ownedPaths !== undefined && { ownedPaths: [...task.ownedPaths] }),
          ...(task.modelRequest !== undefined && { modelRequest: { ...task.modelRequest } }),
          ...(task.slotHint !== undefined && { slotHint: { ...task.slotHint } }),
          ...(task.budget !== undefined && { budget: { ...task.budget } }),
          ...(task.subagentPolicy !== undefined && { subagentPolicy: { ...task.subagentPolicy } }),
          createdAt: prior?.createdAt ?? at,
          updatedAt: at,
        })
      }
      const kept = this.#dropMissingKeys(stored, canonical, planRevision, at)
      const snapshotTasks = canonical.map((task) => ({
        taskId: task.taskId,
        localKey: task.localKey,
        objective: task.objective,
        dependsOn: task.dependsOn,
        role: task.role,
        basePolicy: task.basePolicy ?? 'integration',
        ownedPaths: task.ownedPaths ?? [],
        acceptanceChecks: task.acceptanceChecks ?? [],
      }))
      const impact = this.#impactOf(workItemId, planRevision, snapshotTasks)
      this.#store.engines.save({
        id: planSnapshotId(workItemId, planRevision),
        workItemId,
        ...(repoId !== undefined && { repoId }),
        revision: planRevision,
        messageId: input.messageId,
        ...(decision.bundleRevision !== undefined && { promptRevision: decision.bundleRevision }),
        tasks: snapshotTasks,
        impact: { ...impact, keptRunning: kept },
        createdAt: at,
        updatedAt: at,
      })

      // §5.2 spawn_agent: ad-hoc specialists outside the plan get task docs and dispatch
      // through the same §11 pass — the executor already bounded them by caps.
      for (const spawn of decision.spawns ?? []) {
        this.#store.tasks.save({
          id: spawn.taskId,
          workItemId: spawn.workItemId,
          ...(repoId !== undefined && { repoId }),
          planRevision,
          objective: spawn.objective,
          dependsOn: [],
          role: spawn.role,
          basePolicy: 'integration',
          status: 'ready',
          // Names no check, so it is held to what the repository registers (`requiredChecks`).
          acceptanceChecks: [NO_CHECKS_MARKER],
          originalRequestRef: input.messageId,
          ...(spawn.modelRequest !== undefined && { modelRequest: { ...spawn.modelRequest } }),
          ...(spawn.slotHint !== undefined && { slotHint: { ...spawn.slotHint } }),
          createdAt: at,
          updatedAt: at,
        })
        this.#appendEvent(
          `work:${spawn.workItemId}`,
          'agent_spawned',
          { taskId: spawn.taskId, role: spawn.role, workItemId: spawn.workItemId, at },
          at,
        )
      }

      // The turn's other executed effects (§5.2): questions, cards, routes, reports,
      // stops, cancels — one transaction with the plan.
      this.#persistExtras(
        workItemId,
        withBlockedNote(decision, workItemId, stillBlocked),
        at,
        input.wake === true,
      )

      // §11: the same pass the timer runs. It re-reads the work, because this turn's own routes
      // may have held or stopped it, and task state, so a kept task runs once.
      const records = schedulePass(this.#scheduler(), { at, workItemId })
      const held = this.#store.workItems.get(workItemId)
      const ack =
        held !== undefined && isHeld(held)
          ? `${unscoped.ack} This work is held, so nothing starts until you lift it.`
          : unscoped.ack

      this.#saveMessage(input, {
        routing: 'new_work',
        at,
        workItemId,
        ackText: ack,
        tasksCreated: tasks.length,
        launches: records,
        escalated: decision.escalated === true,
      })
      return { launches: records, ack }
    })

    this.#acks.acknowledge(input.messageId, ack)
    return {
      acknowledged: ack,
      workItemId,
      tasksCreated: tasks.length,
      launchesEnqueued: launches.map((record) => record.attemptId),
      escalated: unscoped.escalated === true,
    }
  }

  /**
   * Decision #36 (§10): a key a replan drops is cancelled, with the revision as its reason, when
   * nothing started it. A started task stays, and the impact summary flags it for the meta agent
   * to stop explicitly. A spawn has no key, so a plan never drops one.
   */
  #dropMissingKeys(
    stored: readonly StoreDoc[],
    canonical: readonly { taskId: string }[],
    planRevision: number,
    at: string,
  ): string[] {
    const planned = new Set(canonical.map((task) => task.taskId))
    const kept: string[] = []
    for (const task of stored) {
      if (typeof task.localKey !== 'string' || planned.has(String(task.id))) continue
      const status = String(task.status)
      if (['cancelled', 'integrated'].includes(status)) continue
      const started = this.#store.attempts.list({ taskId: task.id }).length > 0
      if (started || !canTransition(TASK_MACHINE, status, 'cancel')) {
        kept.push(String(task.id))
        continue
      }
      this.#store.tasks.save({
        ...task,
        status: transition(TASK_MACHINE, status, 'cancel'),
        cancelledReason: `dropped by plan revision ${planRevision}`,
        updatedAt: at,
      })
      this.#appendEvent(`task:${String(task.id)}`, 'task_cancelled', { taskId: String(task.id), at }, at)
    }
    return kept
  }

  /** §10: what this revision changes against the one before it. The first adds everything. */
  #impactOf(
    workItemId: string,
    planRevision: number,
    tasks: readonly {
      taskId: string
      objective: string
      dependsOn: string[]
      basePolicy: string
      ownedPaths: readonly string[]
      acceptanceChecks: readonly string[]
    }[],
  ): PlanImpact {
    const node = (task: (typeof tasks)[number]): PlanTaskLike => ({
      id: task.taskId,
      dependsOn: task.dependsOn,
      ownedPaths: [...task.ownedPaths],
      acceptanceChecks: [...task.acceptanceChecks],
      maxAttempts: this.#caps.repairAttemptsPerTask + 1,
      basePolicy: task.basePolicy as BasePolicy,
      objective: task.objective,
    })
    const previous = this.#store.engines.get(planSnapshotId(workItemId, planRevision - 1))?.tasks
    // A revision stored before this one recorded no paths or checks.
    const before = (Array.isArray(previous) ? previous : []) as unknown as (typeof tasks)[number][]
    const whole = (task: (typeof tasks)[number]) =>
      node({ ...task, ownedPaths: task.ownedPaths ?? [], acceptanceChecks: task.acceptanceChecks ?? [] })
    return computeImpact(before.map(whole), tasks.map(node))
  }

  /**
   * The service's own repo fence over the tools' scoped snapshot: an effect aimed outside the
   * turn's repository is dropped and recorded, inside the caller's transaction. An Unassigned
   * turn reaches only its own work item, so a legacy row is never written.
   */
  #withinRepo(messageId: string, workItemId: string, decision: MetaDecision, at: string): MetaDecision {
    const repoId = repoOf(this.#store.workItems.get(workItemId))
    const allowed = (target: unknown): boolean => {
      if (target === workItemId) return true
      if (repoId === undefined || typeof target !== 'string') return false
      return repoOf(this.#store.workItems.get(target)) === repoId
    }
    const routes = decision.routes?.filter((route) => route.target === undefined || allowed(route.target))
    const spawns = decision.spawns?.filter((spawn) => allowed(spawn.workItemId))
    const reports = decision.reports?.filter((report) => allowed(report.workItemId))
    const stops = decision.stops?.filter((stop) =>
      allowed(this.#store.attempts.get(stop.attemptId)?.workItemId),
    )
    const cancels = decision.cancels?.filter((cancel) =>
      allowed(this.#store.tasks.get(cancel.taskId)?.workItemId),
    )
    const sizes = (d: MetaDecision): number =>
      [d.routes, d.spawns, d.reports, d.stops, d.cancels].reduce((sum, rows) => sum + (rows?.length ?? 0), 0)
    const scoped = { ...decision, routes, spawns, reports, stops, cancels }
    const dropped = sizes(decision) - sizes(scoped)
    if (dropped > 0) {
      this.#appendEvent(
        `work:${workItemId}`,
        'cross_repo_refused',
        { workItemId, messageId, dropped, at },
        at,
      )
    }
    return scoped
  }

  /** What counts as work moving: a new plan or a new attempt. A person's answer alone is neither. */
  #progressMark(workItemId: string): string {
    const revision = this.#store.workItems.get(workItemId)?.planRevision
    const attempts = this.#store.attempts.list({ workItemId }).length
    return `${typeof revision === 'number' ? revision : 0}:${attempts}`
  }

  /**
   * §12.6: the same decision is never requested twice. The same words are the same decision, and
   * on stuck work so is any question asked since it last moved, however it is worded: nothing
   * about the block has changed, so neither has what a person is being asked. Planning's
   * clarifying questions are told apart by their words, so a second real one still gets through.
   */
  #withoutRepeats(workItemId: string, decision: MetaDecision, at: string): MetaDecision {
    const { questions } = decision
    if (questions === undefined || questions.length === 0) return decision
    const stuck =
      String(this.#store.workItems.get(workItemId)?.state) === 'blocked' ||
      this.#store.tasks.list({ workItemId }).some((task) => task.status === 'blocked')
    const mark = this.#progressMark(workItemId)
    const asked = this.#store.engines
      .list({ workItemId })
      .filter((doc) => String(doc.id).startsWith('question/'))
      .filter((doc) => doc.status === 'open' || doc.status === 'answered')
    const fresh = questions.filter((question) => {
      const words = sameWords(redact(question.question, [], []))
      const prior = asked.find(
        (doc) => sameWords(String(doc.question)) === words || (stuck && doc.progressMark === mark),
      )
      if (prior === undefined) return true
      this.#appendEvent(
        `work:${workItemId}`,
        'question_repeat_refused',
        { workItemId, questionId: String(prior.questionId ?? prior.id), at },
        at,
      )
      return false
    })
    return { ...decision, questions: fresh }
  }

  /**
   * Persists the executed-but-not-plan effects of a turn (§5.2), inside the caller's
   * transaction: ask_user questions (served by /api/questions), request_confirmation
   * cards, route decisions (hold/stop), reports, attempt stops and task cancels. Nothing a
   * planner sends can lift a hold (#20), and a hold or stop is the user's, so a wake turn's
   * route is refused (§10, §13 invariant 4).
   */
  #persistExtras(workItemId: string, unredacted: MetaDecision, at: string, wake: boolean): void {
    // §13 invariant 3: what a planner writes is outside text, and redaction comes before durability.
    const { questions, confirmations, routes, reports } = redactDeep({
      questions: unredacted.questions,
      confirmations: unredacted.confirmations,
      routes: unredacted.routes,
      reports: unredacted.reports,
    })
    const decision = { ...unredacted, questions, confirmations, routes, reports }
    // This turn has now seen the notes its context carried (§6).
    const seen = this.#store.workItems.get(workItemId)
    if (seen !== undefined) this.#store.workItems.save({ ...seen, notesSeenAt: at })
    const planRevision = seen?.planRevision
    for (const question of decision.questions ?? []) {
      this.#store.engines.save({
        id: `question/${question.id}`,
        questionId: question.id,
        question: question.question,
        options: question.options,
        ...(question.forMessageId !== undefined && { forMessageId: question.forMessageId }),
        ...(question.workItemId !== undefined && { workItemId: question.workItemId }),
        ...(question.workItemId === undefined && { workItemId }),
        ...(typeof planRevision === 'number' && { planRevision }),
        progressMark: this.#progressMark(workItemId),
        status: 'open',
        askedAt: question.at,
        createdAt: question.at,
        updatedAt: at,
      })
      this.#appendEvent(
        `question/${question.id}`,
        'question_asked',
        { questionId: question.id, question: question.question, workItemId, at },
        at,
      )
    }
    for (const draft of decision.confirmations ?? []) {
      this.#store.confirmations.save({
        id: draft.id,
        cls: draft.cls,
        operationHash: draft.operationHash,
        status: 'pending',
        createdAt: at,
        expiresAt: draft.expiresAt,
        payload: {
          operation: draft.operation,
          evidence: draft.evidence,
        } as unknown as Json,
        ...(draft.workItemId !== undefined && { workItemId: draft.workItemId }),
      })
      this.#appendEvent(
        `work:${draft.workItemId ?? workItemId}`,
        'confirmation_requested',
        { confirmationId: draft.id, cls: draft.cls, workItemId, at },
        at,
      )
    }
    for (const route of decision.routes ?? []) {
      if (route.target === undefined) continue
      if (route.decision === 'attach') this.#followups.reroute(route.messageId, route.target, at)
      if (route.decision !== 'hold' && route.decision !== 'stop') continue
      if (wake) {
        this.#appendEvent(
          `work:${workItemId}`,
          'route_refused',
          { workItemId, decision: route.decision, target: route.target, messageId: route.messageId, at },
          at,
        )
      } else if (route.decision === 'hold') {
        holdWorkItem(this.#store, route.target, {
          reason: route.note ?? 'held by planner',
          sourceMessageId: route.messageId,
          at,
        })
      } else {
        stopWorkItem(this.#store, route.target, {
          reason: route.note ?? 'stopped by planner route',
          messageId: route.messageId,
          at,
        })
      }
    }
    for (const report of decision.reports ?? []) {
      this.#appendEvent(
        `work:${report.workItemId}`,
        'result_reported',
        // The reducer's output travels with the words: a planner cannot report what is not so.
        {
          workItemId: report.workItemId,
          summary: report.summary,
          artifacts: report.artifacts,
          result: workResultOf(this.#store, report.workItemId) as unknown as Json,
          at,
        },
        at,
      )
    }
    for (const stop of decision.stops ?? []) {
      const doc = this.#store.attempts.get(stop.attemptId)
      if (doc === undefined) continue
      // A queued attempt has no process to confirm the end of. A running one stays running until
      // the runner has stopped its group and says so (§8.1).
      if (doc.state === 'queued') {
        this.#store.attempts.save({
          ...doc,
          state: transition(ATTEMPT_MACHINE, 'queued', 'interrupt_confirmed'),
          updatedAt: at,
        })
      }
      this.#appendEvent(
        `attempt:${stop.attemptId}`,
        'attempt.interrupt_requested',
        { attemptId: stop.attemptId, at },
        at,
      )
    }
    for (const cancel of decision.cancels ?? []) {
      const doc = this.#store.tasks.get(cancel.taskId)
      if (doc !== undefined) {
        // The reason is what makes it an exclusion: a cancel with none leaves the result incomplete.
        this.#store.tasks.save({
          ...doc,
          status: 'cancelled',
          cancelledReason: PLANNER_CANCELLED,
          updatedAt: at,
        })
        this.#appendEvent(`task:${cancel.taskId}`, 'task_cancelled', { taskId: cancel.taskId, at }, at)
      }
    }
  }

  /**
   * The receipt replay: same ack text (the Acknowledger returns the recorded one), and the
   * launch effects re-enqueued under their original keys — the queue coalesces each
   * kind + key to the row it already holds, so a retry adds no second launch. A drained row
   * comes back new, and the launch gate drops it once its attempt has moved on.
   */
  #replay(prior: StoreDoc): TurnOutcome {
    const messageId = String(prior.id)
    const ack = this.#acks.acknowledge(messageId, String(prior.ackText))
    const launches = launchRecordsOf(prior)
    const workItemId = typeof prior.workItemId === 'string' ? prior.workItemId : ''
    if (launches.length > 0 && String(this.#store.workItems.get(workItemId)?.state) === 'executing') {
      this.#store.atomic(() => {
        for (const launch of launches) {
          this.#effects.enqueue('launch', launch.key, {
            attempt_id: launch.attemptId,
            task_id: launch.taskId,
            work_item_id: workItemId,
            slot_id: launch.slotId,
            generation: Number(this.#store.attempts.get(launch.attemptId)?.generation ?? 1),
          })
        }
      })
    }
    return {
      acknowledged: ack.text,
      ...(typeof prior.workItemId === 'string' && { workItemId: prior.workItemId }),
      tasksCreated: typeof prior.tasksCreated === 'number' ? prior.tasksCreated : 0,
      launchesEnqueued: launches.map((launch) => launch.attemptId),
      escalated: prior.escalated === true,
    }
  }

  // ── Small seams ──────────────────────────────────────────────────────────────────────────

  /** Appends `type` as the stream's next gap-free event; callers stay inside their transaction. */
  #appendEvent(stream: string, type: string, body: Json, at: string): void {
    const seq = (this.#store.events.read(stream).at(-1)?.seq ?? 0) + 1
    this.#store.events.append(stream, { stream, seq, at, type, body })
  }

  /** Upserts the message doc, carrying `createdAt`, the repo, the key and the submission over. */
  #saveMessage(
    input: MessageTurn,
    fields: {
      routing: string
      at: string
      workItemId?: string
      ackText?: string
      tasksCreated?: number
      launches?: LaunchRecord[]
      escalated?: boolean
      quiet?: boolean
    },
  ): void {
    const prior = this.#store.messages.get(input.messageId)
    const repoId = input.repoId ?? repoOf(prior)
    const idempotencyKey =
      input.idempotencyKey ?? (typeof prior?.idempotencyKey === 'string' ? prior.idempotencyKey : undefined)
    const intent = input.intent ?? (prior?.intent as SubmissionIntent | undefined)
    const referencesWorkItem =
      input.referencesWorkItem ??
      (typeof prior?.referencesWorkItem === 'string' ? prior.referencesWorkItem : undefined)
    this.#store.messages.save({
      id: input.messageId,
      text: input.text,
      createdAt: typeof prior?.createdAt === 'string' ? prior.createdAt : fields.at,
      updatedAt: fields.at,
      routing: fields.routing,
      ...(repoId !== undefined && { repoId }),
      ...(idempotencyKey !== undefined && { idempotencyKey }),
      ...(intent !== undefined && { intent }),
      ...(referencesWorkItem !== undefined && { referencesWorkItem }),
      ...(fields.workItemId !== undefined && { workItemId: fields.workItemId }),
      ...(fields.ackText !== undefined && { ackText: fields.ackText }),
      ...(fields.tasksCreated !== undefined && { tasksCreated: fields.tasksCreated }),
      ...(fields.launches !== undefined && { launches: fields.launches }),
      ...(fields.escalated !== undefined && { escalated: fields.escalated }),
      ...(fields.quiet === true && { quiet: true }),
    })
  }
}

/** Two askings of the same words: case and spacing are not a different decision (§12.6). */
const sameWords = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase()

const QUESTION_WAKE =
  'a question beside running work: answer it with report_result. A plan, a stop or a spawn from this turn is dropped'

/**
 * What a question's turn may keep: its words, and what it asks the person. It has no authority over
 * the running work (§12.1), so a report lands on the question's own item.
 */
function answerOf(decision: MetaDecision, workItemId: string): MetaDecision {
  const { ack, questions, reports, escalated, protocolIncomplete } = decision
  return {
    ack,
    ...(questions !== undefined && { questions }),
    ...(reports !== undefined && { reports: reports.map((report) => ({ ...report, workItemId })) }),
    ...(escalated !== undefined && { escalated }),
    ...(protocolIncomplete !== undefined && { protocolIncomplete }),
  }
}

/** The furthest the planner has got: a card or a question outranks the plan it came with. */
function phaseOf(journal: PlannerTurnJournal): MetaTurnPhase {
  if (journal.confirmations.length > 0) return 'opening_card'
  if (journal.questions.length > 0) return 'asking'
  if (journal.plan !== undefined) return 'delegating'
  if (journal.reports.length > 0) return 'answering'
  return journal.acks.length > 0 ? 'planning' : 'reading'
}

/** Reads this turn's persisted launch records back off a message doc. */
function launchRecordsOf(doc: StoreDoc): LaunchRecord[] {
  const raw = doc.launches
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => entry as LaunchRecord)
}
