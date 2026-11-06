/**
 * `CoreForEngines` on the store (CONTRACTS §6, spec §10, §17): what the runtime reports, past
 * tense, becomes documents, events and state in the caller's transaction. Attempts and tasks move
 * only through `ATTEMPT_MACHINE` and `TASK_MACHINE`. A fact may not be refused, so one the machine
 * has no row for, or one from a stale generation, stays on the record as an event and moves
 * nothing: a stopped attempt's late `session_started` must not bring it back.
 */
import type {
  AttemptRef,
  EngineEvent,
  ExitPayload,
  Generation,
  InputId,
  IsoTime,
  Json,
  Operation,
  Question,
  Report,
  Slot,
  SlotId,
  Store,
  StoreDoc,
  UsagePayload,
  UsageReading,
} from '@mec/contracts'
import { ATTEMPT_MACHINE, canTransition, TASK_MACHINE, transition } from '@mec/domain'
import { type FollowUps, failLaunch } from '@mec/meta'
import type { AttemptFacts, CheckOutcome, ParkedState } from '@mec/runtime'

type AttemptEvent = (typeof ATTEMPT_MACHINE)[number]['event']
type TaskEvent = (typeof TASK_MACHINE)[number]['event']

const PARK_EVENT: Readonly<Record<ParkedState, AttemptEvent>> = {
  quota_wait: 'quota_exhausted',
  auth_required: 'auth_expired',
  provider_down: 'provider_unreachable',
}

/** The id of one check result, and of one report: `store.engines` is the catch-all. */
export const checkDocId = (attemptId: string, name: string): string => `check/${attemptId}/${name}`
export const reportDocId = (attemptId: string, n: number): string => `report/${attemptId}/${n}`

export type Cleaner = <T>(attemptId: string, value: T) => T

/** Where a fact goes past the store: reports and reads to follow-ups, and a nudge for a pass. */
export type FactsListener = {
  followups?: Pick<FollowUps, 'onReport' | 'inputsRead' | 'openQuestion'>
  /** A fact a scheduler pass should see now, not at the next tick (§11). After the commit. */
  changed?: () => void
  /** §5.10 Inform: in the park's own transaction. */
  parked?: (
    doc: StoreDoc,
    state: ParkedState,
    reason: string,
    resetsAt: string | undefined,
    at: string,
  ) => void
}

export class StoreFacts implements AttemptFacts {
  readonly #store: Store
  readonly #clean: Cleaner
  readonly #now: () => string
  readonly #listener: FactsListener

  /** `clean` redacts for one attempt: anything an agent wrote passes it before a write. */
  constructor(
    store: Store,
    clean: Cleaner,
    now: () => string = () => new Date().toISOString(),
    listener: FactsListener = {},
  ) {
    this.#store = store
    this.#clean = clean
    this.#now = now
    this.#listener = listener
  }

