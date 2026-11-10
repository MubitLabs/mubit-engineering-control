/**
 * The executed platform tools (T5, review 2026-11-04 §5.2): ALL NINE meta-agent tools run
 * for real against one turn — deterministic validation first, execution second, every
 * result mirrored into a per-turn journal the driver turns into the decision. Nothing
 * here touches I/O: the journal is the turn's write set, and the SERVICE persists it
 * (§6: the service owns every write) — the meta agent's only write channel is this tool
 * set, and it can never approve its own confirmations, edit policy, or exceed caps
 * because no tool here can.
 *
 * Validation is the deterministic core the plan demands: the existing graph validator
 * (cycles, missing deps, unknown checks/roles, path conflicts), budget ceilings, caps for
 * ad-hoc spawns, and the tier rules from `@mec/domain`'s tiers module (availability on at
 * least one healthy slot, frontier only pre-authorised, subagent policy within the role
 * ceiling). Four consecutive invalid proposals escalate (the v1 coordinator discipline).
 */
import { createHash } from 'node:crypto'
import type {
  AttemptState,
  BasePolicy,
  Caps,
  ModelTier,
  SlotModelsView,
  TaskState,
  TierTableLike,
} from '@mec/domain'
import {
  ATTEMPT_TERMINAL,
  BUILTIN_ROLE_NAMES,
  BUILTIN_ROSTER,
  commandNeed,
  DEFAULT_CAPS,
  isModelTier,
  placeableTiers,
  runsCommands,
  TASK_TERMINAL,
  type TierIssue,
  validateGraph,
  validateTierPlan,
} from '@mec/domain'
import type { ToolName } from '../../mec-tools/src/tools'
import type { PlannerAttemptRow, PlannerContextInput, PlannerScorecardRow } from './context'
import { CONTEXT_BOUNDS } from './context'
import { EscalationCounter } from './escalation'
import type { LiveWork } from './routing'
import { routeMessage } from './routing'

/** §5.2's task shape, mapped and defaulted; the service persists it verbatim. */
export type PlannerPlanTask = {
  taskId: string
  objective: string
  /** §6: the original message travels with every brief — defaults to the turn's message. */
  originalRequestRef: string
  ownedPaths: string[]
  acceptanceChecks: string[]
  /** Decision #33: this task touches sensitive ground. */
  sensitive?: boolean
  /** §10: the brief says finishing with no change is a valid outcome (a check, an investigation). */
  noChangeOk?: boolean
  dependsOn: string[]
  role: string
  /** §10, §14: what the task builds on. */
  basePolicy: BasePolicy
  modelRequest?: { tier?: ModelTier; model?: string; effort?: string; variant?: string; reason: string }
  slotHint?: { slotClass?: string; slotId?: string }
  budget?: { turns: number; wallClockMs: number; usd?: number }
  subagentPolicy?: { maxTier: ModelTier; depth: number }
}

export type PlannerQuestionRecord = {
  id: string
  question: string
  forMessageId?: string
  options: string[]
  workItemId?: string
  at: string
}

export type PlannerConfirmationDraft = {
  id: string
  cls: string
  operationHash: string
  expiresAt: string
  operation: Record<string, unknown>
  evidence: Record<string, unknown>
  workItemId?: string
}

export type PlannerSpawnRecord = {
  taskId: string
  objective: string
  role: string
  workItemId: string
  modelRequest?: PlannerPlanTask['modelRequest']
  slotHint?: PlannerPlanTask['slotHint']
}

/** Everything the tools executed in one turn — the service's write set. */
export type PlannerTurnJournal = {
  acks: { messageId: string; text: string; first: boolean }[]
  routes: { messageId: string; decision: string; target?: string; note?: string }[]
  plan?: { workItemId: string; tasks: PlannerPlanTask[] }
  spawns: PlannerSpawnRecord[]
  questions: PlannerQuestionRecord[]
  confirmations: PlannerConfirmationDraft[]
  reports: { workItemId: string; summary: string; artifacts: { kind: string; ref: string }[] }[]
  stops: { attemptId: string }[]
  cancels: { taskId: string }[]
  invalidProposals: number
  escalated: boolean
}

export type PlannerToolsConfig = {
  /** The message that woke this turn, and the work item the turn belongs to (if any). */
  turn: { messageId: string; workItemId?: string }
  /** The compiled §5.1 snapshot — the read tool pages over exactly what the planner saw. */
  snapshot: PlannerContextInput
  caps?: Caps
  /** The capability table and probe marks, for tier validation (§5.2). */
  table: TierTableLike
  slots: SlotModelsView[]
  frontierPreAuthorised?: boolean
  now?: () => Date
  /** Checks the repository has registered; `manual-review` stands in only where it has none. */
  knownChecks?: readonly string[]
  /** Routing set (§12.1) — stopped items visible as stopped so a reference is refused. */
  liveWork?: readonly LiveWork[]
  escalationLimit?: number
  /** Deterministic ids for tests; default is a per-executor counter. */
  idFactory?: () => string
}

