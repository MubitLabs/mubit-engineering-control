/**
 * What a boot does with what a crash left, and how parked work comes back (spec §5.10, §8.1, §17,
 * §20). The boot order is the composition root's: lock, journal replay, process reconciliation,
 * external reconciliation, then effects and passes.
 *
 * - **Identity before a signal.** A launch stores pid and start time. A boot signals a group only
 *   when `ps` shows that pid with that start time, leading its own group. A recycled pid means ours
 *   is gone. Anything else is reported, never signalled, and nothing replaces the attempt.
 * - **Restart.** `running → stalled → interrupted`, then one launch row for a new generation with a
 *   recovery note, oldest work first. A resume keeps its own row kind of payload (`resume: true`),
 *   so the launch gate for queued attempts still refuses every other late row.
 * - **Outside effects are read, never repeated.** A card approved with no outcome is settled from
 *   what the remote says. Absent means not sent, and a retry is a new card.
 * - **Parked work** resumes through `resumeVerdict`: the mandate first, and never past a hold.
 */
import { execFile } from 'node:child_process'
import { existsSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Degraded, Effects, Json, SlotState, Store, StoreDoc } from '@mec/contracts'
import {
  ATTEMPT_MACHINE,
  ATTEMPT_TERMINAL,
  type AttemptState,
  canTransition,
  DEFAULT_CAPS,
  transition,
} from '@mec/domain'
import {
  enqueueWake,
  isHeld,
  isTerminal,
  type LaunchAuthority,
  mandateOf,
  noVerdict,
  refuseLaunch,
  revalidateWork,
} from '@mec/meta'
import {
  type AttemptFacts,
  groupAlive,
  type MandateCheck,
  type ParkedState,
  type ProcessMark,
  parkReady,
  readProcess,
  reapGroup,
  replayJournal,
  resumeVerdict,
} from '@mec/runtime'
import { type ProbeRun, probeClaudeSlot, SlotMachine } from '@mec/slots'
import type { CardOutcome, GhRun, GitExec } from './release'

/** §8.7: what a resumed or retried attempt is told first. */
export const RESTART_NOTE =
  'host restarted: check the worktree, git history and outbox before repeating any outside action'

const RESUME_NOTE =
  'resumed after a park: check the worktree, git history and outbox before repeating any outside action'

const PARKED: readonly string[] = ['quota_wait', 'auth_required', 'provider_down']

/** Where the planner's engine and token dirs are recorded, so a boot can clear what a crash left. */
export const PLANNER_DOC = 'runtime/planner'

/** The only names a boot removes from what that doc lists. */
const PLANNER_DIR = /^mec-(planner|meta-brain)-/

const PROBE_TIMEOUT_MS = 15_000

const appendEvent = (store: Store, stream: string, type: string, body: Json, at: string): void => {
  const seq = (store.events.read(stream).at(-1)?.seq ?? 0) + 1
  store.events.append(stream, { stream, seq, at, type, body })
}

export type GroupFinding = 'ours' | 'recycled' | 'gone' | 'unprovable'

/**
 * Whether a stored group is still ours. A pid cannot be reused while its group exists, so a leader
 * with another start time means ours has ended. A group with no leader left proves nothing.
 */
export function identifyGroup(
  mark: ProcessMark,
  read: (pid: number) => { started: string; pgid: number } | undefined = readProcess,
  alive: (pid: number) => boolean = groupAlive,
): GroupFinding {
  const leader = read(mark.pid)
  if (leader === undefined) return alive(mark.pid) ? 'unprovable' : 'gone'
  if (leader.started !== mark.started) return 'recycled'
  return leader.pgid === mark.pid ? 'ours' : 'unprovable'
}

const markOf = (value: unknown): ProcessMark | undefined => {
  const mark = value as Partial<ProcessMark> | undefined
  return typeof mark?.pid === 'number' && typeof mark.started === 'string'
    ? { pid: mark.pid, started: mark.started }
    : undefined
}

export type ProcessDeps = {
  store: Store
  effects: Effects
  dataDir: string
  now: () => string
  /** Test seams; identity and the signals are otherwise the real ones. */
  identify?: (mark: ProcessMark) => GroupFinding
  reap?: (pid: number) => Promise<string>
}

