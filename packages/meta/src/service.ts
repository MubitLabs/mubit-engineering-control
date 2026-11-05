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
 * - **No acceptance checks yet.** The validator demands known checks, so every task is
 *   given the single pseudo-check `manual-review` (the only entry in `knownChecks`) — a
 *   plan is never rejected over checks it cannot name yet. Real checks arrive with the
 *   checks registry; until then a human is the acceptance gate.
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
 */
import type { Effects, Json, Store, StoreDoc } from '@mec/contracts'
import type { AttemptState, Caps, SchedulableTask, SlotView, WorkItemState } from '@mec/domain'
import {
  ACTIVE_ATTEMPT_STATES,
  BUILTIN_ROLE_NAMES,
  canTransition,
  createMandate,
  DEFAULT_CAPS,
  dependencySatisfied,
  planDispatches,
  transition,
  validateGraph,
  WORK_ITEM_MACHINE,
  WORK_ITEM_TERMINAL,
} from '@mec/domain'
import { loadPolicy } from '../../policy/src/policy'
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
import { routeMessage } from './routing'
import type { PlannerConfirmationDraft, PlannerQuestionRecord, PlannerTurnJournal } from './tools'
import { PlannerTools } from './tools'

/** One planned task as the service persists it: the v0 four fields, plus the §5.2 brief fields. */
export type MetaPlanTask = {
  taskId: string
  objective: string
  dependsOn: string[]
  role: string
  /** §6: the original message this task serves (defaults to the originating message id). */
  originalRequestRef?: string
  ownedPaths?: string[]
  acceptanceChecks?: string[]
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
}

/** The wake descriptor: why a turn runs (user message, specialist report, answered question). */
export type MetaWake = { reason: string; detail?: string }

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
type TurnInput = { messageId: string; text: string; repoId?: string; wake?: true }

/** A launch this turn enqueued, as persisted on the message doc so replays reuse the key. */
type LaunchRecord = { attemptId: string; key: string; taskId: string; slotId: string }

/** A task the dispatch may place: a plan's, a spawn's, or a stored one on lift. */
type DispatchCandidate = {
  taskId: string
  dependsOn: readonly string[]
  role: string
  slotHint?: { slotClass?: string }
}

/** The v0 pseudo-check standing in for the checks registry (see the module doc). */
const MANUAL_REVIEW_CHECK = 'manual-review'

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

/** §10 leaves a mandate's scope open: for now, the head of the origin message (#36). */
const MANDATE_SCOPE_CHARS = 200

/** v0 escalation is one streak per meta agent (see the module doc). */
const PLANNING_STREAK_KEY = 'meta-planning'

/** §11 placement ceiling for the v0 fake slot; no reading ranks least utilised, not high. */
const UTILISATION_CEILING = 0.8

/** v0 reserves no wake unit — nothing yet wakes on a follow-up delivery. */
const RESERVED_WAKE_SLOT = false

/** The single slot v0 dispatches onto while MEC_FAKE_ENGINE=1 (see the module doc). */
const FAKE_SLOT: SlotView = {
  id: 'fake-slot',
  state: 'healthy',
  usageUtilization: 0,
  inUse: 0,
  concurrency: 4,
  pinnedRoles: [],
}

let idCounter = 0

