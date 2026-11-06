/**
 * Moving parked work to another slot (spec §5.10, §13). A switch is confirm-by-default: a
 * `slot_switch` card, unless policy pre-authorises it, and that use is recorded. `planFailover` says
 * what may move, so an auth park never does. The target is probed again when the switch happens.
 *
 * What moves is a new attempt on the same worktree with a handoff pack. It carries no session id:
 * sessions are never resumed across slots or engines. The parked attempt stays on the record with
 * `switched_to`, which keeps it from also resuming, and one already resuming cannot also switch.
 *
 * An approval lands through the inbox's own door; a pass applies it, so a crash between the two is
 * only a late switch, and `applied` on the card makes it one switch.
 */
import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Effects, Json, Store, StoreDoc } from '@mec/contracts'
import { type HandoffPlan, type ParkedAttempt, planFailover } from '@mec/failover'
import { git, worktreeAdminDir } from '@mec/git'
import { type Continuation, isHeld, mandateOf, revalidateWork } from '@mec/meta'
import { openConfirmation, type PolicyDoc, policyPreAuthorises } from '@mec/policy'
import { redact } from '@mec/slots'
import type { Cleaner } from './core-facts'
import { mayRun } from './recovery'
import type { CardBlock } from './release'

const CARD_TTL_MS = 24 * 60 * 60 * 1000
const PARKED = ['quota_wait', 'auth_required', 'provider_down']

export type SwitchDeps = {
  store: Store
  effects: Effects
  policy: PolicyDoc
  now: () => string
  /** Re-probes the target: true only if it answers healthy now. */
  probe: (slotId: string) => Promise<boolean>
  /** The attempt cleaner: patterns, key fingerprints and that attempt's own token. */
  clean: Cleaner
}

export type SwitchAnswer = { status: number; body: Record<string, Json> }

const refused = (error: string): SwitchAnswer => ({ status: 409, body: { error } })

const appendEvent = (store: Store, stream: string, type: string, body: Json, at: string): void => {
  const seq = (store.events.read(stream).at(-1)?.seq ?? 0) + 1
  store.events.append(stream, { stream, seq, at, type, body })
}

const isParked = (doc: StoreDoc): boolean =>
  PARKED.includes(String(doc.state)) && doc.switched_to === undefined && doc.resuming !== true

/** Every attempt that waits on a slot, and has not already moved off it or begun to resume. */
export const parkedAttempts = (store: Store): StoreDoc[] => store.attempts.list().filter(isParked)

function parkedOn(store: Store, workItemId: string): StoreDoc[] {
  return store.attempts.list({ workItemId }).filter(isParked)
}

const idsOf = (docs: readonly StoreDoc[]): string[] => docs.map((doc) => String(doc.id))

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

const shaped = (doc: StoreDoc): ParkedAttempt => ({
  attemptId: String(doc.id),
  taskId: String(doc.taskId),
  workItemId: String(doc.workItemId),
  slotId: String(doc.slotId),
  parkState: doc.state as ParkedAttempt['parkState'],
  generation: Number(doc.generation ?? 1),
  worktree: String(doc.worktree ?? ''),
  openQuestions: 0,
  holds: 0,
})

/** One decision per parked attempt. The caller's choice of target is what the pair stands for. */
function plansFor(store: Store, parked: readonly StoreDoc[], toSlot: string, at: string): HandoffPlan[] {
  const attempts = parked.map(shaped)
  return planFailover({
    parked: attempts,
    pairings: attempts.map((attempt) => ({ from: attempt.slotId, to: toSlot, auto: true })),
    healthySlots: store.slots.get(toSlot)?.state === 'healthy' ? [toSlot] : [],
    resetsKnown: {},
    now: at,
  })
}

/** A person's or a pair's words, cleaned for every attempt they will sit beside. */
const cleaned = (deps: SwitchDeps, parked: readonly StoreDoc[], reason: string): string =>
  parked.reduce((text, doc) => deps.clean(String(doc.id), text), redact(reason, [], []))