/** §8.6: every unacknowledged tail, before anything reads the attempt's state. */
export function replayJournals(facts: AttemptFacts, store: Store, dataDir: string): number {
  const journalRoot = join(dataDir, 'journal')
  let applied = 0
  for (const doc of store.attempts.list()) {
    if (ATTEMPT_TERMINAL.includes(String(doc.state) as AttemptState)) continue
    try {
      applied += replayJournal({ journalRoot, facts }, String(doc.id), String(doc.slotId ?? ''))
    } catch (error) {
      // Unacknowledged, so the next boot tries again; one bad journal does not keep the server down.
      console.error(`[recovery] replay of ${String(doc.id)} failed: ${String(error)}`)
    }
  }
  return applied
}

/**
 * Whether nothing of this group is left. Refused means `reconcile_refused` on the attempt, which the
 * launch and resume gates wait on, so a row that survived cannot start beside the group. A later
 * boot that proves the group gone clears it.
 */
async function clearGroup(deps: ProcessDeps, doc: StoreDoc, value: unknown): Promise<boolean> {
  const cleared = await provablyGone(deps, doc, value)
  const fresh = deps.store.attempts.get(String(doc.id))
  if (cleared && fresh?.reconcile_refused !== undefined) {
    const { reconcile_refused: _refused, ...rest } = fresh
    deps.store.atomic(() => deps.store.attempts.save({ ...rest, updatedAt: deps.now() }))
  }
  return cleared
}

/** Signals the group only if it is provably ours. */
async function provablyGone(deps: ProcessDeps, doc: StoreDoc, value: unknown): Promise<boolean> {
  const { store, now } = deps
  const mark = markOf(value)
  if (mark === undefined) return true
  const id = String(doc.id)
  const stream = `attempt:${id}`
  const found = (deps.identify ?? identifyGroup)(mark)
  if (found === 'gone') return true
  if (found === 'recycled') {
    appendEvent(store, stream, 'attempt.pid_recycled', { attemptId: id, pid: mark.pid, at: now() }, now())
    return true
  }
  const outcome =
    found === 'ours' ? await (deps.reap ?? ((pid: number) => reapGroup(pid)))(mark.pid) : 'unprovable'
  if (outcome === 'terminated' || outcome === 'escalated') return true
  const at = now()
  store.atomic(() => {
    const fresh = store.attempts.get(id) ?? doc
    store.attempts.save({ ...fresh, reconcile_refused: outcome, updatedAt: at })
    appendEvent(store, stream, 'attempt.reconcile_refused', { attemptId: id, reason: outcome, at }, at)
  })
  return false
}

/** The token leaves with the process that used it, whatever became of that process (§5.12). */
function seal(doc: StoreDoc): void {
  if (typeof doc.worktree === 'string') rmSync(join(doc.worktree, '.mec', 'mcp.json'), { force: true })
}

function move(store: Store, doc: StoreDoc, event: string, fields: StoreDoc, at: string): StoreDoc {
  const moved = {
    ...doc,
    ...fields,
    state: transition(ATTEMPT_MACHINE, String(doc.state), event),
    updatedAt: at,
  }
  store.attempts.save(moved)
  return moved
}

const launchPayload = (doc: StoreDoc, generation: number, extra: Record<string, Json>): Json => ({
  attempt_id: String(doc.id),
  task_id: String(doc.taskId),
  work_item_id: String(doc.workItemId),
  slot_id: String(doc.slotId),
  generation,
  ...extra,
})

/** One new generation and its launch row. Work that may not run gets none. */
function enqueueResume(store: Store, effects: Effects, doc: StoreDoc, note: string, at: string): void {
  const generation = Number(doc.generation ?? 1) + 1
  store.attempts.save({ ...doc, generation, resuming: true, updatedAt: at })
  effects.enqueue(
    'launch',
    `${String(doc.id)}:${generation}`,
    launchPayload(doc, generation, { resume: true, note }),
  )
}

export const mayRun = (work: StoreDoc | undefined): work is StoreDoc =>
  work !== undefined && !isTerminal(work) && mandateOf(work).status !== 'withdrawn'

function restart(deps: ProcessDeps, doc: StoreDoc, at: string): void {
  const { store, effects } = deps
  if (mayRun(store.workItems.get(String(doc.workItemId)))) {
    enqueueResume(store, effects, doc, RESTART_NOTE, at)
  }
}

