/**
 * Follow-ups, reports, questions and specialist cards (spec §6, §10, §12.3, §12.4, §12.6, §13).
 * Everything here is store state, so an instance holds nothing a restart would lose.
 *
 * - **Ownership.** A message routed to live work is delivered to the attempt that owns it,
 *   unchanged. While owned, the meta agent may only stop: `guardTurn` strips the rest. The
 *   attempt handles it or hands it back once, and a message left over when its attempt ends is
 *   released to the meta agent with the reason.
 * - **Receipts.** The stage lives on the message doc; `ReceiptLadder` is hydrated per message and
 *   written through. `delivered` waits for the engine to take the input, `read` for the end of the
 *   turn that carried it or a report naming it. Nothing is inferred from a transport write.
 * - **Reports.** `classifyWake` decides: a wake is enqueued in the report's own transaction, and a
 *   note is stored for the next turn's context.
 * - **Questions.** One open card per attempt, in the specialist's words. The answer goes back to
 *   the attempt through `deliver`, and the planner gets a note (decision #36).
 * - **Cards.** A specialist opens one; only a person resolves it. No tool here can.
 */
import { createHash } from 'node:crypto'
import type { AttemptRef, Effects, Input, Json, Report, Store, StoreDoc } from '@mec/contracts'
import { Later } from '@mec/contracts'
import { ATTEMPT_TERMINAL, type AttemptState, ReceiptLadder, type ReceiptStage } from '@mec/domain'
import { redact } from '../../slots/src/redaction'
import { isHeld, isTerminal, mandateOf } from './authority'
import { handBack } from './handback'
import type { MetaDecision, WakeRequest } from './service'
import { classifyWake } from './wakes'

/** What delivery needs of the runtime: the contract's `deliver`, which resolves once it was taken. */
export type DeliveryRuntime = { deliver(attempt: AttemptRef, input: Input): Promise<void> }

export type FollowUpsDeps = {
  store: Store
  effects: Effects
  now?: () => string
  /** Absent means no runner can deliver, and a message says so instead of waiting. */
  runtime?: () => DeliveryRuntime | undefined
}

type Question = NonNullable<Report['question']>

/** One stored receipt; a message with none is at `received`. */
type StoredReceipt = { stage: ReceiptStage; at: string }

const DIGEST_CHARS = 24
const digest = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, DIGEST_CHARS)

const STAGES: readonly ReceiptStage[] = ['received', 'delivered', 'read', 'handled', 'settled']

const stageOf = (doc: StoreDoc): ReceiptStage =>
  (doc.receipt as StoredReceipt | undefined)?.stage ?? 'received'

const reached = (doc: StoreDoc, stage: ReceiptStage): boolean =>
  STAGES.indexOf(stageOf(doc)) >= STAGES.indexOf(stage)

const isLive = (attempt: StoreDoc | undefined): boolean =>
  attempt?.state === 'running' || attempt?.state === 'queued'

const isEnded = (attempt: StoreDoc | undefined): boolean =>
  attempt === undefined || ATTEMPT_TERMINAL.includes(String(attempt.state) as AttemptState)

/** Wake keys are their cause, and a turn's message id derives from it (§6). */
export function enqueueWake(effects: Effects, wake: WakeRequest & { settles?: string }): void {
  const { causationId, reason, detail, workItemId, settles } = wake
  effects.enqueue('relay', `wake:${causationId}`, {
    causationId,
    reason,
    ...(detail !== undefined && { detail }),
    ...(workItemId !== undefined && { workItemId }),
    ...(settles !== undefined && { settles }),
  })
}

export class FollowUps {
  readonly #store: Store
  readonly #effects: Effects
  readonly #now: () => string
  readonly #runtime?: () => DeliveryRuntime | undefined

  constructor(deps: FollowUpsDeps) {
    this.#store = deps.store
    this.#effects = deps.effects
    this.#now = deps.now ?? (() => new Date().toISOString())
    this.#runtime = deps.runtime
  }

  // ── Ownership ──────────────────────────────────────────────────────────────────────────────

  /** The attempt a message on this work reaches: the latest running one, else the latest queued. */
  ownerOf(workItemId: string, except?: string): StoreDoc | undefined {
    const live = this.#store.attempts
      .list({ workItemId })
      .filter((doc) => isLive(doc) && doc.id !== except)
      .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
    return live.filter((doc) => doc.state === 'running').at(-1) ?? live.at(-1)
  }