/** Why this work cannot move to this slot, or undefined when it can. */
function refusal(deps: SwitchDeps, workItemId: string, toSlot: string, at: string): string | undefined {
  const { store, policy } = deps
  const work = store.workItems.get(workItemId)
  if (work === undefined) return 'unknown_work'
  // The launch gate's order. Its drop leaves the queued attempt holding the target's capacity.
  const mandate = revalidateWork(work, at, policy.versionHash)
  if (!mayRun(work) || (!mandate.ok && mandate.reason !== 'policy_changed')) return 'work_ended'
  if (isHeld(work)) return 'held'
  if (!mandate.ok) return 'policy_changed'
  const parked = parkedOn(store, workItemId)
  if (parked.length === 0) return 'nothing_parked'
  if (parked.some((doc) => doc.state === 'auth_required')) return 'auth_park_never_switches'
  if (store.slots.get(toSlot)?.state !== 'healthy') return 'target_unhealthy'
  if (parked.some((doc) => doc.slotId === toSlot)) return 'same_slot'
  const plans = plansFor(store, parked, toSlot, at)
  return plans.every((plan) => plan.action === 'switch') ? undefined : 'not_switchable'
}

/** The route: refuses, runs on a pre-authorisation, or opens the card. */
export async function requestSwitch(
  deps: SwitchDeps,
  input: { workItemId: string; toSlot: string; reason: string },
): Promise<SwitchAnswer> {
  const { store, policy, now } = deps
  const { workItemId, toSlot } = input
  const at = now()
  const why = refusal(deps, workItemId, toSlot, at)
  if (why !== undefined) return refused(why)
  const parked = parkedOn(store, workItemId)
  const reason = cleaned(deps, parked, input.reason)
  const repoId = store.workItems.get(workItemId)?.repoId
  const scope = typeof repoId === 'string' ? { repoId } : {}
  if (policyPreAuthorises(policy, 'slot_switch', scope)) {
    store.atomic(() => {
      const body = { workItemId, toSlot, reason, at }
      appendEvent(store, `work:${workItemId}`, 'slot_switch_preauthorised', body, at)
    })
    const moved = await applySwitch(deps, { ...input, reason })
    return moved === undefined ? { status: 200, body: { status: 'switched' } } : refused(moved)
  }
  const fromSlots = [...new Set(parked.map((doc) => String(doc.slotId)))]
  const parkedAttempts = idsOf(parked)
  const operationHash = createHash('sha256')
    .update(JSON.stringify({ cls: 'slot_switch', workItemId, toSlot, fromSlots, parkedAttempts }), 'utf8')
    .digest('hex')
  const id = `conf_${randomBytes(9).toString('hex')}`
  const expiresAt = new Date(Date.parse(at) + CARD_TTL_MS).toISOString()
  const record = openConfirmation({ id, cls: 'slot_switch', operationHash, expiresAt })
  store.atomic(() => {
    store.confirmations.save({
      ...record,
      workItemId,
      requestedBy: 'owner',
      payload: {
        operation: { class: 'slot_switch', toSlot },
        evidence: {
          fromSlots: fromSlots.join(', '),
          parkedAttempts: parkedAttempts.join(', '),
          reason,
        },
        toSlot,
        parkedAttempts,
        reason,
      },
    } as unknown as StoreDoc)
    const body = { confirmationId: id, cls: 'slot_switch', workItemId, at }
    appendEvent(store, `work:${workItemId}`, 'confirmation_requested', body, at)
  })
  return { status: 202, body: { status: 'confirmation', confirmationId: id } }
}

/** A worktree whose `.git` a worker left where it found it, so host git may read it. */
export function worktreeIsOurs(worktree: string, gitDir: unknown): boolean {
  if (typeof gitDir !== 'string') return false
  try {
    return worktreeAdminDir(worktree) === join(realpathSync(gitDir), 'worktrees', basename(worktree))
  } catch {
    return false
  }
}

/** §10, §12, as for a push or PR card: a stop withdraws a switch card and a hold keeps it waiting. */
export function switchCardBlocked(store: Store, card: StoreDoc): CardBlock | undefined {
  const work = store.workItems.get(String(card.workItemId))
  if (work === undefined) return undefined
  if (mandateOf(work).status === 'withdrawn') return { reason: 'mandate_withdrawn', withdraw: true }
  return isHeld(work) ? { reason: 'held', withdraw: false } : undefined
}