/** Running work ends as "host restarted"; a group that would not go keeps the attempt stalled. */
async function reconcileLive(deps: ProcessDeps, doc: StoreDoc): Promise<void> {
  const { store, now } = deps
  const id = String(doc.id)
  let current = doc
  if (doc.state === 'running') {
    const at = now()
    current = store.atomic(() => {
      appendEvent(store, `attempt:${id}`, 'attempt.reconciled', { note: RESTART_NOTE }, at)
      return move(store, doc, 'stall_detected', {}, at)
    })
  }
  if (!(await clearGroup(deps, current, current.process))) return
  seal(current)
  const at = now()
  store.atomic(() => {
    const fresh = store.attempts.get(id) ?? current
    restart(deps, move(store, fresh, 'reconciled_stopped', { terminal_reason: 'host_restarted' }, at), at)
  })
}

/** A stall found while running (§20): reconciled like a restart, before anything replaces it. */
export async function reconcileStalled(deps: ProcessDeps, attemptId: string): Promise<void> {
  const doc = deps.store.attempts.get(attemptId)
  if (doc?.state === 'stalled') await reconcileLive(deps, doc)
}

/** A launch that had started its engine and not yet heard from it. */
async function reconcileQueued(deps: ProcessDeps, doc: StoreDoc): Promise<void> {
  if (markOf(doc.process) === undefined) return
  if (!(await clearGroup(deps, doc, doc.process))) return
  seal(doc)
  const generation = Number(doc.generation ?? 1)
  deps.effects.enqueue('launch', `${String(doc.id)}:${generation}`, launchPayload(doc, generation, {}))
}

/** Checks a crash or a shutdown cut short run again on the same head. A stop's verdict stands. */
async function reconcileChecks(deps: ProcessDeps, doc: StoreDoc): Promise<void> {
  const { store, effects } = deps
  if (doc.checks_note !== undefined && doc.checks_stopped !== 'server_closing') return
  if (!(await clearGroup(deps, doc, doc.check_process))) return
  if (!mayRun(store.workItems.get(String(doc.workItemId)))) return
  const generation = Number(doc.generation ?? 1)
  effects.enqueue(
    'launch',
    `${String(doc.id)}:${generation}:recheck`,
    launchPayload(doc, generation, { recheck: true }),
  )
}

/** §20, oldest work item first. Attempts that were waiting, ready, blocked or failed stay. */
export async function reconcileProcesses(deps: ProcessDeps): Promise<void> {
  const { store, now } = deps
  const created = (doc: StoreDoc): string =>
    String(store.workItems.get(String(doc.workItemId))?.createdAt ?? '')
  const docs = [...store.attempts.list()].sort(
    (a, b) => created(a).localeCompare(created(b)) || String(a.id).localeCompare(String(b.id)),
  )
  for (const doc of docs) {
    const { state } = doc
    if (state === 'running' || state === 'stalled') await reconcileLive(deps, doc)
    else if (state === 'queued') await reconcileQueued(deps, doc)
    else if (state === 'work_complete') await reconcileChecks(deps, doc)
    else if ((state === 'interrupted' || PARKED.includes(String(state))) && doc.resuming === true) {
      // Its row is still there. A crash during that launch may have left an engine.
      await clearGroup(deps, doc, doc.process)
    } else if (state === 'interrupted' && doc.terminal_reason === 'server_closing') {
      seal(doc)
      const at = now()
      store.atomic(() => restart(deps, doc, at))
    }
  }
}

type PlannerSeams = Pick<ProcessDeps, 'identify' | 'reap'>

/** Why this group may still be there, or undefined once it provably is not. */
async function plannerGroupLeft(mark: ProcessMark, seams: PlannerSeams): Promise<string | undefined> {
  const found = (seams.identify ?? identifyGroup)(mark)
  if (found === 'gone' || found === 'recycled') return undefined
  if (found === 'unprovable') return found
  const outcome = await (seams.reap ?? ((pid: number) => reapGroup(pid)))(mark.pid)
  return outcome === 'terminated' || outcome === 'escalated' ? undefined : outcome
}