/** §12.7: the report's summary ceiling — 100 words is a hard ceiling, not a target. */
const MAX_REPORT_WORDS = 100
/** §6: the meta agent's routing note is bounded at 50 words. */
const MAX_NOTE_WORDS = 50
const MAX_ACK_CHARS = 240
const MAX_QUESTION_CHARS = 600
const MAX_OPTIONS = 6
const MAX_OPTION_CHARS = 120
const MAX_TASKS_PER_PLAN = 20
const MAX_ARTIFACTS = 10
/** §13: a confirmation card opened by the planner expires after one day by default. */
const CONFIRMATION_TTL_MS = 24 * 60 * 60_000

const STOPPABLE_ATTEMPT_STATES = new Set(['queued', 'running', 'work_complete', 'stalled'])

/**
 * A task whose objective needs commands goes where its worker can run them (owner's horse tinder
 * test, 9 November 2026): refused when pinned to a slot that cannot, when no slot can, or when its
 * tier is served only where none can. Without a pin, placement picks a slot that can. Acceptance
 * checks are no reason on their own: MEC runs those, not the worker.
 */
function reachIssues(
  tasks: readonly PlannerPlanTask[],
  slots: readonly SlotModelsView[],
  table: TierTableLike,
): string[] {
  const healthy = slots.filter((slot) => slot.healthy)
  const capable = healthy.filter(runsCommands)
  const names = capable.map((slot) => slot.slotId).join(', ')
  const issues: string[] = []
  for (const task of tasks) {
    const word = commandNeed(task.objective)
    if (word === undefined || healthy.length === 0) continue
    const needs = `reach: task '${task.taskId}' needs a worker that runs commands (its objective says "${word}")`
    if (capable.length === 0) {
      issues.push(
        `${needs}, and no connection here can run commands: plan it as file edits only, because MEC runs the acceptance checks itself, and say in report_result what a person must run`,
      )
      continue
    }
    const pinned = slots.find((slot) => slot.slotId === task.slotHint?.slotId)
    if (pinned !== undefined && !runsCommands(pinned)) {
      issues.push(
        `${needs}, but slot '${pinned.slotId}' (${pinned.engine}) cannot run commands; pin it to one that can (${names}) or leave slot_hint out`,
      )
      continue
    }
    const tier = task.modelRequest?.tier
    if (tier !== undefined && placeableTiers(table, healthy).includes(tier)) {
      const fits = placeableTiers(table, capable)
      if (!fits.includes(tier)) {
        issues.push(
          `${needs}, but tier '${tier}' is served only by connections that cannot run commands; choose a tier ${names} serves (${fits.join(', ') || 'none'})`,
        )
      }
    }
  }
  return issues
}

const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length

/** Tool args arrive as the MCP `arguments` object; a string body is parsed defensively. */
export function decodeToolArgs(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input)
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
}