  /**
   * Hands a message to its owner, inside the caller's transaction. With no owner it goes to the
   * meta agent: a person's message always gets a turn (§6). Returns the owner.
   */
  attach(messageId: string, workItemId: string, at: string): string | undefined {
    const owner = this.ownerOf(workItemId)
    if (owner !== undefined) {
      this.#assign(messageId, owner, at)
      return String(owner.id)
    }
    const doc = this.#store.messages.get(messageId)
    enqueueWake(this.#effects, {
      causationId: `message:${messageId}`,
      reason: 'follow-up with no running work',
      detail: String(doc?.text ?? ''),
      workItemId,
    })
    return undefined
  }

  #assign(messageId: string, owner: StoreDoc, at: string): void {
    const doc = this.#store.messages.get(messageId) as StoreDoc
    const attemptId = String(owner.id)
    const inputId = `inp_${digest(`${messageId}:${attemptId}`)}`
    this.#store.messages.save({
      ...doc,
      owned: true,
      ownerAttemptId: attemptId,
      inputId,
      receipt: doc.receipt ?? { stage: 'received', at },
      updatedAt: at,
    })
    const input: Input = { id: inputId, kind: 'message', text: String(doc.text), message_id: messageId }
    this.#enqueueDeliver(owner, input)
  }

  #enqueueDeliver(attempt: StoreDoc, input: Input): void {
    const attemptId = String(attempt.id)
    this.#effects.enqueue('deliver', `deliver:${attemptId}:${input.id}`, {
      attempt_id: attemptId,
      generation: Number(attempt.generation ?? 1),
      input: input as unknown as Json,
    })
  }

  #owned(): StoreDoc[] {
    return this.#store.messages.list({ owned: true })
  }

  /** §12.3: while a follow-up is owned the planner may not replan, spawn or reroute around it. */
  guardTurn(decision: MetaDecision, workItemId: string, at: string): MetaDecision {
    const owned = this.#owned()
    const ids = new Set(owned.map((doc) => String(doc.id)))
    const refused = (decision.routes ?? []).filter(
      (route) => ids.has(route.messageId) && route.decision !== 'stop',
    )
    const onThisWork = owned.some((doc) => doc.workItemId === workItemId)
    const { plan, spawns, ...rest } = decision
    const replanned = onThisWork && (plan !== undefined || (spawns?.length ?? 0) > 0)
    if (refused.length === 0 && !replanned) return decision
    this.#event(`work:${workItemId}`, 'route_refused', {
      workItemId,
      reason: 'a specialist owns this follow-up',
      messages: refused.map((route) => route.messageId),
      replan: replanned,
      at,
    })
    return {
      ...rest,
      ...(!onThisWork && plan !== undefined && { plan }),
      ...(!onThisWork && spawns !== undefined && { spawns }),
      routes: (decision.routes ?? []).filter((route) => !refused.includes(route)),
    }
  }

  /** §12.3: a handed-back message goes elsewhere, never to the attempt that gave it back. */
  reroute(messageId: string, workItemId: string, at: string): boolean {
    const doc = this.#store.messages.get(messageId)
    const handback = doc?.handback as { attemptId?: string } | undefined
    if (doc === undefined || handback === undefined || doc.owned === true) return false
    const owner = this.ownerOf(workItemId, handback.attemptId)
    if (owner === undefined) {
      this.#event(`work:${workItemId}`, 'reroute_refused', { messageId, workItemId, at })
      return false
    }
    this.#assign(messageId, owner, at)
    return true
  }

  /** What a pass owes owned messages: ended attempts settle or release theirs. */
  sweep(at: string): void {
    for (const doc of this.#owned()) {
      const attempt = this.#store.attempts.get(String(doc.ownerAttemptId))
      const work = this.#store.workItems.get(String(doc.workItemId))
      const workOver = work === undefined || isTerminal(work)
      if (!workOver && !isEnded(attempt) && attempt?.state !== 'interrupted') continue
      if (reached(doc, 'handled')) {
        this.#move(doc, 'settled', at, { owned: false })
        continue
      }
      this.#release(doc, 'its attempt ended before it handled the message', at)
    }
  }

  /** §12.3: released, with the reason. Ended work gets no turn: a wake never creates work. */
  #release(doc: StoreDoc, reason: string, at: string): void {
    const messageId = String(doc.id)
    const workItemId = String(doc.workItemId)
    this.#store.messages.save({ ...doc, owned: false, released: { reason, at }, updatedAt: at })
    this.#event(`work:${workItemId}`, 'message_released', { messageId, workItemId, reason, at })
    const work = this.#store.workItems.get(workItemId)
    if (work === undefined || isTerminal(work) || mandateOf(work).status === 'withdrawn') {
      this.#saveNote(
        workItemId,
        `released:${messageId}`,
        `Message released (${reason}): ${String(doc.text)}`,
        at,
      )
      return
    }
    enqueueWake(this.#effects, {
      causationId: `released:${messageId}`,
      reason: 'message released',
      detail: `${reason}: ${String(doc.text)}`,
      workItemId,
    })
  }

  /** Whether a follow-up could go now and has not: it goes before any launch (§11). */
  deliveryWaiting(): boolean {
    return this.#owned().some((doc) => {
      if (stageOf(doc) !== 'received') return false
      const work = this.#store.workItems.get(String(doc.workItemId))
      const attempt = this.#store.attempts.get(String(doc.ownerAttemptId))
      return work !== undefined && !isHeld(work) && attempt?.state === 'running'
    })
  }

  // ── Delivery and receipts ─────────────────────────────────────────────────────────────────

  /** The `deliver` handler. A throw of `Later` keeps the row; anything else settles the message. */
  async runDeliver(payload: Json): Promise<void> {
    const fields = (payload ?? {}) as { attempt_id?: string; generation?: number; input?: Input }
    const { attempt_id: attemptId, input } = fields
    if (typeof attemptId !== 'string' || input === undefined) throw new Error('deliver: bad payload')
    const attempt = this.#store.attempts.get(attemptId)
    const message = this.#store.messages.get(input.message_id ?? '')
    // Released, or handed back and routed on, while this row waited: it is no longer this attempt's.
    if (message !== undefined && (message.owned !== true || message.ownerAttemptId !== attemptId)) return
    const delivered = message?.delivered_inputs as string[] | undefined
    // A row replayed after a crash: the engine has this copy.
    if (delivered?.includes(input.id) === true) return
    if (attempt?.state === 'queued') throw new Later(`${attemptId} has not started`)
    const work = this.#store.workItems.get(String(attempt?.workItemId))
    // Decision #28: a held item's running turn receives no new input.
    if (work !== undefined && isHeld(work)) throw new Later(`${String(work.id)} is held`)
    const runtime = this.#runtime?.()
    if (attempt === undefined || runtime === undefined) {
      this.#failed(attemptId, input, 'no runner can reach this attempt')
      return
    }
    const ref = { attempt_id: attemptId, generation: Number(fields.generation ?? 1) }
    try {
      await runtime.deliver(ref, input)
    } catch (error) {
      if (error instanceof Later) throw error
      this.#failed(attemptId, input, error instanceof Error ? error.message : String(error))
      return
    }
    this.#store.atomic(() => this.#delivered(attemptId, input))
  }

  #delivered(attemptId: string, input: Input): void {
    const at = this.#now()
    this.#event(`attempt:${attemptId}`, 'attempt.inputs_delivered', { input_ids: [input.id], at })
    const doc = this.#store.messages.get(input.message_id ?? '')
    if (doc === undefined) return
    const inputs = (doc.delivered_inputs as string[] | undefined) ?? []
    const fields = { delivered_inputs: [...inputs, input.id] }
    if (stageOf(doc) !== 'received') {
      this.#store.messages.save({ ...doc, ...fields, updatedAt: at })
      return
    }
    this.#move(doc, 'delivered', at, fields)
    // A short turn can end before this commit: the read waited for it.
    const moved = this.#store.messages.get(String(doc.id)) as StoreDoc
    if (moved.turn_ended === input.id) this.#move(moved, 'read', at)
  }

  /** §15: an engine with no proven input, or an attempt gone: said, released, no receipt. */
  #failed(attemptId: string, input: Input, detail: string): void {
    const at = this.#now()
    const reason = redact(detail, [], [])
    this.#store.atomic(() => {
      this.#event(`attempt:${attemptId}`, 'attempt.delivery_failed', {
        input_ids: [input.id],
        error: reason,
        at,
      })
      const doc = this.#store.messages.get(input.message_id ?? '')
      if (doc?.owned === true) this.#release(doc, `delivery failed: ${reason}`, at)
      const workItemId = this.#store.attempts.get(attemptId)?.workItemId
      // An answer has no message to release, and it must not vanish either.
      if (input.message_id === undefined && input.kind === 'message' && typeof workItemId === 'string') {
        enqueueWake(this.#effects, {
          causationId: `undelivered:${input.id}`,
          reason: 'answer not delivered',
          detail: `${reason}: ${input.text}`,
          workItemId,
        })
      }
    })
  }

  /** The engine finished the turn that carried these inputs (§12.4). */
  inputsRead(attemptId: string, inputIds: readonly string[]): void {
    const at = this.#now()
    for (const doc of this.#owned()) {
      if (doc.ownerAttemptId !== attemptId || !inputIds.includes(String(doc.inputId))) continue
      if (stageOf(doc) === 'delivered') this.#move(doc, 'read', at)
      else if (stageOf(doc) === 'received') {
        this.#store.messages.save({ ...doc, turn_ended: doc.inputId as string, updatedAt: at })
      }
    }
    this.#event(`attempt:${attemptId}`, 'attempt.inputs_read', { input_ids: [...inputIds], at })
  }

  /** The ladder, hydrated for one message and written through. */
  #move(doc: StoreDoc, to: ReceiptStage, at: string, fields: StoreDoc = {}): void {
    const messageId = String(doc.id)
    const ladder = new ReceiptLadder()
    ladder.forceStage(messageId, stageOf(doc), at)
    if (to === 'read') ladder.markTurnEnd(at)
    else ladder.advance(messageId, to, at)
    const stage = ladder.stageOf(messageId) as ReceiptStage
    this.#store.messages.save({ ...doc, ...fields, receipt: { stage, at }, updatedAt: at })
    this.#event(`message:${messageId}`, 'receipt_advanced', { messageId, stage, at })
  }

  /** A handled message whose rerouting was recorded (§12.4). */
  settle(messageId: string): void {
    const at = this.#now()
    this.#store.atomic(() => {
      const doc = this.#store.messages.get(messageId)
      if (doc !== undefined && stageOf(doc) === 'handled') this.#move(doc, 'settled', at)
    })
  }

  // ── Reports and handbacks ─────────────────────────────────────────────────────────────────

  /** Inside the transaction that stored report `n`; `report` is already redacted. */
  onReport(attempt: StoreDoc, report: Report, n: number, at: string): void {
    const attemptId = String(attempt.id)
    const workItemId = String(attempt.workItemId)
    for (const inputId of report.handled_inputs ?? []) this.#handled(attemptId, inputId, at)
    if (report.handback !== undefined) {
      this.handback(attempt, report.handback.message_id, report.handback.reason, at)
    }
    if (report.question === null) this.#closeQuestions(attemptId, 'cleared', at)
    else if (report.question !== undefined) this.openQuestion(attempt, report.question, at)
    if (report.kind === 'ready') this.#closeQuestions(attemptId, 'closed', at)

    const event = { kind: 'report' as const, workItemId, reportKind: report.kind }
    if (classifyWake(event) === 'wake') {
      enqueueWake(this.#effects, {
        causationId: `report/${attemptId}/${n}`,
        reason: `report ${report.kind}`,
        detail: report.summary,
        workItemId,
      })
      return
    }
    this.#effects.enqueue('note', `note:report/${attemptId}/${n}`, {
      workItemId,
      cause: `report/${attemptId}/${n}`,
      text: `${attemptId} ${report.kind}: ${report.summary}`,
      at,
    })
  }

  #handled(attemptId: string, inputId: string, at: string): void {
    const doc = this.#owned().find((row) => row.inputId === inputId && row.ownerAttemptId === attemptId)
    if (doc === undefined) return
    if (stageOf(doc) === 'delivered') this.#move(doc, 'read', at)
    const fresh = this.#store.messages.get(String(doc.id)) as StoreDoc
    if (stageOf(fresh) === 'read') this.#move(fresh, 'handled', at)
  }

  /** §12.3: once, with a reason, and the meta agent routes it elsewhere. */
  handback(
    attempt: StoreDoc,
    messageId: string,
    reason: string,
    at: string,
  ): { ok: true } | { ok: false; reason: string } {
    const doc = this.#store.messages.get(messageId)
    const attemptId = String(attempt.id)
    if (doc === undefined || doc.ownerAttemptId !== attemptId) return { ok: false, reason: 'not owned' }
    const given = handBack({
      messageId,
      reason,
      alreadyHandedBack: doc.handback === undefined ? [] : [messageId],
      ticketLive: doc.owned === true && isLive(attempt),
    })
    if (given.action === 'refuse') return { ok: false, reason: given.reason ?? 'refused' }
    const handback = { attemptId, reason, at }
    if (stageOf(doc) === 'received') {
      this.#store.messages.save({ ...doc, owned: false, handback, updatedAt: at })
    } else {
      if (stageOf(doc) === 'delivered') this.#move(doc, 'read', at)
      const fresh = this.#store.messages.get(messageId) as StoreDoc
      if (stageOf(fresh) === 'read') this.#move(fresh, 'handled', at, { owned: false, handback })
    }
    enqueueWake(this.#effects, {
      causationId: `handback:${messageId}`,
      reason: 'follow-up handed back',
      detail: `${reason}: ${String(doc.text)}`,
      workItemId: String(attempt.workItemId),
      settles: messageId,
    })
    return { ok: true }
  }

  // ── Notes ──────────────────────────────────────────────────────────────────────────────────

  /** The `note` handler. */
  async runNote(payload: Json): Promise<void> {
    const { workItemId, cause, text, at } = (payload ?? {}) as Record<string, string>
    this.#store.atomic(() => this.#saveNote(String(workItemId), String(cause), String(text), String(at)))
  }

  /** Read by the next turn's context; a note never wakes (§6). */
  #saveNote(workItemId: string, cause: string, text: string, at: string): void {
    const id = `note/${workItemId}/${digest(cause)}`
    this.#store.engines.save({ id, workItemId, text, at, updatedAt: at })
  }

  // ── Questions ──────────────────────────────────────────────────────────────────────────────

  #openQuestions(attemptId: string): StoreDoc[] {
    return this.#store.engines
      .list({ attemptId })
      .filter((doc) => String(doc.id).startsWith('question/') && doc.status === 'open')
  }

  #closeQuestions(attemptId: string, status: string, at: string): void {
    for (const doc of this.#openQuestions(attemptId)) {
      this.#store.engines.save({ ...doc, status, updatedAt: at })
      this.#event(String(doc.id), 'question_closed', { questionId: String(doc.questionId), status, at })
    }
  }

  /**
   * §10: the same text reuses the open card, different text replaces it, and a question already
   * answered stays answered: the same decision is never requested twice (§12.6). `text` is the
   * specialist's, unchanged but for redaction, which the caller has done.
   */
  openQuestion(
    attempt: StoreDoc,
    question: Question,
    at: string,
  ): { questionId: string; reused: boolean; answer?: string } {
    const attemptId = String(attempt.id)
    const workItemId = String(attempt.workItemId)
    const open = this.#openQuestions(attemptId)
    const same = open.find((doc) => doc.question === question.text)
    if (same !== undefined) return { questionId: String(same.questionId), reused: true }
    const questionId = question.id ?? `q_${digest(`${attemptId}:${question.text}`)}`
    const docId = `question/${questionId}`
    const existing = this.#store.engines.get(docId)
    if (existing?.status === 'answered') {
      return { questionId, reused: true, answer: String(existing.answer) }
    }
    this.#closeQuestions(attemptId, 'replaced', at)
    const revision = this.#store.workItems.get(workItemId)?.planRevision
    this.#store.engines.save({
      id: docId,
      questionId,
      question: question.text,
      options: question.options ?? [],
      attemptId,
      taskId: String(attempt.taskId),
      workItemId,
      ...(typeof revision === 'number' && { planRevision: revision }),
      ...(question.for_message_id !== undefined && { forMessageId: question.for_message_id }),
      ...(question.evidence_ref !== undefined && { evidenceRef: question.evidence_ref }),
      status: 'open',
      askedAt: at,
      createdAt: at,
      updatedAt: at,
    })
    this.#event(docId, 'question_asked', { questionId, question: question.text, workItemId, attemptId, at })
    if (classifyWake({ kind: 'question', workItemId }) === 'wake') {
      enqueueWake(this.#effects, {
        causationId: `asked:${questionId}`,
        reason: 'specialist question',
        detail: question.text,
        workItemId,
      })
    }
    return { questionId, reused: false }
  }

  /**
   * §12.6, decision #36: a specialist's answer goes to the attempt that asked, inside the
   * caller's transaction. The planner gets a note, not a turn. An attempt that ended can no longer
   * take it, so then the planner does get the turn, told which revision it was asked under.
   */
  answerSpecialist(doc: StoreDoc, answer: string, at: string): void {
    const attempt = this.#store.attempts.get(String(doc.attemptId))
    const workItemId = String(doc.workItemId)
    const question = String(doc.question ?? '')
    if (attempt === undefined || !isLive(attempt)) {
      const revision = typeof doc.planRevision === 'number' ? ` (plan revision ${doc.planRevision})` : ''
      enqueueWake(this.#effects, {
        causationId: String(doc.id),
        reason: 'question answered',
        detail: `question "${question}"${revision} answered: ${answer}`,
        workItemId,
      })
      return
    }
    const inputId = `inp_${digest(String(doc.id))}`
    this.#enqueueDeliver(attempt, {
      id: inputId,
      kind: 'message',
      text: `Answer to your question "${question}":\n${answer}`,
    })
    this.#saveNote(workItemId, `answered:${String(doc.id)}`, `Answered "${question}": ${answer}`, at)
  }

  // ── Cards ──────────────────────────────────────────────────────────────────────────────────

  /**
   * A card a specialist asked for (§13), redacted by the caller. The same operation on the same
   * attempt is the same card: an engine that re-asks does not double it, and a settled answer
   * stands, because the same decision is never requested twice (§12.6). Only an expired or stale
   * card makes way for a new one.
   */
  openCard(attempt: StoreDoc, card: SpecialistCard, at: string): StoreDoc {
    const attemptId = String(attempt.id)
    const operationHash = createHash('sha256').update(JSON.stringify(card.operation), 'utf8').digest('hex')
    const prior = this.#store.confirmations
      .list({ attemptId, operationHash })
      .filter((doc) => doc.status !== 'expired' && doc.status !== 'stale')
      .at(-1)
    if (prior !== undefined) return prior
    const seed = `${attemptId}:${operationHash}:${this.#store.confirmations.list({ attemptId }).length}`
    const workItemId = String(attempt.workItemId)
    const work = this.#store.workItems.get(workItemId)
    const doc: StoreDoc = {
      id: `conf_${digest(seed)}`,
      cls: card.cls,
      operationHash,
      status: 'pending',
      createdAt: at,
      expiresAt: card.expiresAt,
      attemptId,
      workItemId,
      ...(work !== undefined && { mandateId: mandateOf(work).id }),
      requestedBy: 'specialist',
      ...(card.notify && { notify: true }),
      payload: { operation: card.operation, evidence: card.evidence } as Json,
    }
    this.#store.confirmations.save(doc)
    this.#event(`work:${workItemId}`, 'confirmation_requested', {
      confirmationId: String(doc.id),
      cls: card.cls,
      workItemId,
      attemptId,
      at,
    })
    return doc
  }

  #event(stream: string, type: string, body: Record<string, Json | undefined>): void {
    const seq = (this.#store.events.read(stream).at(-1)?.seq ?? 0) + 1
    const at = String(body.at ?? this.#now())
    this.#store.events.append(stream, { stream, seq, at, type, body: body as Json })
  }
}