/**
 * The planner's engine and token dirs from a server that died without closing (M1.4b's open item).
 * A group that may still be there is reported every boot. Its mark moves to `refused`, where the
 * next planner turn cannot overwrite it, and the dirs it may be using stay until it is proven gone.
 */
export async function reconcilePlanner(store: Store, seams: PlannerSeams = {}): Promise<void> {
  const doc = store.engines.get(PLANNER_DOC)
  if (doc === undefined) return
  const held = Array.isArray(doc.refused) ? (doc.refused as { process?: Json }[]) : []
  const marks = [...held.map((entry) => markOf(entry.process)), markOf(doc.process)]
  const refused: { process: ProcessMark; reason: string }[] = []
  for (const mark of marks) {
    const reason = mark === undefined ? undefined : await plannerGroupLeft(mark, seams)
    if (mark !== undefined && reason !== undefined) refused.push({ process: mark, reason })
  }
  const { process: _process, refused: _refused, ...rest } = doc
  if (refused.length > 0) {
    const at = new Date().toISOString()
    store.atomic(() => {
      store.engines.save({ ...rest, refused: refused as unknown as Json, updatedAt: at })
      for (const { process: mark, reason } of refused) {
        const body = { pid: mark.pid, reason, at }
        appendEvent(store, 'runtime:planner', 'planner.reconcile_refused', body, at)
      }
    })
    return
  }
  const root = realpathSync(tmpdir())
  const dirs = Array.isArray(doc.tempDirs) ? doc.tempDirs.map(String) : []
  for (const dir of dirs) {
    const inside = existsSync(dir) && realpathSync(dirname(dir)) === root
    if (inside && PLANNER_DIR.test(basename(dir))) rmSync(dir, { recursive: true, force: true })
  }
  store.engines.save({ ...rest, tempDirs: [], updatedAt: new Date().toISOString() })
}

// ── External effects ─────────────────────────────────────────────────────────────────────────

export type ExternalDeps = {
  store: Store
  effects: Effects
  run: GhRun
  git: GitExec
  now: () => Date
}

type Card = StoreDoc & { payload: Record<string, Json> }

/** Every event that closes an approved card, by class. */
const OUTCOMES: Readonly<Record<string, readonly string[]>> = {
  push: ['pushed', 'push_failed', 'push_not_sent'],
  pr_create: ['pr_created', 'pr_create_failed', 'pr_not_sent'],
  pr_merge: ['merged_on_github', 'merge_failed', 'merge_unconfirmed', 'merge_not_sent'],
}

const streamOf = (card: Card): string => {
  const { repo, branch, prNumber } = card.payload
  return `release:${String(repo)}:${card.cls === 'pr_merge' ? `pr-${String(prNumber)}` : String(branch)}`
}

function unsettled(store: Store): Card[] {
  return store.confirmations.list({ status: 'approved' }).filter((doc): doc is Card => {
    const closes = OUTCOMES[String(doc.cls)]
    if (closes === undefined || typeof doc.payload !== 'object' || doc.payload === null) return false
    const seen = store.events.read(streamOf(doc as Card))
    return !seen.some(
      (event) =>
        closes.includes(event.type) && (event.body as { confirmationId?: unknown }).confirmationId === doc.id,
    )
  })
}

/** What the remote says of one card: an event and the outcome, or undefined if it cannot be read. */
async function readOutcome(
  deps: ExternalDeps,
  card: Card,
): Promise<{ type: string; fields: Record<string, Json>; outcome: Partial<CardOutcome> } | undefined> {
  const { repo, branch, prNumber, remoteUrl } = card.payload
  if (card.cls === 'push') {
    const read = await deps.git(['ls-remote', String(remoteUrl), `refs/heads/${String(branch)}`])
    if (read.code !== 0) return undefined
    const head = read.stdout.split(/\s/)[0]
    if (head === undefined || head === '' || head !== card.inputSha) {
      return { type: 'push_not_sent', fields: {}, outcome: { pushed: false, error: 'push not sent' } }
    }
    return { type: 'pushed', fields: { headSha: head }, outcome: { pushed: true, headSha: head } }
  }
  if (card.cls === 'pr_create') {
    const read = await deps.run([
      'pr',
      'list',
      '-R',
      String(repo),
      '--head',
      String(branch),
      '--state',
      'all',
      '--json',
      'number,url,state',
    ])
    if (read.code !== 0) return undefined
    const [found] = JSON.parse(read.stdout || '[]') as { number: number; url: string }[]
    if (found === undefined) {
      return { type: 'pr_not_sent', fields: {}, outcome: { error: 'pull request not created' } }
    }
    const pr = { prNumber: found.number, prUrl: found.url }
    return { type: 'pr_created', fields: pr, outcome: pr }
  }
  const viewed = await deps.run(['pr', 'view', String(prNumber), '-R', String(repo), '--json', 'state'])
  if (viewed.code !== 0) return undefined
  const { state } = JSON.parse(viewed.stdout || '{}') as { state?: string }
  return state === 'MERGED'
    ? { type: 'merged_on_github', fields: {}, outcome: { merged: true } }
    : { type: 'merge_not_sent', fields: {}, outcome: { merged: false, reason: 'merge not sent' } }
}