/** The answer to a card `switchCardBlocked` withdrew: nothing is owed, and the record says why. */
export function withdrawSwitchCard(store: Store, settled: StoreDoc, reason: string, at: string): void {
  const stream = `work:${String(settled.workItemId)}`
  store.confirmations.save({ ...settled, applied: true })
  appendEvent(store, stream, 'card_withdrawn', { confirmationId: String(settled.id), reason, at }, at)
  const toSlot = String((settled.payload as { toSlot?: unknown } | undefined)?.toSlot)
  const body = { workItemId: String(settled.workItemId), toSlot, reason, at }
  appendEvent(store, stream, 'slot_switch_refused', body, at)
}

/** §5.10's engine-neutral pack: plan, diff so far, what was last said, open questions, holds. */
async function packFor(deps: SwitchDeps, parked: StoreDoc): Promise<Record<string, Json>> {
  const { store } = deps
  const clean = (text: string): string => deps.clean(String(parked.id), redact(text, [], []))
  const workItemId = String(parked.workItemId)
  const worktree = String(parked.worktree ?? '')
  const work = store.workItems.get(workItemId)
  const plan = store.tasks.list({ workItemId }).map((task) => ({
    task: String(task.id),
    status: String(task.status),
    objective: clean(String(task.objective ?? '')),
  }))
  let diffSoFar = 'unavailable'
  if (worktreeIsOurs(worktree, work?.git_dir)) {
    const read = await git(['diff', '--stat', 'HEAD'], { cwd: worktree, allowFailure: true })
    diffSoFar = clean(read.stdout.trim())
  }
  const reports = Number(parked.reports ?? 0)
  const last = store.engines.get(`report/${String(parked.id)}/${reports}`)
  const summary = (last?.report as { summary?: string } | undefined)?.summary
  const openQuestions = store.engines
    .list({ attemptId: parked.id })
    .filter((doc) => String(doc.id).startsWith('question/') && doc.status === 'open').length
  return {
    worktree,
    plan,
    diffSoFar,
    transcriptSummary: clean(summary ?? 'no report yet'),
    openQuestions,
    holds: 0,
  }
}

function nextAttemptId(store: Store): string {
  let max = 0
  for (const doc of store.attempts.list()) {
    max = Math.max(max, Number(/^att_(\d+)$/.exec(String(doc.id))?.[1] ?? 0))
  }
  return `att_${max + 1}`
}

/** New attempts on the target, after a fresh probe. Returns why not, when it did not happen. */
export async function applySwitch(
  deps: SwitchDeps,
  input: {
    workItemId: string
    toSlot: string
    reason: string
    confirmationId?: string
    /** What a card stated: an approval is of exactly this set (§13). */
    parkedAttempts?: readonly string[]
  },
): Promise<string | undefined> {
  const { store, effects, now, probe } = deps
  const { workItemId, toSlot, confirmationId, parkedAttempts } = input
  const stream = `work:${workItemId}`
  const refuse = (why: string, at: string): string => {
    appendEvent(store, stream, 'slot_switch_refused', { workItemId, toSlot, reason: why, at }, at)
    // An approved card outlives a hold: a hold pauses, it does not answer (§12).
    if (why !== 'held') markApplied(store, confirmationId)
    return why
  }
  const healthy = await probe(toSlot).catch(() => false)
  const start = now()
  const why = healthy ? refusal(deps, workItemId, toSlot, start) : 'target_unhealthy'
  if (why !== undefined) return store.atomic(() => refuse(why, start))
  const parked = parkedOn(store, workItemId)
  if (parkedAttempts !== undefined && !sameIds(idsOf(parked), parkedAttempts)) {
    return store.atomic(() => refuse('stale', start))
  }
  const reason = cleaned(deps, parked, input.reason)
  const packs = await Promise.all(parked.map((doc) => packFor(deps, doc)))
  const at = now()
  return store.atomic(() => {
    // The awaits above let another switch, a resume or a park in: decide again, here.
    const late = refusal(deps, workItemId, toSlot, at)
    if (late !== undefined) return refuse(late, at)
    const current = parkedOn(store, workItemId)
    if (!sameIds(idsOf(current), idsOf(parked))) return refuse('stale', at)
    for (const [index, doc] of current.entries()) {
      const pack = packs[index] as Record<string, Json>
      const attemptId = nextAttemptId(store)
      const task = store.tasks.get(String(doc.taskId))
      const role = String(doc.role ?? task?.role)
      const continuation = {
        kind: 'handoff',
        role,
        evidence: `This work moved here from another slot (${reason}). The handoff pack:\n${JSON.stringify(pack)}`,
        round: 0,
        ...(typeof doc.worktree === 'string' && { worktree: doc.worktree }),
        ...(typeof doc.branch === 'string' && { branch: doc.branch }),
      } as Continuation
      store.attempts.save({
        id: attemptId,
        taskId: doc.taskId ?? null,
        workItemId,
        slotId: toSlot,
        state: 'queued',
        generation: 1,
        placement: `switched from ${String(doc.slotId)}`,
        role,
        continuation: continuation as unknown as Json,
        createdAt: at,
        updatedAt: at,
      })
      store.attempts.save({ ...doc, switched_to: attemptId, updatedAt: at })
      store.engines.save({
        id: `handoff/${workItemId}/${attemptId}`,
        workItemId,
        attemptId,
        fromAttempt: String(doc.id),
        fromSlot: String(doc.slotId),
        toSlot,
        reason,
        at,
        pack,
        updatedAt: at,
      })
      const body = { workItemId, attemptId, fromSlot: String(doc.slotId), toSlot, at }
      appendEvent(store, stream, 'slot_switched', body, at)
      effects.enqueue('launch', `${attemptId}:1`, {
        attempt_id: attemptId,
        task_id: String(doc.taskId),
        work_item_id: workItemId,
        slot_id: toSlot,
        generation: 1,
      })
    }
    markApplied(store, confirmationId)
    return undefined
  })
}