/** Stable JSON for the operation hash: object keys sorted at every level. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : []

export class PlannerTools {
  readonly #config: PlannerToolsConfig
  readonly #now: () => Date
  readonly #nextId: () => string
  readonly #escalation = new EscalationCounter()
  readonly #journal: PlannerTurnJournal

  constructor(config: PlannerToolsConfig) {
    this.#config = config
    this.#now = config.now ?? (() => new Date())
    this.#nextId = config.idFactory ?? (() => `t${Math.random().toString(36).slice(2, 10)}`)
    this.#journal = {
      acks: [],
      routes: [],
      spawns: [],
      questions: [],
      confirmations: [],
      reports: [],
      stops: [],
      cancels: [],
      invalidProposals: 0,
      escalated: false,
    }
  }

  /** The turn's write set — the service persists exactly this. */
  journal(): PlannerTurnJournal {
    return structuredClone(this.#journal)
  }

  /** Executes one platform tool call: decode, validate deterministically, execute. */
  execute(tool: ToolName, rawArgs: unknown): unknown {
    const args = decodeToolArgs(rawArgs)
    switch (tool) {
      case 'acknowledge':
        return this.#acknowledge(args)
      case 'route':
        return this.#route(args)
      case 'propose_plan':
        return this.#proposePlan(args)
      case 'spawn_agent':
        return this.#spawnAgent(args)
      case 'ask_user':
        return this.#askUser(args)
      case 'request_confirmation':
        return this.#requestConfirmation(args)
      case 'report_result':
        return this.#reportResult(args)
      case 'read':
        return this.#read(args)
      case 'stop_agent':
        return this.#stopAgent(args)
      case 'cancel_task':
        return this.#cancelTask(args)
      default:
        return { ok: false, issues: [`tool '${tool}' is not a meta-agent tool`] }
    }
  }

  // ── acknowledge ────────────────────────────────────────────────────────────────────────────

  #acknowledge(args: Record<string, unknown>): unknown {
    const messageId = typeof args.message_id === 'string' ? args.message_id.trim() : ''
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    const issues: string[] = []
    if (messageId === '') issues.push('acknowledge requires a message_id')
    if (text === '') issues.push('acknowledge requires a non-empty text')
    else if (text.length > MAX_ACK_CHARS)
      issues.push(`acknowledge text must be at most ${MAX_ACK_CHARS} characters`)
    if (issues.length > 0) return { ok: false, issues }
    // §12.2 idempotent per message id: the first acknowledgement is final.
    const prior = this.#journal.acks.find((ack) => ack.messageId === messageId)
    if (prior !== undefined) return { ok: true, message_id: messageId, text: prior.text, first: false }
    this.#journal.acks.push({ messageId, text, first: true })
    return { ok: true, message_id: messageId, text, first: true }
  }

  // ── route ──────────────────────────────────────────────────────────────────────────────────

  #route(args: Record<string, unknown>): unknown {
    const messageId = typeof args.message_id === 'string' ? args.message_id.trim() : ''
    const decision = typeof args.decision === 'string' ? args.decision : ''
    const target = typeof args.target === 'string' && args.target !== '' ? args.target : undefined
    const note = typeof args.note === 'string' ? args.note.trim() : undefined
    const issues: string[] = []
    if (messageId === '') issues.push('route requires a message_id')
    if (note !== undefined && countWords(note) > MAX_NOTE_WORDS)
      issues.push(`route note is bounded at ${MAX_NOTE_WORDS} words (§6)`)
    const needsTarget = decision === 'attach' || decision === 'stop' || decision === 'hold'
    if (needsTarget && target === undefined)
      issues.push(`route decision '${decision}' requires a target work item`)

    const liveWork = this.#config.liveWork ?? this.#derivedLiveWork()
    if (issues.length === 0) {
      switch (decision) {
        case 'new_work':
        case 'conversation':
          break
        case 'attach': {
          // The domain routing module decides validity (§5.2): a reference binds only to
          // live work; a stopped item is refused, never silently resumed (§12.1).
          const routing = routeMessage({ referencesWorkItem: target, liveWork })
          if (routing.action === 'attach') break
          if (routing.action === 'stopped_refused')
            issues.push(
              `${target} is stopped — it will not resume silently; route as new_work instead (§12.1)`,
            )
          else
            issues.push(
              `${target} is not live work — attachment does not bind (§12.1); route as new_work or conversation`,
            )
          break
        }
        case 'stop':
        case 'hold': {
          const open = this.#config.snapshot.work.find((item) => item.id === target)
          if (open === undefined)
            issues.push(`${target ?? '(no target)'} is not open work — ${decision} needs a live work item`)
          break
        }
        default:
          issues.push(
            `route decision must be new_work, attach, stop, hold or conversation (got '${decision}'): only the owner lifts a hold (§12.5)`,
          )
      }
    }
    if (issues.length > 0) return { ok: false, issues }
    this.#journal.routes.push({
      messageId,
      decision,
      ...(target !== undefined && { target }),
      ...(note !== undefined && { note }),
    })
    return { ok: true, decision, ...(target !== undefined && { target }) }
  }

  #derivedLiveWork(): LiveWork[] {
    return this.#config.snapshot.work.map((item) => ({
      workItemId: item.id,
      tasks: item.tasks.map((task) => ({ taskId: task.id, status: task.state ?? 'ready' })),
      openQuestions: item.openQuestions,
      stopped: false,
    }))
  }

  // ── propose_plan ───────────────────────────────────────────────────────────────────────────

  #proposePlan(args: Record<string, unknown>): unknown {
    const workItemId =
      typeof args.work_item === 'string' && args.work_item !== ''
        ? args.work_item
        : (this.#config.turn.workItemId ?? '')
    const raw = args.tasks
    const issues: string[] = []
    const tasks: PlannerPlanTask[] = []

    if (workItemId === '') issues.push('propose_plan requires a work_item (or a turn with one)')
    if (!Array.isArray(raw) || raw.length === 0) issues.push('propose_plan requires a non-empty tasks array')
    else if (raw.length > MAX_TASKS_PER_PLAN)
      issues.push(`propose_plan is bounded at ${MAX_TASKS_PER_PLAN} tasks (plan §6 list default)`)

    if (Array.isArray(raw)) {
      raw.forEach((entry, index) => {
        if (typeof entry !== 'object' || entry === null) {
          issues.push(`tasks[${index}] must be an object`)
          return
        }
        const task = entry as Record<string, unknown>
        const id = typeof task.id === 'string' ? task.id.trim() : ''
        const objective = typeof task.objective === 'string' ? task.objective.trim() : ''
        if (id === '') issues.push(`tasks[${index}] needs a non-empty string id`)
        if (objective === '') issues.push(`tasks[${index}] needs a non-empty objective`)
        const modelRequest = this.#parseModelRequest(task.model_request, index, issues)
        const subagentPolicy = this.#parseSubagentPolicy(task.subagent_policy, index, issues)
        const budget = this.#parseBudget(task.budget, index, issues)
        const slotHintRaw = task.slot_hint
        let slotHint: PlannerPlanTask['slotHint']
        if (slotHintRaw !== undefined) {
          if (typeof slotHintRaw !== 'object' || slotHintRaw === null) {
            issues.push(`tasks[${index}].slot_hint must be {slot_class? , slot_id?}`)
          } else {
            const hint = slotHintRaw as Record<string, unknown>
            const slotClass = typeof hint.slot_class === 'string' ? hint.slot_class : undefined
            const slotId = typeof hint.slot_id === 'string' ? hint.slot_id : undefined
            if (slotClass === undefined && slotId === undefined)
              issues.push(`tasks[${index}].slot_hint needs slot_class or slot_id`)
            if (slotId !== undefined) {
              const slot = this.#config.slots.find((entry) => entry.slotId === slotId)
              if (slot === undefined) issues.push(`tasks[${index}].slot_hint names unknown slot '${slotId}'`)
              else if (!slot.healthy)
                issues.push(`tasks[${index}].slot_hint names slot '${slotId}', which is not healthy`)
            }
            slotHint = {
              ...(slotClass !== undefined && { slotClass }),
              ...(slotId !== undefined && { slotId }),
            }
          }
        }
        if (
          task.base_policy !== undefined &&
          task.base_policy !== 'integration' &&
          task.base_policy !== 'contract'
        ) {
          issues.push(`tasks[${index}].base_policy must be 'integration' or 'contract'`)
        }
        tasks.push({
          taskId: id,
          objective,
          originalRequestRef:
            typeof task.original_request_ref === 'string' && task.original_request_ref !== ''
              ? task.original_request_ref
              : this.#config.turn.messageId,
          ownedPaths: stringArray(task.owned_paths),
          acceptanceChecks: (() => {
            const checks = stringArray(task.acceptance_checks)
            return checks.length > 0 ? checks : [...(this.#config.knownChecks ?? ['manual-review'])]
          })(),
          ...(task.sensitive === true && { sensitive: true }),
          ...(task.no_change_ok === true && { noChangeOk: true }),
          dependsOn: stringArray(task.depends_on),
          role: typeof task.role === 'string' && task.role !== '' ? task.role : 'implementer',
          basePolicy: task.base_policy === 'contract' ? 'contract' : 'integration',
          ...(modelRequest !== undefined && { modelRequest }),
          ...(slotHint !== undefined && { slotHint }),
          ...(budget !== undefined && { budget }),
          ...(subagentPolicy !== undefined && { subagentPolicy }),
        })
      })
    }

    const caps = this.#config.caps ?? DEFAULT_CAPS
    const knownChecks = this.#config.knownChecks ?? ['manual-review']
    if (issues.length === 0) {
      const graphIssues = validateGraph(
        tasks.map((task) => ({
          id: task.taskId,
          dependsOn: task.dependsOn,
          ownedPaths: task.ownedPaths,
          acceptanceChecks: task.acceptanceChecks,
          maxAttempts: caps.repairAttemptsPerTask + 1,
          basePolicy: task.basePolicy,
          role: task.role,
        })),
        { knownChecks, knownRoles: BUILTIN_ROLE_NAMES },
      )
      issues.push(...graphIssues.map((issue) => `${issue.kind}: ${issue.detail}`))

      for (const task of tasks) {
        const roster = BUILTIN_ROSTER[task.role as keyof typeof BUILTIN_ROSTER]
        if (task.budget !== undefined && roster !== undefined && task.budget.turns > roster.budgetTurns) {
          issues.push(
            `budget: Task '${task.taskId}' asks for ${task.budget.turns} turns; role '${task.role}' is capped at ${roster.budgetTurns}`,
          )
        }
      }

      const tierIssues: TierIssue[] = validateTierPlan({
        tasks: tasks.map((task) => ({
          taskId: task.taskId,
          role: task.role,
          ...(task.modelRequest !== undefined && { modelRequest: task.modelRequest }),
          ...(task.subagentPolicy !== undefined && { subagentPolicy: task.subagentPolicy }),
        })),
        table: this.#config.table,
        slots: this.#config.slots,
        frontierPreAuthorised: this.#config.frontierPreAuthorised ?? false,
      })
      issues.push(...tierIssues.map((issue) => `${issue.kind}: ${issue.detail}`))
      issues.push(...reachIssues(tasks, this.#config.slots, this.#config.table))
    }

    if (issues.length > 0) {
      this.#journal.invalidProposals += 1
      // Four consecutive invalid proposals escalate (§6); the streak resets on a valid one.
      const outcome = this.#escalation.addInvalid('planner-turn')
      if (outcome === 'escalate') this.#journal.escalated = true
      return {
        ok: false,
        issues: issues.slice(0, 10),
        ...(this.#journal.escalated && {
          escalated: true,
          note: 'four consecutive invalid proposals — the user decides from here',
        }),
      }
    }
    this.#escalation.reset('planner-turn')
    this.#journal.plan = { workItemId, tasks }
    return { ok: true, tasks }
  }

  #parseModelRequest(
    raw: unknown,
    index: number,
    issues: string[],
  ): PlannerPlanTask['modelRequest'] | undefined {
    if (raw === undefined) {
      // Acceptance finding 4 Nov: a task WITHOUT a tier is exactly what §5.3 forbids —
      // push it back as a repair instead of accepting silently.
      issues.push(
        `tasks[${index}].model_request is required: every task carries {tier | model, effort?, reason}`,
      )
      return undefined
    }
    if (typeof raw !== 'object' || raw === null) {
      issues.push(`tasks[${index}].model_request must be {tier | model, effort?, reason}`)
      return undefined
    }
    const request = raw as Record<string, unknown>
    const tier = isModelTier(request.tier) ? request.tier : undefined
    const model = typeof request.model === 'string' ? request.model : undefined
    const effort = typeof request.effort === 'string' ? request.effort : undefined
    const variant = typeof request.variant === 'string' ? request.variant : undefined
    const reason = typeof request.reason === 'string' ? request.reason.trim() : ''
    if ((tier !== undefined) === (model !== undefined))
      issues.push(`tasks[${index}].model_request needs exactly one of tier or model (contracts ModelRequest)`)
    if (reason === '') issues.push(`tasks[${index}].model_request needs a reason (§5.3: say why this tier)`)
    if (request.tier !== undefined && !isModelTier(request.tier))
      issues.push(
        `tasks[${index}].model_request tier '${String(request.tier)}' is not one of fast, balanced, strong, frontier`,
      )
    return {
      ...(tier !== undefined && { tier }),
      ...(model !== undefined && { model }),
      ...(effort !== undefined && { effort }),
      ...(variant !== undefined && { variant }),
      reason,
    }
  }

  #parseSubagentPolicy(
    raw: unknown,
    index: number,
    issues: string[],
  ): PlannerPlanTask['subagentPolicy'] | undefined {
    if (raw === undefined) return undefined
    if (typeof raw !== 'object' || raw === null) {
      issues.push(`tasks[${index}].subagent_policy must be {max_tier, depth}`)
      return undefined
    }
    const policy = raw as Record<string, unknown>
    const maxTier = isModelTier(policy.max_tier) ? policy.max_tier : undefined
    const depth = typeof policy.depth === 'number' ? policy.depth : undefined
    if (maxTier === undefined)
      issues.push(`tasks[${index}].subagent_policy.max_tier must be a tier on the ladder`)
    if (depth === undefined || !Number.isInteger(depth) || depth < 0)
      issues.push(`tasks[${index}].subagent_policy.depth must be a non-negative integer`)
    if (maxTier === undefined || depth === undefined) return undefined
    return { maxTier, depth }
  }

  #parseBudget(raw: unknown, index: number, issues: string[]): PlannerPlanTask['budget'] | undefined {
    if (raw === undefined) return undefined
    if (typeof raw !== 'object' || raw === null) {
      issues.push(`tasks[${index}].budget must be {turns, wall_clock_ms, usd?}`)
      return undefined
    }
    const budget = raw as Record<string, unknown>
    const turns = typeof budget.turns === 'number' ? budget.turns : undefined
    const wallClockMs = typeof budget.wall_clock_ms === 'number' ? budget.wall_clock_ms : undefined
    const usd = typeof budget.usd === 'number' ? budget.usd : undefined
    if (turns === undefined || !Number.isInteger(turns) || turns < 1)
      issues.push(`tasks[${index}].budget.turns must be a positive integer`)
    if (wallClockMs === undefined || !Number.isInteger(wallClockMs) || wallClockMs < 1)
      issues.push(`tasks[${index}].budget.wall_clock_ms must be a positive integer`)
    if (turns === undefined || wallClockMs === undefined) return undefined
    return { turns, wallClockMs, ...(usd !== undefined && { usd }) }
  }

  // ── spawn_agent ────────────────────────────────────────────────────────────────────────────

  #spawnAgent(args: Record<string, unknown>): unknown {
    const objective = typeof args.task === 'string' ? args.task.trim() : ''
    const role = typeof args.role === 'string' ? args.role.trim() : ''
    const issues: string[] = []
    if (objective === '') issues.push('spawn_agent requires a task (the objective)')
    if (role === '') issues.push('spawn_agent requires a role')
    else if (role === 'meta_agent' || role === 'setup_agent')
      issues.push(`spawn_agent cannot spawn '${role}' — the meta agent spawns specialists only`)
    else if (!BUILTIN_ROLE_NAMES.includes(role))
      issues.push(`spawn_agent role '${role}' is not in the registry (§7)`)
    const workItemId =
      typeof args.work_item === 'string' && args.work_item !== ''
        ? args.work_item
        : this.#config.turn.workItemId
    if (workItemId === undefined || workItemId === '')
      issues.push('spawn_agent needs a work item (the turn has none — propose_plan first)')
    else if (!this.#config.snapshot.work.some((item) => item.id === workItemId))
      issues.push(`spawn_agent work item '${workItemId}' is not open work`)

    const modelRequest = this.#parseModelRequest(args.model_request, -1, issues)
    const caps = this.#config.caps ?? DEFAULT_CAPS
    if (issues.length === 0) {
      const active = this.#config.snapshot.attempts.filter(
        (attempt) => attempt.state !== undefined && !ATTEMPT_TERMINAL.includes(attempt.state as AttemptState),
      ).length
      const inWorkItem = this.#config.snapshot.attempts.filter(
        (attempt) =>
          attempt.workItemId === workItemId &&
          attempt.state !== undefined &&
          !ATTEMPT_TERMINAL.includes(attempt.state as AttemptState),
      ).length
      if (active + this.#journal.spawns.length >= caps.globalActiveAttempts)
        issues.push(
          `caps: ${active + this.#journal.spawns.length} attempts already active; the global cap is ${caps.globalActiveAttempts}`,
        )
      if (inWorkItem >= caps.perWorkItem)
        issues.push(
          `caps: work item ${workItemId} already has ${inWorkItem} active attempts; the per-work-item cap is ${caps.perWorkItem}`,
        )
    }
    if (issues.length > 0) return { ok: false, issues }

    const taskId = `task_${this.#nextId()}`
    this.#journal.spawns.push({
      taskId,
      objective,
      role,
      workItemId: workItemId as string,
      ...(modelRequest !== undefined && { modelRequest }),
    })
    return { ok: true, task: taskId, role, work_item: workItemId }
  }

  // ── ask_user ───────────────────────────────────────────────────────────────────────────────

  #askUser(args: Record<string, unknown>): unknown {
    const question = typeof args.question === 'string' ? args.question.trim() : ''
    const forMessageId =
      typeof args.for_message_id === 'string' && args.for_message_id !== '' ? args.for_message_id : undefined
    const options = stringArray(args.options)
    const issues: string[] = []
    if (question === '') issues.push('ask_user requires a question')
    else if (question.length > MAX_QUESTION_CHARS)
      issues.push(`ask_user question is bounded at ${MAX_QUESTION_CHARS} characters`)
    if (options.length > MAX_OPTIONS) issues.push(`ask_user takes at most ${MAX_OPTIONS} options`)
    for (const option of options) {
      if (option.length > MAX_OPTION_CHARS)
        issues.push(`ask_user options are bounded at ${MAX_OPTION_CHARS} characters`)
    }
    // §12.6: the same decision is never requested twice — deduped within the turn.
    if (this.#journal.questions.some((prior) => prior.question === question))
      issues.push('this exact question was already asked this turn (§12.6)')
    if (issues.length > 0) return { ok: false, issues }

    const record: PlannerQuestionRecord = {
      id: `q_${this.#nextId()}`,
      question,
      options,
      ...(forMessageId !== undefined && { forMessageId }),
      ...(this.#config.turn.workItemId !== undefined && { workItemId: this.#config.turn.workItemId }),
      at: this.#now().toISOString(),
    }
    this.#journal.questions.push(record)
    return { ok: true, question: { id: record.id, question, options, for_message_id: forMessageId } }
  }

  // ── request_confirmation ───────────────────────────────────────────────────────────────────

  #requestConfirmation(args: Record<string, unknown>): unknown {
    const issues: string[] = []
    if (typeof args.operation !== 'object' || args.operation === null) {
      return { ok: false, issues: ['request_confirmation requires an operation object with a class'] }
    }
    const operation = args.operation as Record<string, unknown>
    const cls = typeof operation.class === 'string' ? operation.class.trim() : ''
    if (cls === '') issues.push('request_confirmation requires operation.class (e.g. frontier_model, §5.2)')
    if (typeof args.evidence !== 'object' || args.evidence === null)
      issues.push('request_confirmation requires an evidence object')
    if (issues.length > 0) return { ok: false, issues }

    const draft: PlannerConfirmationDraft = {
      id: `conf_${this.#nextId()}`,
      cls,
      operationHash: createHash('sha256').update(stableStringify(operation), 'utf8').digest('hex'),
      expiresAt: new Date(this.#now().getTime() + CONFIRMATION_TTL_MS).toISOString(),
      operation,
      evidence: args.evidence as Record<string, unknown>,
      ...(this.#config.turn.workItemId !== undefined && { workItemId: this.#config.turn.workItemId }),
    }
    this.#journal.confirmations.push(draft)
    // §13: the card never self-approves — there is no approve path among these tools.
    return {
      ok: true,
      confirmation: {
        id: draft.id,
        class: cls,
        operation_hash: draft.operationHash,
        expires_at: draft.expiresAt,
      },
    }
  }

  // ── report_result ──────────────────────────────────────────────────────────────────────────

  #reportResult(args: Record<string, unknown>): unknown {
    const workItemId =
      typeof args.work_item === 'string' && args.work_item !== ''
        ? args.work_item
        : (this.#config.turn.workItemId ?? '')
    const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
    const issues: string[] = []
    if (workItemId === '') issues.push('report_result requires a work_item')
    else if (
      workItemId !== this.#config.turn.workItemId &&
      !this.#config.snapshot.work.some((item) => item.id === workItemId)
    )
      issues.push(`report_result work item '${workItemId}' is not open work in this repository`)
    if (summary === '') issues.push('report_result requires a non-empty summary')
    else if (countWords(summary) > MAX_REPORT_WORDS)
      issues.push(`report_result summary is bounded at ${MAX_REPORT_WORDS} words (§12.7)`)
    const artifactsRaw = Array.isArray(args.artifacts) ? args.artifacts : []
    if (artifactsRaw.length > MAX_ARTIFACTS)
      issues.push(`report_result takes at most ${MAX_ARTIFACTS} artifacts`)
    const artifacts: { kind: string; ref: string }[] = []
    for (const entry of artifactsRaw) {
      if (typeof entry !== 'object' || entry === null) {
        issues.push('each artifact must be {kind, ref}')
        break
      }
      const artifact = entry as Record<string, unknown>
      if (typeof artifact.kind !== 'string' || typeof artifact.ref !== 'string' || artifact.ref === '') {
        issues.push('each artifact must be {kind, ref}')
        break
      }
      artifacts.push({ kind: artifact.kind, ref: artifact.ref })
    }
    if (issues.length > 0) return { ok: false, issues }
    this.#journal.reports.push({ workItemId, summary, artifacts })
    return { ok: true, summary, artifacts }
  }

  // ── read ───────────────────────────────────────────────────────────────────────────────────

  #read(args: Record<string, unknown>): unknown {
    const resource = typeof args.resource === 'string' ? args.resource.trim() : ''
    const cursor =
      typeof args.cursor === 'string' && args.cursor !== '' ? Number.parseInt(args.cursor, 10) : 0
    const offset = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0
    if (resource === '') return { ok: false, issues: ['read requires a resource'] }

    const snapshot = this.#config.snapshot
    const page = <T>(rows: readonly T[]): { items: T[]; next?: number } => {
      const sliced = rows.slice(offset, offset + CONTEXT_BOUNDS.tasksPerWorkItem)
      const next = offset + sliced.length
      return { items: sliced, ...(next < rows.length && { next }) }
    }

    if (resource === 'work_items') {
      const { items, next } = page(
        snapshot.work.map((item) => ({ id: item.id, stage: item.stage, state: item.state })),
      )
      return { ok: true, resource, items, ...(next !== undefined && { next: String(next) }) }
    }
    const workMatch = /^work_item\/(.+)$/.exec(resource)
    if (workMatch !== null) {
      const id = workMatch[1] ?? ''
      const item = snapshot.work.find((entry) => entry.id === id)
      if (item === undefined) return { ok: false, issues: [`work item '${id}' is not open`] }
      return { ok: true, resource, item }
    }
    const taskMatch = /^task\/(.+)$/.exec(resource)
    if (taskMatch !== null) {
      const task = snapshot.work
        .flatMap((item) => item.tasks.map((t) => ({ ...t, workItemId: item.id })))
        .find((t) => t.id === taskMatch[1])
      if (task === undefined) return { ok: false, issues: [`task '${taskMatch[1]}' not found in open work`] }
      const attempts = snapshot.attempts.filter((attempt) => attempt.taskId === task.id)
      return { ok: true, resource, task, attempts }
    }
    const attemptMatch = /^attempt\/([^/]+)(\/report)?$/.exec(resource)
    if (attemptMatch !== null) {
      const attempt = snapshot.attempts.find((entry) => entry.id === attemptMatch?.[1])
      if (attempt === undefined) return { ok: false, issues: [`attempt '${attemptMatch?.[1]}' not found`] }
      if (attemptMatch[2] === '/report') {
        return {
          ok: true,
          resource,
          report:
            attempt.terminalReason !== undefined
              ? `attempt ${attempt.id} ended '${attempt.terminalReason}'`
              : `(no report body in the planner snapshot — read the attempt's event stream)`,
        }
      }
      return { ok: true, resource, attempt }
    }
    if (resource === 'slots') return { ok: true, resource, items: snapshot.slots }
    if (resource === 'models')
      return { ok: true, resource, items: snapshot.models.rows, withheld: snapshot.models.withheldCount }
    if (resource === 'scorecards' || resource.startsWith('scorecards/')) {
      const rows: PlannerScorecardRow[] | undefined = snapshot.scorecards?.()
      if (rows === undefined || rows.length === 0)
        return { ok: true, resource, items: [], hint: 'unknown for now — no role×tier data exists yet' }
      const { items, next } = page(rows)
      return { ok: true, resource, items, ...(next !== undefined && { next: String(next) }) }
    }
    if (resource === 'confirmations') {
      const { items, next } = page(snapshot.confirmations)
      return { ok: true, resource, items, ...(next !== undefined && { next: String(next) }) }
    }
    return {
      ok: false,
      issues: [
        `unknown resource '${resource}' — try work_items, work_item/<id>, task/<id>, attempt/<id>[/report], slots, models, scorecards, confirmations`,
      ],
    }
  }

  // ── stop_agent / cancel_task ───────────────────────────────────────────────────────────────

  #stopAgent(args: Record<string, unknown>): unknown {
    const attemptId =
      typeof args.agent === 'string'
        ? args.agent.trim()
        : typeof args.attempt === 'string'
          ? args.attempt.trim()
          : ''
    if (attemptId === '') return { ok: false, issues: ['stop_agent requires an attempt id'] }
    const attempt: PlannerAttemptRow | undefined = this.#config.snapshot.attempts.find(
      (entry) => entry.id === attemptId,
    )
    if (attempt === undefined) return { ok: false, issues: [`attempt '${attemptId}' not found`] }
    const state = (attempt.state ?? 'unknown') as AttemptState
    if (ATTEMPT_TERMINAL.includes(state))
      return { ok: false, issues: [`attempt '${attemptId}' already ended '${state}' — nothing to stop`] }
    if (!STOPPABLE_ATTEMPT_STATES.has(state))
      return {
        ok: false,
        issues: [
          `attempt '${attemptId}' is '${state}' — stop it from its parked state is not a planner action`,
        ],
      }
    this.#journal.stops.push({ attemptId })
    return { ok: true, attempt: attemptId, state }
  }

  #cancelTask(args: Record<string, unknown>): unknown {
    const taskId = typeof args.task === 'string' ? args.task.trim() : ''
    if (taskId === '') return { ok: false, issues: ['cancel_task requires a task id'] }
    const task = this.#config.snapshot.work
      .flatMap((item) => item.tasks.map((t) => ({ ...t, workItemId: item.id })))
      .find((t) => t.id === taskId)
    if (task === undefined) return { ok: false, issues: [`task '${taskId}' not found in open work`] }
    const state = (task.state ?? 'ready') as TaskState
    if (TASK_TERMINAL.includes(state))
      return { ok: false, issues: [`task '${taskId}' is already '${state}'`] }
    this.#journal.cancels.push({ taskId })
    // The cancel commits with the turn: the planner reads what the task is then, and what it was.
    return { ok: true, task: taskId, state: 'cancelled', was: state }
  }
}