/**
 * §17, §20. Records what the remote shows and returns what delivery needs to hear, because delivery
 * starts after this. A card that cannot be read stays as it is for the next boot.
 */
export async function reconcileExternal(
  deps: ExternalDeps,
): Promise<{ card: StoreDoc; outcome: CardOutcome }[]> {
  const { store, now } = deps
  const settled: { card: StoreDoc; outcome: CardOutcome }[] = []
  for (const card of unsettled(store)) {
    const read = await readOutcome(deps, card).catch(() => undefined)
    if (read === undefined) continue
    const at = now().toISOString()
    store.atomic(() => {
      const body = { confirmationId: String(card.id), reconciled: true, ...read.fields, at }
      appendEvent(store, streamOf(card), read.type, body, at)
    })
    const outcome = { id: String(card.id), cls: String(card.cls), status: 'approved', ...read.outcome }
    settled.push({ card, outcome })
  }
  return settled
}

// ── Resume, the gate ─────────────────────────────────────────────────────────────────────────

type LaunchFields = { attempt_id: string; generation: number; recheck?: boolean; resume?: boolean }

export const isResumeRow = (payload: Json): boolean => {
  const fields = (payload ?? {}) as Partial<LaunchFields>
  return fields.resume === true || fields.recheck === true
}

export const isRecheckRow = (payload: Json): boolean =>
  ((payload ?? {}) as Partial<LaunchFields>).recheck === true

/** The launch gate for a row that is no first launch: the same authority, on a parked attempt. */
export function resumeAuthority(
  store: Store,
  payload: Json,
  now: string,
  policyHash: string,
): LaunchAuthority {
  const fields = (payload ?? {}) as LaunchFields & { work_item_id?: string }
  const work = store.workItems.get(String(fields.work_item_id))
  if (work === undefined) return { verdict: 'drop', reason: 'work_missing' }
  if (isTerminal(work)) return { verdict: 'drop', reason: 'work_terminal' }
  const attempt = store.attempts.get(fields.attempt_id)
  const current = attempt?.generation === fields.generation
  const fits =
    fields.recheck === true
      ? attempt?.state === 'work_complete' &&
        !(noVerdict(attempt) && attempt.checks_stopped !== 'server_closing')
      : attempt?.resuming === true &&
        attempt.switched_to === undefined &&
        [...PARKED, 'interrupted'].includes(String(attempt.state))
  if (!current || !fits) return { verdict: 'drop', reason: 'attempt_not_queued' }
  const mandate = revalidateWork(work, now, policyHash) as MandateCheck
  const verdict = resumeVerdict({ held: isHeld(work), mandate })
  return verdict.verdict === 'run' && attempt?.reconcile_refused !== undefined
    ? { verdict: 'defer', reason: 'reconcile_refused' }
    : verdict
}

const withoutResuming = (doc: StoreDoc): StoreDoc => {
  const { resuming: _resuming, ...rest } = doc
  return rest
}

/** The row ended without an engine: the attempt stays as it was, and gives its capacity back. */
export function dropResume(store: Store, payload: Json, reason: string, at: string): void {
  const fields = (payload ?? {}) as LaunchFields
  const doc = store.attempts.get(fields.attempt_id)
  if (doc !== undefined && doc.resuming === true) store.attempts.save(withoutResuming(doc))
  if (!isRecheckRow(payload)) refuseLaunch(store, payload, reason as never, at)
}