/** What a specialist's card states; `notify` delivers the outcome to an attempt not waiting on it. */
export type SpecialistCard = {
  cls: string
  operation: Record<string, Json>
  evidence: Record<string, Json>
  expiresAt: string
  notify: boolean
}

/**
 * What a person's answer on a card does for the agent that asked, in the transaction that settles
 * it. Returns whether that agent carries on because of this answer: the toast says so, and a card
 * a planner opened, or one whose attempt has gone, runs nothing.
 */
export function settleSpecialistCard(store: Store, effects: Effects, doc: StoreDoc): boolean {
  if (typeof doc.attemptId !== 'string') return false
  const attempt = store.attempts.get(doc.attemptId)
  if (attempt?.state !== 'running') return false
  if (doc.notify === true) {
    const input: Input = {
      id: `inp_${digest(`card:${String(doc.id)}`)}`,
      kind: 'note',
      text: `Your confirmation request ${String(doc.id)} was ${String(doc.status)}.`,
    }
    effects.enqueue('deliver', `deliver:${doc.attemptId}:${input.id}`, {
      attempt_id: doc.attemptId,
      generation: Number(attempt.generation ?? 1),
      input: input as unknown as Json,
    })
  }
  return doc.status === 'approved'
}

/** Unread notes for a work item, oldest first. */
export function unreadNotes(store: Store, workItem: StoreDoc): { at: string; text: string }[] {
  const seen = typeof workItem.notesSeenAt === 'string' ? workItem.notesSeenAt : ''
  return store.engines
    .list({ workItemId: workItem.id })
    .filter((doc) => String(doc.id).startsWith('note/') && String(doc.at) > seen)
    .map((doc) => ({ at: String(doc.at), text: String(doc.text) }))
    .sort((a, b) => a.at.localeCompare(b.at))
}