  #changed(): void {
    const { changed } = this.#listener
    if (changed !== undefined) this.#store.afterCommit(changed)
  }

  atomic<T>(fn: () => T): T {
    return this.#store.atomic(fn)
  }

  engineEvent(attempt: AttemptRef, event: EngineEvent): void {
    this.#append(attempt.attempt_id, event.type, event as unknown as Json, event.at)
  }

  attemptStarted(attempt: AttemptRef, generation: Generation, session_id: string | undefined): void {
    const doc = this.#current(attempt)
    if (doc === undefined || generation !== attempt.generation) return
    const session: StoreDoc = session_id !== undefined ? { session_id } : {}
    if (this.#move(doc, 'agent_started', session)) this.#moveTask(doc, 'attempt_started')
    // A resumed attempt is running already, and the session it continues may have a new id.
    else if (doc.state === 'running')
      this.#store.attempts.save({ ...doc, ...session, updatedAt: this.#now() })
  }

  inputsDelivered(attempt: AttemptRef, input_ids: InputId[]): void {
    this.#note(attempt, 'attempt.inputs_delivered', { input_ids })
  }

  inputsRead(attempt: AttemptRef, input_ids: InputId[]): void {
    const { followups } = this.#listener
    if (followups !== undefined) followups.inputsRead(attempt.attempt_id, input_ids)
    else this.#note(attempt, 'attempt.inputs_read', { input_ids })
  }

  turnEnded(attempt: AttemptRef, generation: Generation): void {
    this.#note(attempt, 'attempt.turn_ended', { generation })
  }

  /**
   * A report's `head_sha` is the agent's claim (§10): `observedHead`, read from the worktree,
   * is stored beside it, so nothing downstream has to trust it.
   */
  reportReceived(attempt: AttemptRef, generation: Generation, report: Report, observedHead?: string): number {
    const attemptId = attempt.attempt_id
    const doc = this.#store.attempts.get(attemptId)
    const n = (typeof doc?.reports === 'number' ? doc.reports : 0) + 1
    const at = this.#now()
    const clean = this.#clean(attemptId, report)
    this.#store.engines.save({
      id: reportDocId(attemptId, n),
      attemptId,
      generation,
      n,
      report: clean as unknown as Json,
      ...(observedHead !== undefined && { observed_head: observedHead }),
      ...(report.head_sha !== undefined &&
        observedHead !== undefined && { head_matches: report.head_sha === observedHead }),
      at,
      updatedAt: at,
    })
    if (doc !== undefined) this.#store.attempts.save({ ...doc, reports: n, updatedAt: at })
    this.#note(attempt, 'attempt.report', { n, kind: clean.kind, summary: clean.summary })
    // §6: the wake or note commits with the report it came from.
    const current = this.#store.attempts.get(attemptId)
    if (current !== undefined) this.#listener.followups?.onReport(current, clean, n, at)
    this.#changed()
    return n
  }

  /** §12.6: `ask_user` is a question with no report around it. */
  questionAsked(
    attempt: AttemptRef,
    question: Question,
  ): { questionId: string; reused: boolean; answer?: string } {
    const doc = this.#store.attempts.get(attempt.attempt_id)
    const followups = this.#listener.followups
    if (doc === undefined || followups === undefined) throw new Error('mec-tools: questions are not wired')
    return followups.openQuestion(doc, this.#clean(attempt.attempt_id, question), this.#now())
  }

  permissionRequested(attempt: AttemptRef, request_id: string, operation: Operation): void {
    this.#note(attempt, 'attempt.permission_requested', {
      request_id,
      operation: this.#clean(attempt.attempt_id, operation) as unknown as Json,
    })
  }

  rateLimitObserved(attempt: AttemptRef, slot: SlotId, reading: UsageReading): void {
    const stream = `slot:${slot}`
    const body = { attemptId: attempt.attempt_id, ...reading } as unknown as Json
    const doc = this.#store.slots.get(slot)
    if (doc !== undefined && reading.utilization !== undefined) {
      // §11: placement reads this against the ceiling. No reading stays no reading.
      const usage = { usageUtilization: reading.utilization, updatedAt: reading.observed_at }
      this.#store.slots.save({ ...doc, ...usage })
    }
    this.#store.events.append(stream, {
      stream,
      seq: (this.#store.events.read(stream).at(-1)?.seq ?? 0) + 1,
      at: reading.observed_at,
      type: 'rate_limit_observed',
      body,
    })
  }

  usageObserved(attempt: AttemptRef, usage: UsagePayload): void {
    const doc = this.#store.attempts.get(attempt.attempt_id)
    if (doc === undefined) return
    this.#store.attempts.save({ ...doc, usage: usage as unknown as Json, updatedAt: this.#now() })
  }

  attemptExited(attempt: AttemptRef, _generation: Generation, exit: ExitPayload): void {
    const doc = this.#store.attempts.get(attempt.attempt_id)
    if (doc === undefined) return
    this.#store.attempts.save({
      ...doc,
      exit_code: exit.code,
      exit_reason: exit.terminal_reason,
      updatedAt: this.#now(),
    })
  }

  deliveryFailed(attempt: AttemptRef, input_ids: InputId[], error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error)
    this.#note(attempt, 'attempt.delivery_failed', {
      input_ids,
      error: this.#clean(attempt.attempt_id, detail),
    })
  }

  slotChanged(slot: Slot): void {
    this.#store.slots.save(slot as unknown as StoreDoc)
    this.#changed()
  }

  workCompleted(attempt: AttemptRef, head: string): void {
    const doc = this.#current(attempt)
    if (doc === undefined) return
    if (this.#move(doc, 'agent_finished', { head_sha: head })) this.#moveTask(doc, 'work_complete')
  }

  checksFinished(attempt: AttemptRef, head: string, outcomes: CheckOutcome[], passed: boolean): void {
    const attemptId = attempt.attempt_id
    const at = this.#now()
    for (const outcome of outcomes) {
      this.#store.engines.save({
        id: checkDocId(attemptId, outcome.name),
        attemptId,
        name: outcome.name,
        status: outcome.status,
        exit_code: outcome.exitCode,
        duration_ms: outcome.durationMs,
        log_tail: outcome.logTail,
        sha: head,
        at,
        updatedAt: at,
      })
    }
    const doc = this.#current(attempt)
    if (doc === undefined) return
    const names = outcomes.map((outcome) => outcome.name)
    this.#move(doc, passed ? 'checks_passed' : 'checks_failed', { head_sha: head, checks: names })
    this.#changed()
  }

  checksSkipped(attempt: AttemptRef, head: string, reason: string, stopped?: string): void {
    const doc = this.#current(attempt)
    if (doc !== undefined) {
      this.#store.attempts.save({
        ...doc,
        checks_note: reason,
        ...(stopped !== undefined && { checks_stopped: stopped }),
        updatedAt: this.#now(),
      })
    }
    this.#note(attempt, 'attempt.checks_skipped', { head_sha: head, reason })
  }

  attemptParked(attempt: AttemptRef, state: ParkedState, reason: string, resetsAt?: string): void {
    const doc = this.#current(attempt)
    if (doc === undefined) return
    const at = this.#now()
    const parked = { state, reason, at, ...(resetsAt !== undefined && { resets_at: resetsAt }) }
    if (!this.#move(doc, PARK_EVENT[state], { terminal_reason: reason, parked })) return
    this.#note(attempt, 'attempt.parked', parked)
    this.#listener.parked?.(doc, state, reason, resetsAt, at)
    this.#changed()
  }

  stopFailed(attempt: AttemptRef, detail: string): void {
    const doc = this.#store.attempts.get(attempt.attempt_id)
    if (doc !== undefined) {
      this.#store.attempts.save({ ...doc, stop_failed: detail, updatedAt: this.#now() })
    }
    this.#note(attempt, 'attempt.stop_failed', { detail })
  }

  attemptStalled(attempt: AttemptRef): void {
    const doc = this.#current(attempt)
    if (doc !== undefined && this.#move(doc, 'stall_detected', {})) {
      this.#note(attempt, 'attempt.stalled', { attemptId: attempt.attempt_id })
    }
  }

  journalled(attemptId: string): ReadonlySet<string> {
    const held = new Set<string>()
    for (const { body } of this.#store.events.read(`attempt:${attemptId}`)) {
      const { generation, seq } = (body ?? {}) as { generation?: unknown; seq?: unknown }
      if (typeof seq === 'number') held.add(`${String(generation)} ${seq}`)
    }
    return held
  }

  attemptInterrupted(attempt: AttemptRef, reason: string): void {
    const doc = this.#current(attempt)
    if (doc === undefined) return
    if (this.#move(doc, 'interrupt_confirmed', { terminal_reason: reason })) {
      this.#note(attempt, 'attempt.interrupted', { attemptId: attempt.attempt_id, reason })
    }
  }

  /** The one way an attempt fails (§17, decision #26): on launch and after it alike. */
  attemptFailed(attempt: AttemptRef, reason: string): void {
    const doc = this.#current(attempt)
    if (doc === undefined) return
    const payload = {
      attempt_id: attempt.attempt_id,
      task_id: String(doc.taskId),
      work_item_id: String(doc.workItemId),
    }
    failLaunch(this.#store, payload, reason, this.#now())
    this.#moveTask(doc, 'attempt_failed')
    this.#changed()
  }

  /** The attempt this fact speaks for; an older generation's fact moves nothing. */
  #current(attempt: AttemptRef): StoreDoc | undefined {
    const doc = this.#store.attempts.get(attempt.attempt_id)
    if (doc === undefined) return undefined
    return doc.generation === undefined || doc.generation === attempt.generation ? doc : undefined
  }

  #move(doc: StoreDoc, event: AttemptEvent, fields: StoreDoc): boolean {
    const state = String(doc.state)
    if (!canTransition(ATTEMPT_MACHINE, state, event)) return false
    this.#store.attempts.save({
      ...doc,
      ...fields,
      state: transition(ATTEMPT_MACHINE, state, event),
      updatedAt: this.#now(),
    })
    return true
  }

  #moveTask(attempt: StoreDoc, event: TaskEvent): void {
    const task = this.#store.tasks.get(String(attempt.taskId))
    if (task === undefined) return
    const status = String(task.status)
    if (!canTransition(TASK_MACHINE, status, event)) return
    this.#store.tasks.save({
      ...task,
      status: transition(TASK_MACHINE, status, event),
      updatedAt: this.#now(),
    })
  }

  #note(attempt: AttemptRef, type: string, body: Record<string, Json | undefined>): void {
    this.#append(attempt.attempt_id, type, { generation: attempt.generation, ...body } as Json, this.#now())
  }

  #append(attemptId: string, type: string, body: Json, at: IsoTime): void {
    const stream = `attempt:${attemptId}`
    const seq = (this.#store.events.read(stream).at(-1)?.seq ?? 0) + 1
    this.#store.events.append(stream, { stream, seq, at, type, body })
  }
}