/** The engine is up: `interrupted → resume` or a park's `resume`, and the note on the record. */
export function markResumed(store: Store, payload: Json, at: string): void {
  const fields = (payload ?? {}) as LaunchFields & { note?: string }
  const doc = store.attempts.get(fields.attempt_id)
  if (doc === undefined || !canTransition(ATTEMPT_MACHINE, String(doc.state), 'resume')) return
  const { terminal_reason: _reason, parked: _parked, ...rest } = withoutResuming(doc)
  move(store, rest, 'resume', {}, at)
  const input = { id: `in_recovery_${fields.attempt_id}_${fields.generation}`, kind: 'recovery' }
  const body = {
    attemptId: fields.attempt_id,
    generation: fields.generation,
    input,
    note: fields.note ?? '',
    at,
  }
  appendEvent(store, `attempt:${fields.attempt_id}`, 'attempt.resumed', body as Json, at)
}

// ── Parking ──────────────────────────────────────────────────────────────────────────────────

const DEGRADED_BY: Readonly<Record<ParkedState, Degraded>> = {
  quota_wait: 'quota_exhausted',
  auth_required: 'auth_expired',
  provider_down: 'provider_unreachable',
}

/**
 * §5.10 Inform, in the park's own transaction: the slot degrades, and chat and the meta agent get
 * the same words. Work that comes back by itself is a note; anything else wakes (§6).
 */
export function recordPark(
  store: Store,
  effects: Effects,
  doc: StoreDoc,
  input: { state: ParkedState; reason: string; resetsAt?: string; at: string },
): void {
  const { state, reason, resetsAt, at } = input
  const slotId = String(doc.slotId)
  const slot = store.slots.get(slotId)
  if (slot !== undefined && slot.state !== 'retired') {
    store.slots.save({
      ...slot,
      state: 'degraded',
      state_reason: DEGRADED_BY[state],
      resets_at: resetsAt ?? 'unknown',
      updatedAt: at,
    })
  }
  const known = resetsAt !== undefined && resetsAt !== 'unknown'
  const text = `${slotId}: ${reason}, ${known ? `resets ${resetsAt}` : 'reset unknown'}`
  const workItemId = String(doc.workItemId)
  const generation = Number(doc.generation ?? 1)
  const cause = `parked:${String(doc.id)}:${generation}`
  const repoId = store.workItems.get(workItemId)?.repoId
  store.messages.save({
    id: `msg_${cause.replaceAll(':', '_')}`,
    text,
    routing: 'notice',
    notice: true,
    workItemId,
    ...(typeof repoId === 'string' && { repoId }),
    createdAt: at,
    updatedAt: at,
  })
  const wakes = classifyPark(state, known)
  if (wakes) {
    enqueueWake(effects, { causationId: cause, reason: 'work parked', detail: text, workItemId })
  } else {
    effects.enqueue('note', cause, { workItemId, cause, text, at })
  }
}

/** `classifyWake`'s rule: a reported reset or an outage resolves itself, and a login does not. */
const classifyPark = (state: ParkedState, resetKnown: boolean): boolean =>
  !(state === 'provider_down' || (state === 'quota_wait' && resetKnown))

/** Slots a slot's capacity counts against: what `occupies` counts in a pass (§11). */
function inUse(store: Store, slotId: string): number {
  return store.attempts.list().filter((doc) => {
    if (doc.slotId !== slotId) return false
    if (doc.resuming === true) return true
    return (
      ['queued', 'running', 'stalled'].includes(String(doc.state)) ||
      (doc.state === 'work_complete' && !noVerdict(doc))
    )
  }).length
}

export type ParkDeps = { store: Store; effects: Effects; policyHash: string; now: () => string }

/**
 * §5.10 Resume. `explicit` is the owner's own action, which needs no probe; nothing skips the
 * mandate or a hold. Health means a probe after the park: a stored `healthy` proves nothing.
 */