/** A contract-shaped id (`wi_…`): clock + counter + random, url-safe by construction. */
function freshId(prefix: string): string {
  idCounter += 1
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`
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
  readonly #acks = new Acknowledger()
  readonly #escalation = new EscalationCounter()

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
  }) {
    this.#store = deps.store
    this.#effects = deps.effects
    this.#brain = deps.brain
    this.#caps = deps.caps ?? DEFAULT_CAPS
    this.#now = deps.now ?? (() => new Date().toISOString())
    this.#policyText = deps.policyText ?? '{"preAuthorised":{}}'
    this.#marks = deps.marks
    this.#modelsTable = deps.modelsTable
  }

  async onUserMessage(input: {
    messageId: string
    text: string
    referencesWorkItem?: string
    /** §12.1, decision #10: the repository's conversation. Absent is Unassigned. */
    repoId?: string
  }): Promise<TurnOutcome> {
    assertRepoAdmission(this.#store, input)
    const prior = this.#store.messages.get(input.messageId)
    if (prior !== undefined && repoOf(prior) !== input.repoId) {
      throw new RepoAdmissionError('repo_mismatch', `${input.messageId} belongs to another repository`)
    }
    // A message already carrying a receipt replays verbatim: same ack, same launch keys —
    // the effects queue coalesces the re-enqueue to the existing rows (CONTRACTS §7).
    if (prior !== undefined && typeof prior.ackText === 'string') return this.#replay(prior)

    const routing = routeMessage({
      referencesWorkItem: input.referencesWorkItem,
      liveWork: this.#routingWork(input.repoId),
    })
    switch (routing.action) {
      case 'attach':
        return this.#noteAttached(input, routing.workItemId)
      case 'stopped_refused':
        return this.#refuseStopped(input)
      case 'conversation':
        return this.#noteConversation(input)
      case 'new_work':
        return await this.#startNewWork(input, prior)
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
        openQuestions: [],
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
      slots: slotViewsFromStore(this.#store, this.#marks?.()),
      frontierPreAuthorised:
        (loadPolicy(this.#policyText).preAuthorised as Record<string, unknown>).frontier_model !== undefined,
      now: () => new Date(this.#now()),
      liveWork: this.#routingWork(repoId),
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
  async onWake(input: { reason: string; detail?: string; workItemId?: string }): Promise<TurnOutcome> {
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
    const messageId = freshId('msg_wake_')
    const repo = repoId !== undefined ? { repoId } : {}
    const turn = { messageId, wake: true as const, ...repo }
    let decision: MetaDecision
    try {
      decision = await this.#brain({
        messageId,
        messageText: input.detail ?? input.reason,
        liveWork: this.#liveForBrain(repoId),
        workItemId,
        wake: { reason: input.reason, ...(input.detail !== undefined && { detail: input.detail }) },
        tools: this.#buildTools({ messageId, workItemId }, repoId),
        snapshot: this.#buildSnapshot({
          messageId,
          repoId,
          workItemId,
          turn: { wake: input.reason, ...(input.detail !== undefined && { detail: input.detail }) },
        }),
      })
    } catch (error) {
      return this.#failTurn(
        { ...turn, text: input.detail ?? input.reason },
        workItemId,
        error instanceof Error ? error.message : String(error),
      )
    }
    const plan = 'plan' in decision ? decision.plan : undefined
    if (plan === undefined) {
      return this.#ackOnlyTurn({ ...turn, text: input.reason }, workItemId, decision)
    }
    return this.#commitPlan({ ...turn, text: input.reason }, workItemId, plan, decision)
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
   * §5.2/§12.6: an answered question is persisted (first answer wins) and WAKES the
   * planner with the answer in context — the §1 gap this closes.
   */
  async onQuestionAnswered(
    questionId: string,
    answer: string,
  ): Promise<{ status: 'answered' | 'not_open' | 'missing'; outcome?: TurnOutcome }> {
    const docId = questionId.startsWith('question/') ? questionId : `question/${questionId}`
    const doc = this.#store.engines.get(docId)
    if (doc === undefined) return { status: 'missing' }
    if (doc.status !== 'open') return { status: 'not_open' }
    const at = this.#now()
    this.#store.atomic(() => {
      this.#store.engines.save({
        ...doc,
        status: 'answered',
        answer,
        answeredAt: at,
        updatedAt: at,
      })
      this.#appendEvent(
        docId,
        'question_answered',
        { questionId: typeof doc.questionId === 'string' ? doc.questionId : questionId, answer, at },
        at,
      )
    })
    const workItemId = typeof doc.workItemId === 'string' ? doc.workItemId : undefined
    const outcome = await this.onWake({
      reason: 'question answered',
      detail: `question "${String(doc.question ?? '')}" answered: ${answer}`,
      ...(workItemId !== undefined && { workItemId }),
    })
    return { status: 'answered', outcome }
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
   * then the hold lifts and saved ready tasks dispatch, in one transaction. A kept task runs
   * once, as on a replan: a task with any attempt is left alone. A launch already queued starts
   * on its row's next pass.
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
      const candidates = tasks
        .filter(
          (task) =>
            String(task.status) === 'ready' && this.#store.attempts.list({ taskId: task.id }).length === 0,
        )
        .map(
          (task): DispatchCandidate => ({
            taskId: String(task.id),
            dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : [],
            role: String(task.role),
            ...(task.slotHint !== undefined && { slotHint: task.slotHint as { slotClass?: string } }),
          }),
        )
      const statuses = new Map(tasks.map((task) => [String(task.id), task.status]))
      const records = this.#dispatch(workItemId, candidates, statuses, at)
      return { status: 'lifted', launches: records.map((record) => record.attemptId) }
    })
  }

  /** §6 attach: a message on existing work is acknowledged as a note, nothing more. */
  #noteAttached(input: TurnInput, workItemId: string): TurnOutcome {
    const at = this.#now()
    const ack = `Noted on ${workItemId}: it lands with the running work.`
    this.#store.atomic(() => {
      this.#appendEvent(
        `work:${workItemId}`,
        'message_attached',
        { workItemId, messageId: input.messageId, at },
        at,
      )
      this.#saveMessage(input, { routing: 'attach', at, workItemId, ackText: ack })
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
    input: TurnInput & { referencesWorkItem?: string },
    prior: StoreDoc | undefined,
  ): Promise<TurnOutcome> {
    const workItemId = typeof prior?.workItemId === 'string' ? prior.workItemId : freshId('wi_')
    if (prior === undefined) {
      const at = this.#now()
      this.#store.atomic(() => {
        this.#store.workItems.save({
          id: workItemId,
          state: 'planning',
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

    let decision: MetaDecision
    try {
      decision = await this.#brain({
        messageId: input.messageId,
        messageText: input.text,
        liveWork: this.#liveForBrain(input.repoId),
        workItemId,
        wake: { reason: 'user message', detail: input.text.slice(0, 200) },
        tools: this.#buildTools({ messageId: input.messageId, workItemId }, input.repoId),
        snapshot: this.#buildSnapshot({
          messageId: input.messageId,
          repoId: input.repoId,
          workItemId,
          turn: { wake: 'user message', detail: input.text.slice(0, 200) },
        }),
      })
    } catch (error) {
      // The brain failing must never throw outward (§6): the user gets the failure ack,
      // the work item is stopped with the error on its stream, and the turn ends.
      return this.#failTurn(input, workItemId, error instanceof Error ? error.message : String(error))
    }

    const plan = 'plan' in decision ? decision.plan : undefined
    if (plan === undefined) return this.#ackOnlyTurn(input, workItemId, decision)
    return this.#commitPlan(input, workItemId, plan, decision)
  }

  /**
   * Ack-only decision (e.g. the brain asked a question): the item stays `planning` for
   * the reply, and the decision's questions/confirmations/routes still persist — the
   * turn's whole write set, not just the words.
   */
  #ackOnlyTurn(input: TurnInput, workItemId: string, decision: MetaDecision): TurnOutcome {
    const fenced = this.#fencedTurn(input, workItemId)
    if (fenced !== undefined) return fenced
    const at = this.#now()
    this.#store.atomic(() => {
      this.#persistExtras(
        workItemId,
        this.#withinRepo(input.messageId, workItemId, decision, at),
        at,
        input.wake === true,
      )
      this.#saveMessage(input, {
        routing: 'new_work',
        at,
        workItemId,
        ackText: decision.ack,
        tasksCreated: 0,
        launches: [],
        escalated: decision.escalated === true,
      })
    })
    this.#acks.acknowledge(input.messageId, decision.ack)
    return {
      acknowledged: decision.ack,
      workItemId,
      tasksCreated: 0,
      launchesEnqueued: [],
      escalated: decision.escalated === true,
    }
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
    // v0: every task gets the pseudo-check (module doc); roles must exist in the registry.
    const issues = validateGraph(
      tasks.map((task) => ({
        id: task.taskId,
        dependsOn: [...task.dependsOn],
        ownedPaths: task.ownedPaths ?? [],
        acceptanceChecks:
          task.acceptanceChecks !== undefined && task.acceptanceChecks.length > 0
            ? [...task.acceptanceChecks]
            : [MANUAL_REVIEW_CHECK],
        maxAttempts: this.#caps.repairAttemptsPerTask + 1,
        basePolicy: 'integration',
        role: task.role,
      })),
      { knownChecks: [MANUAL_REVIEW_CHECK], knownRoles: BUILTIN_ROLE_NAMES },
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
      const decision = this.#withinRepo(input.messageId, workItemId, unscoped, at)
      const work = this.#store.workItems.get(workItemId)
      const repoId = repoOf(work)
      const planRevision = (typeof work?.planRevision === 'number' ? work.planRevision : 0) + 1
      const canonical = canonicalizePlan(tasks, this.#store.tasks.list({ workItemId }), () =>
        freshId('task_'),
      )
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
        this.#store.workItems.save(work)
      }

      // Decision #19: a key this work item already holds is the same task, so its id, status
      // and creation stay and only what the plan says about it changes.
      for (const { prior, ...task } of canonical) {
        this.#store.tasks.save({
          ...prior,
          id: task.taskId,
          workItemId,
          ...(repoId !== undefined && { repoId }),
          localKey: task.localKey,
          planRevision,
          objective: task.objective,
          dependsOn: task.dependsOn,
          role: task.role,
          status: prior?.status ?? 'ready',
          acceptanceChecks:
            task.acceptanceChecks !== undefined && task.acceptanceChecks.length > 0
              ? [...task.acceptanceChecks]
              : [MANUAL_REVIEW_CHECK],
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
      this.#store.engines.save({
        id: planSnapshotId(workItemId, planRevision),
        workItemId,
        ...(repoId !== undefined && { repoId }),
        revision: planRevision,
        messageId: input.messageId,
        ...(decision.bundleRevision !== undefined && { promptRevision: decision.bundleRevision }),
        tasks: canonical.map((task) => ({
          taskId: task.taskId,
          localKey: task.localKey,
          objective: task.objective,
          dependsOn: task.dependsOn,
          role: task.role,
        })),
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
          status: 'ready',
          acceptanceChecks: [MANUAL_REVIEW_CHECK],
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
      this.#persistExtras(workItemId, decision, at, input.wake === true)

      // Dependency-satisfied tasks only (§14): a fresh task is still `ready` — an integration
      // dependency needs `integrated` — so only a task a replan kept can satisfy one. A kept
      // task runs once: nothing launches a key that has moved on or already has an attempt.
      const candidates: DispatchCandidate[] = [
        ...canonical.filter(
          (task) =>
            (task.prior?.status ?? 'ready') === 'ready' &&
            this.#store.attempts.list({ taskId: task.taskId }).length === 0,
        ),
        ...(decision.spawns ?? []).map((spawn) => ({
          taskId: spawn.taskId,
          objective: spawn.objective,
          dependsOn: [] as string[],
          role: spawn.role,
          slotHint: spawn.slotHint,
        })),
      ]
      const statuses = new Map(canonical.map((task) => [task.taskId, task.prior?.status ?? 'ready']))
      const records = this.#dispatch(workItemId, candidates, statuses, at)
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
   * Places dependency-satisfied tasks (§11, §14), inside the caller's transaction, for plan
   * commit and lift alike. It re-reads the work, because this turn's own routes may have held
   * or stopped it: only live, unblocked work with an unwithdrawn mandate launches.
   */
  #dispatch(
    workItemId: string,
    candidates: readonly DispatchCandidate[],
    statuses: ReadonlyMap<string, unknown>,
    at: string,
  ): LaunchRecord[] {
    const work = this.#store.workItems.get(workItemId)
    if (work === undefined || isTerminal(work) || mandateOf(work).status === 'withdrawn') return []
    if (String(work.state) === 'blocked') return []
    if (isHeld(work)) {
      this.#appendEvent(`work:${workItemId}`, 'launch_withheld', { workItemId, reason: 'held', at }, at)
      return []
    }
    const repoId = repoOf(work)
    const terminalDep = (dep: string): 'accepted' | 'integrated' | undefined => {
      const state = statuses.get(dep)
      return state === 'accepted' || state === 'integrated' ? state : undefined
    }
    if (repoId === undefined) {
      this.#appendEvent(
        `work:${workItemId}`,
        'launch_withheld',
        { workItemId, reason: 'no repository', at },
        at,
      )
    }
    // Unassigned work is planned but never launched.
    const ready: SchedulableTask[] = (repoId === undefined ? [] : candidates)
      .filter((task) =>
        task.dependsOn.every(
          (dep) =>
            terminalDep(dep) !== undefined && dependencySatisfied(dep, terminalDep(dep)!, 'integration'),
        ),
      )
      .map((task) => ({
        taskId: task.taskId,
        workItemId,
        workItemPinned: false,
        readyAt: Date.parse(at),
        generation: 1,
        role: task.role,
        ...('slotHint' in task && task.slotHint?.slotClass !== undefined
          ? { slotClass: task.slotHint.slotClass }
          : {}),
      }))

    const active = this.#store.attempts
      .list()
      .filter((doc) => ACTIVE_ATTEMPT_STATES.includes(String(doc.state) as AttemptState))
      .map((doc) => ({
        taskId: String(doc.taskId),
        slotId: String(doc.slotId),
        workItemId: String(doc.workItemId),
      }))
    // Issue #14: the REAL healthy slots feed the dispatch (the fake shim stays for
    // MEC_FAKE_ENGINE). Degraded slots never place; usage is honest-unknown when absent.
    const slotViews = slotViewsFromStore(this.#store, this.#marks?.())
    const healthySlots: SlotView[] =
      process.env.MEC_FAKE_ENGINE === '1'
        ? [FAKE_SLOT]
        : slotViews.map((view) => ({
            id: view.slotId,
            state: (view.healthy ? 'healthy' : 'degraded') as 'healthy' | 'degraded',
            pinnedRoles: [] as string[],
            inUse: 0,
            concurrency: 1,
          }))
    const dispatch = planDispatches({
      ready,
      slots: healthySlots,
      active,
      caps: this.#caps,
      utilisationCeiling: UTILISATION_CEILING,
      reservedWakeSlot: RESERVED_WAKE_SLOT,
    })

    const records: LaunchRecord[] = []
    for (const launch of dispatch.launches) {
      const attemptId = this.#nextAttemptId()
      this.#store.attempts.save({
        id: attemptId,
        taskId: launch.taskId,
        workItemId,
        slotId: launch.slotId,
        state: 'queued',
        generation: 1,
        createdAt: at,
        updatedAt: at,
      })
      this.#appendEvent(
        `attempt:${attemptId}`,
        'attempt_queued',
        { attemptId, taskId: launch.taskId, workItemId, slotId: launch.slotId, generation: 1, at },
        at,
      )
      const key = `${attemptId}:1`
      this.#effects.enqueue('launch', key, {
        attempt_id: attemptId,
        task_id: launch.taskId,
        work_item_id: workItemId,
        slot_id: launch.slotId,
        generation: 1,
      })
      records.push({ attemptId, key, taskId: launch.taskId, slotId: launch.slotId })
    }
    return records
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

  /**
   * Persists the executed-but-not-plan effects of a turn (§5.2), inside the caller's
   * transaction: ask_user questions (served by /api/questions), request_confirmation
   * cards, route decisions (hold/stop), reports, attempt stops and task cancels. Nothing a
   * planner sends can lift a hold (#20), and a hold or stop is the user's, so a wake turn's
   * route is refused (§10, §13 invariant 4).
   */
  #persistExtras(workItemId: string, decision: MetaDecision, at: string, wake: boolean): void {
    for (const question of decision.questions ?? []) {
      this.#store.engines.save({
        id: `question/${question.id}`,
        questionId: question.id,
        question: question.question,
        options: question.options,
        ...(question.forMessageId !== undefined && { forMessageId: question.forMessageId }),
        ...(question.workItemId !== undefined && { workItemId: question.workItemId }),
        ...(question.workItemId === undefined && { workItemId }),
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
        { workItemId: report.workItemId, summary: report.summary, artifacts: report.artifacts, at },
        at,
      )
    }
    for (const stop of decision.stops ?? []) {
      const doc = this.#store.attempts.get(stop.attemptId)
      if (doc !== undefined) {
        this.#store.attempts.save({ ...doc, state: 'interrupted', updatedAt: at })
        this.#appendEvent(
          `attempt:${stop.attemptId}`,
          'attempt.interrupt_requested',
          { attemptId: stop.attemptId, at },
          at,
        )
      }
    }
    for (const cancel of decision.cancels ?? []) {
      const doc = this.#store.tasks.get(cancel.taskId)
      if (doc !== undefined) {
        this.#store.tasks.save({ ...doc, status: 'cancelled', updatedAt: at })
        this.#appendEvent(`task:${cancel.taskId}`, 'task_cancelled', { taskId: cancel.taskId, at }, at)
      }
    }
  }

  /**
   * The receipt replay: same ack text (the Acknowledger returns the recorded one), and the
   * launch effects re-enqueued under their original keys — the queue coalesces each
   * kind + key to the row it already holds, so a retry adds no second launch.
   */
  #replay(prior: StoreDoc): TurnOutcome {
    const messageId = String(prior.id)
    const ack = this.#acks.acknowledge(messageId, String(prior.ackText))
    const launches = launchRecordsOf(prior)
    if (launches.length > 0) {
      const workItemId = typeof prior.workItemId === 'string' ? prior.workItemId : ''
      this.#store.atomic(() => {
        for (const launch of launches) {
          this.#effects.enqueue('launch', launch.key, {
            attempt_id: launch.attemptId,
            task_id: launch.taskId,
            work_item_id: workItemId,
            slot_id: launch.slotId,
            generation: 1,
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

  /** Upserts the message doc, carrying `createdAt` over once it exists. */
  #saveMessage(
    input: TurnInput,
    fields: {
      routing: string
      at: string
      workItemId?: string
      ackText?: string
      tasksCreated?: number
      launches?: LaunchRecord[]
      escalated?: boolean
    },
  ): void {
    const prior = this.#store.messages.get(input.messageId)
    this.#store.messages.save({
      id: input.messageId,
      text: input.text,
      createdAt: typeof prior?.createdAt === 'string' ? prior.createdAt : fields.at,
      updatedAt: fields.at,
      routing: fields.routing,
      ...(input.repoId !== undefined && { repoId: input.repoId }),
      ...(fields.workItemId !== undefined && { workItemId: fields.workItemId }),
      ...(fields.ackText !== undefined && { ackText: fields.ackText }),
      ...(fields.tasksCreated !== undefined && { tasksCreated: fields.tasksCreated }),
      ...(fields.launches !== undefined && { launches: fields.launches }),
      ...(fields.escalated !== undefined && { escalated: fields.escalated }),
    })
  }

  /** The next durable `att_<n>`: one past the highest numbered attempt doc in the store. */
  #nextAttemptId(): string {
    let max = 0
    for (const doc of this.#store.attempts.list()) {
      const match = /^att_(\d+)$/.exec(String(doc.id))
      if (match !== null) max = Math.max(max, Number(match[1]))
    }
    return `att_${max + 1}`
  }
}

/** Reads this turn's persisted launch records back off a message doc. */
function launchRecordsOf(doc: StoreDoc): LaunchRecord[] {
  const raw = doc.launches
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => entry as LaunchRecord)
}