function markApplied(store: Store, confirmationId: string | undefined): void {
  if (confirmationId === undefined) return
  const card = store.confirmations.get(confirmationId)
  if (card !== undefined) store.confirmations.save({ ...card, applied: true })
}

/** What a pass owes approved cards. A card already applied, or denied, moves nothing. */
export async function applyApprovedSwitches(deps: SwitchDeps): Promise<void> {
  const { store } = deps
  const cards = store.confirmations
    .list({ status: 'approved' })
    .filter((doc) => doc.cls === 'slot_switch' && doc.applied !== true)
  for (const card of cards) {
    const work = store.workItems.get(String(card.workItemId))
    if (work !== undefined && isHeld(work)) continue
    const { toSlot, reason, parkedAttempts } = card.payload as {
      toSlot: string
      reason: string
      parkedAttempts?: string[]
    }
    await applySwitch(deps, {
      workItemId: String(card.workItemId),
      toSlot,
      reason,
      confirmationId: String(card.id),
      // A card that names no attempts stated nothing this switch could honour.
      parkedAttempts: parkedAttempts ?? [],
    })
  }
}

/** §5.10 auto-failover: a slot's pair moves work unasked only when policy pre-authorises it. */
export async function autoFailover(deps: SwitchDeps): Promise<void> {
  const { store, policy, now } = deps
  const parkedWork = new Set(
    store.attempts
      .list()
      .filter((doc) => PARKED.includes(String(doc.state)) && doc.switched_to === undefined)
      .map((doc) => String(doc.workItemId)),
  )
  for (const workItemId of parkedWork) {
    const work = store.workItems.get(workItemId)
    const repoId = work?.repoId
    if (!policyPreAuthorises(policy, 'slot_switch', typeof repoId === 'string' ? { repoId } : {})) continue
    const [first] = parkedOn(store, workItemId)
    const pairs = store.slots.get(String(first?.slotId))?.pairs
    if (!Array.isArray(pairs)) continue
    const at = now()
    const target = pairs.map(String).find((to) => refusal(deps, workItemId, to, at) === undefined)
    if (target === undefined) continue
    const reason = `paired failover: ${String(first?.state)}`
    store.atomic(() => {
      const body = { workItemId, toSlot: target, reason, at }
      appendEvent(store, `work:${workItemId}`, 'slot_switch_preauthorised', body, at)
    })
    await applySwitch(deps, { workItemId, toSlot: target, reason })
  }
}