export function resumeParked(deps: ParkDeps, only?: { workItemId: string; explicit: true }): string[] {
  const { store, effects, policyHash, now } = deps
  const at = now()
  const resumed: string[] = []
  for (const doc of store.attempts.list()) {
    if (!PARKED.includes(String(doc.state)) || doc.switched_to !== undefined) continue
    if (only !== undefined && doc.workItemId !== only.workItemId) continue
    const work = store.workItems.get(String(doc.workItemId))
    if (!mayRun(work)) continue
    const slot = store.slots.get(String(doc.slotId))
    const parked = (doc.parked ?? {}) as { at?: string; resets_at?: string }
    const probed = typeof slot?.last_probe_at === 'string' && slot.last_probe_at >= (parked.at ?? '')
    const ready =
      only?.explicit === true
        ? doc.resuming !== true
        : parkReady({
            ...(parked.resets_at !== undefined && { resetsAt: parked.resets_at }),
            slotHealthy: slot?.state === 'healthy' && probed,
            resuming: doc.resuming === true,
            now: at,
          })
    if (!ready) continue
    const verdict = resumeVerdict({
      held: isHeld(work),
      mandate: revalidateWork(work, at, policyHash) as MandateCheck,
    })
    if (verdict.verdict !== 'run') continue
    const room = typeof slot?.concurrency === 'number' ? slot.concurrency : DEFAULT_CAPS.perSlot
    if (inUse(store, String(doc.slotId)) >= room) continue
    store.atomic(() => enqueueResume(store, effects, doc, RESUME_NOTE, at))
    resumed.push(String(doc.id))
  }
  return resumed
}

// ── Probes ───────────────────────────────────────────────────────────────────────────────────

const HEALED_BY_PROBE: readonly (string | undefined)[] = [
  undefined,
  'auth_expired',
  'quota_exhausted',
  'provider_unreachable',
  'engine_missing',
]

/** §5.8: the vendor's own local status command, under the slot's home. */
export const defaultProbeRun: ProbeRun = (cmd, args, env) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { env: { ...process.env, ...env }, timeout: PROBE_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') reject(error)
        else resolve({ code: error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })

const slotEnvOf = (slot: StoreDoc): Record<string, string> => {
  const env = slot.env
  if (typeof env !== 'object' || env === null || Array.isArray(env)) return {}
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string')) as Record<
    string,
    string
  >
}

/** Only slots whose probe is local and free are probed on a timer (§5.8's never-list). */
export const isProbedSlot = (slot: StoreDoc): boolean =>
  slot.kind === 'claude-sub' && slot.state !== 'retired'

export function enqueueProbes(store: Store, effects: Effects): void {
  for (const slot of store.slots.list().filter(isProbedSlot)) {
    effects.enqueue('probe', String(slot.id), { slot_id: String(slot.id) })
  }
}

/**
 * One probe, as §5.5's machine allows. A slot waiting out a reported reset stays degraded however
 * the login reads: a healthy login says nothing about quota. Returns whether the slot is healthy.
 */
export async function probeSlot(
  store: Store,
  slotId: string,
  run: ProbeRun,
  now: () => string,
): Promise<boolean> {
  const slot = store.slots.get(slotId)
  if (slot === undefined || !isProbedSlot(slot)) return false
  const result = await probeClaudeSlot(run, slotEnvOf(slot))
  const at = now()
  const fresh = store.slots.get(slotId) ?? slot
  const from = String(fresh.state)
  const resets = typeof fresh.resets_at === 'string' ? fresh.resets_at : undefined
  const waiting =
    fresh.state_reason === 'quota_exhausted' && resets !== undefined && resets !== 'unknown' && resets > at
  const healed =
    result.state === 'healthy' && !waiting && HEALED_BY_PROBE.includes(fresh.state_reason as string)
  const signal = healed ? 'probe_ok' : result.state === 'healthy' ? undefined : 'probe_failed'
  const machine = new SlotMachine(() => {})
  let state = from
  if (signal !== undefined) {
    try {
      state = machine.apply({ id: slotId, state: from as SlotState }, signal, result.reason)
    } catch {
      // §5.5 has no such edge: a slot still being set up stays where its flow put it.
    }
  }
  const { state_reason: _reason, resets_at: _resets, ...rest } = fresh
  store.atomic(() => {
    store.slots.save({
      ...(state === 'healthy' ? rest : fresh),
      state,
      ...(state === 'degraded' && result.reason !== undefined && signal === 'probe_failed'
        ? { state_reason: result.reason }
        : {}),
      last_probe_at: at,
      updatedAt: at,
    })
  })
  return state === 'healthy'
}
