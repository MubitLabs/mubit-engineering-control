/**
 * From accepted tasks to a tested PR ready for review (spec §14, §15, decisions #11, #12, #29, #34).
 * Deterministic: no agent tool reaches this. A pass integrates one task per work item, then the
 * reducer says whether the work is locally complete, and only then does the result path move.
 *
 * - **Every outside effect keeps its own card.** This opens cards and reads what they did. It never
 *   answers one: a push leads to a PR card, a PR to observing GitHub, and a merge card never opens.
 * - **The record is `delivery/<work>`.** Its `stage` is what is true now. A card's answer arrives
 *   through `onCardSettled`, whichever door it came by, and a pass does the rest, so an interrupted
 *   continuation is only a late one. Writes re-read the doc, so an answer between two awaits stands.
 * - **Observed, not assumed.** `ready` needs an open PR on the integration head, combined checks on
 *   that SHA and required checks as GitHub reports them. `merged` needs GitHub to say so.
 * - **A head that moved starts over.** Pending cards go stale, and a new card asks about the new head.
 * - **A stop or hold reaches an open card.** Passes skip stopped and held work, so the answer asks.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Effects, type Json, Later, type Store, type StoreDoc } from '@mec/contracts'
import {
  type Caps,
  canTransition,
  DEFAULT_CAPS,
  TASK_MACHINE,
  transition,
  WORK_ITEM_MACHINE,
} from '@mec/domain'
import {
  clearMergePath,
  git,
  gitLines,
  headSha,
  mergeIntoIntegration,
  prepareMidMergeRepair,
  recordBootstrapOutput,
  Worktrees,
} from '@mec/git'
import {
  type ControllerDeps,
  type ControllerTask,
  type IntegrationCheck,
  type IntegrationEffect,
  type IntegrationState,
  repairSettled,
  runIntegration,
} from '@mec/integration'
import {
  blockTask,
  blockWork,
  cutAtWord,
  HOST_RUN_UNAGREED,
  hostRunAgreed,
  integrationDocId,
  isHeld,
  isTerminal,
  mandateOf,
  openRepairTask,
  ownerRepairOffer,
  ownerRetryRepair,
  processingOf,
  repairEvidence,
  repoFields,
  revalidateWork,
  workResultOf,
} from '@mec/meta'
import { loadPolicy } from '@mec/policy'
import { buildAgentEnv, runCheck } from '@mec/runtime'
import { redact } from '@mec/slots'
import { argvOf, commitIdentity, repoInherited } from './attempt-launch'
import {
  buildPrBody,
  type CardBlock,
  type CardOutcome,
  createPrBehindCard,
  defaultGhRun,
  type GhRun,
  type GitExec,
  movePrFlow,
  openPushCard,
  pushTarget,
  type ReleaseDeps,
  readPr,
  readRequiredChecks,
  refusalOf,
  releaseEvent,
  remoteHead,
  staleCard,
  workEvent,
  yieldCheck,
} from './release'

export const deliveryDocId = (workItemId: string): string => `delivery/${workItemId}`

/** `mec/<work-item8>/integration` (§14). */
const integrationBranch = (workItemId: string): string =>
  `mec/${workItemId.replace(/^wi_/, '').slice(0, 8)}/integration`

/** How often an open PR is read: every pass would be every two seconds. */
const POLL_MS = 30_000
/** How long a refused or unreadable step waits before it is tried again. */
const RETRY_MS = 30_000

const TITLE_CHARS = 72

const OPEN_STATES: readonly string[] = ['executing', 'reviewing', 'integrating']

/** What the integration path blocks with. Any other block needs more than the same step again. */
const INTEGRATION_BLOCK = /^(integration: |bootstrap_failed: |checks failed on |could not run )/

const OFFER_CHARS = 300
/** How many cleared paths an event names; the count says the rest. */
const CLEARED_PATHS = 50

/** `repair`: the owner's Try again on blocked work, one fresh repair attempt (owner ruling 2026-11-07). */
export type RetryKind = 'integration' | 'push' | 'pr' | 'repair'
export type RetryOffer = { kind: RetryKind; reason: string }
export type RetryOutcome =
  | { status: 'retrying'; kind: RetryKind }
  | { status: 'missing' }
  | { status: 'refused'; error: string }

/** An accepted task integration refused. Its head stands, so a retry merges it and starts nothing. */
const refusedTask = (task: StoreDoc): boolean =>
  task.status === 'blocked' && typeof task.acceptedHead === 'string'

/**
 * What a person may ask for again (§11: blocked work and failed deliveries, never as a loop). A
 * delivery's retry is a new card (§13). Held and stopped work offers nothing, and neither does an
 * open repair, whose worktree is not a retry's to run in.
 */
export function retryOffer(store: Store, work: StoreDoc): RetryOffer | undefined {
  if (isTerminal(work) || isHeld(work) || mandateOf(work).status === 'withdrawn') return undefined
  const id = String(work.id)
  const clean = (text: string): string => redact(text, [], []).slice(0, OFFER_CHARS)
  if (work.state === 'blocked') {
    const reason = String(work.blockedReason ?? '')
    if (!INTEGRATION_BLOCK.test(reason)) {
      const repair = ownerRepairOffer(store, work)
      return repair === undefined ? undefined : { kind: 'repair', reason: clean(repair.reason) }
    }
    if (!hostRunAgreed(store, String(work.repoId))) return undefined
    const failed = store.engines.get(integrationDocId(id))?.failed as { repairing?: boolean } | undefined
    if (failed?.repairing === true) return undefined
    const tasks = store.tasks.list({ workItemId: id })
    const ready = tasks.some(
      (task) => task.status === 'accepted' || task.status === 'integrated' || refusedTask(task),
    )
    return ready ? { kind: 'integration', reason: clean(reason) } : undefined
  }
  if (!OPEN_STATES.includes(String(work.state))) return undefined
  const doc = store.engines.get(deliveryDocId(id))
  if (doc?.stage !== 'declined' && doc?.stage !== 'failed') return undefined
  const kind = typeof doc.prCardId === 'string' ? 'pr' : 'push'
  const step = kind === 'pr' ? 'pull request' : 'push'
  const reason =
    doc.stage === 'failed'
      ? `The ${step} failed: ${String(doc.error ?? 'no detail')}`
      : `The ${step} card was ${String(doc.answer ?? 'declined')}`
  return { kind, reason: clean(reason) }
}

export type DeliveryStage =
  | 'local_complete'
  | 'moved'
  | 'no_change'
  | 'dropped'
  | 'push_card'
  | 'pushed'
  | 'pr_card'
  | 'pr_open'
  | 'ready'
  | 'declined'
  | 'failed'
  | 'closed'
  | 'merged'

export type DeliveryDeps = {
  store: Store
  effects: Effects
  dataDir: string
  policyText: string
  caps?: Caps
  run?: GhRun
  git?: GitExec
  now?: () => Date
  pollMs?: number
}

export class Delivery {
  readonly release: ReleaseDeps
  readonly #store: Store
  readonly #effects: Effects
  readonly #dataDir: string
  readonly #policyText: string
  readonly #caps: Caps
  readonly #pollMs: number
  readonly #closing = new AbortController()
  #running: Promise<void> = Promise.resolve()
  #queued = false

  constructor(deps: DeliveryDeps) {
    this.#store = deps.store
    this.#effects = deps.effects
    this.#dataDir = deps.dataDir
    this.#policyText = deps.policyText
    this.#caps = deps.caps ?? DEFAULT_CAPS
    this.#pollMs = deps.pollMs ?? POLL_MS
    this.release = {
      run: deps.run ?? defaultGhRun,
      store: deps.store,
      effects: deps.effects,
      now: deps.now ?? (() => new Date()),
      ...(deps.git !== undefined && { git: deps.git }),
      ...this.hooks,
    }
  }

  /** What the release routes need from here. */
  readonly hooks: Required<Pick<ReleaseDeps, 'pushSource' | 'onCardSettled' | 'cardBlocked'>> = {
    pushSource: (repoId, branch) => this.#pushSource(repoId, branch),
    onCardSettled: (card, outcome) => this.#onCardSettled(card, outcome),
    cardBlocked: (card) => this.#cardBlocked(card),
  }

  /** Runs a pass after any in flight, and at most one more. For the timer and for a settled card. */
  kick(): void {
    if (this.#queued) return
    this.#queued = true
    this.#running = this.#running.then(async () => {
      this.#queued = false
      await this.#pass().catch((error) => console.error(`[delivery] pass failed: ${String(error)}`))
    })
  }

  /**
   * The owner's retry. The check and the move share one transaction, so a second press finds
   * nothing to retry; a pass does the work, and it skips held work as it always does. The mandate
   * revalidates first (§10 "before every resume"). Nothing leaves the machine here: a delivery
   * only goes back to the step that opens a card.
   */
  retry(workItemId: string): RetryOutcome {
    const at = this.#now
    const outcome = this.#store.atomic((): RetryOutcome => {
      const work = this.#store.workItems.get(workItemId)
      if (work === undefined) return { status: 'missing' }
      if (mandateOf(work).status === 'withdrawn') return { status: 'refused', error: 'mandate_withdrawn' }
      if (isHeld(work)) return { status: 'refused', error: 'held' }
      const authority = revalidateWork(work, at, loadPolicy(this.#policyText).versionHash)
      if (!authority.ok) return { status: 'refused', error: `mandate_${authority.reason}` }
      const offer = retryOffer(this.#store, work)
      if (offer === undefined) {
        const waits = work.state === 'blocked' && !this.#agreed(work)
        return { status: 'refused', error: waits ? HOST_RUN_UNAGREED : 'nothing_to_retry' }
      }
      if (offer.kind === 'repair') {
        const outcome = ownerRetryRepair(this.#store, workItemId, at)
        if (outcome.status !== 'retrying') return outcome
        return { status: 'retrying', kind: 'repair' }
      }
      if (offer.kind === 'integration') this.#resumeIntegration(work, at)
      else this.#askAgain(workItemId, offer.kind)
      this.#workEvent(workItemId, 'retry_requested', { kind: offer.kind })
      return { status: 'retrying', kind: offer.kind }
    })
    if (outcome.status === 'retrying') this.kick()
    return outcome
  }

  #resumeIntegration(work: StoreDoc, at: string): void {
    for (const task of this.#store.tasks.list({ workItemId: String(work.id) }).filter(refusedTask)) {
      const { blockedReason: _reason, ...rest } = task
      const status = transition(TASK_MACHINE, String(task.status), 'integration_retry')
      this.#store.tasks.save({ ...rest, status, updatedAt: at })
    }
    const { blockedReason: _reason, ...rest } = work
    const state = transition(WORK_ITEM_MACHINE, String(work.state), 'resume_integrating')
    this.#store.workItems.save({ ...rest, state, updatedAt: at })
  }

  /** Back to the step before the card that was answered. The old card stays as it was settled. */
  #askAgain(workItemId: string, kind: 'push' | 'pr'): void {
    this.#write(workItemId, {
      stage: kind === 'pr' ? 'pushed' : 'local_complete',
      ...(kind === 'pr' ? { prCardId: undefined } : { pushCardId: undefined }),
      answer: undefined,
      prTarget: undefined,
      error: undefined,
      retryAt: undefined,
    })
  }

  /** Every work item once, after anything in flight. */
  async pass(): Promise<void> {
    this.#running = this.#running.then(() => this.#pass())
    await this.#running
  }

  /** Resolves when nothing is in flight or queued. */
  async idle(): Promise<void> {
    await this.#running
  }

  /** §20: stops a running check; the pass that ran it saves nothing, and the next start repeats it. */
  async close(): Promise<void> {
    this.#closing.abort()
    await this.#running
  }

  get #now(): string {
    return this.release.now().toISOString()
  }

  async #pass(): Promise<void> {
    if (processingOf(this.#store).paused) return
    for (const work of this.#store.workItems.list()) {
      if (this.#closing.signal.aborted) return
      if (isTerminal(work) || isHeld(work) || mandateOf(work).status === 'withdrawn') continue
      if (!OPEN_STATES.includes(String(work.state)) || typeof work.git_dir !== 'string') continue
      try {
        await this.#work(work)
      } catch (error) {
        if (this.#closing.signal.aborted) return
        if (error instanceof Later) continue
        // The worktree is in a state nothing here understands, and a person must say why.
        const detail = error instanceof Error ? error.message : String(error)
        const reason = redact(detail, this.#fingerprints(), [])
        this.#store.atomic(() => blockWork(this.#store, String(work.id), `integration: ${reason}`, this.#now))
      }
    }
  }

  async #work(work: StoreDoc): Promise<void> {
    const id = String(work.id)
    const tasks = this.#store.tasks.list({ workItemId: id })
    if (!tasks.some((task) => task.status === 'accepted' || task.status === 'integrated')) return
    // Merging runs the repo's commands, so this waits with the launches, and a later pass goes on.
    if (!this.#agreed(work)) return
    // §14: the checks are the ones pinned at admission, as the launch gate holds them to be.
    const pinned = (work.pin as { profileHash?: string } | undefined)?.profileHash
    const current = repoFields(this.#store, String(work.repoId), this.#policyText).pin as {
      profileHash?: string
    }
    if (pinned !== undefined && pinned !== current.profileHash) {
      const reason = 'repo_profile_changed: this work was admitted under other commands'
      this.#store.atomic(() => blockWork(this.#store, id, reason, this.#now))
      return
    }
    await this.#integrate(work, tasks)
    const integration = this.#store.engines.get(integrationDocId(id))
    if (integration === undefined) return
    this.#reconcile(id, String(integration.head))
    const result = workResultOf(this.#store, id)
    if (!result.complete) return
    await this.#deliver(work, integration)
  }

  // ── Integration ────────────────────────────────────────────────────────────────────────────

  async #integrate(work: StoreDoc, tasks: readonly StoreDoc[]): Promise<void> {
    const doc = await this.#integrationDoc(work)
    if (doc === undefined) return
    const worktree = String(doc.worktree)
    let state = stateOf(doc)
    const open = state.failed?.repairing === true ? this.#repairTaskOf(tasks, state) : undefined
    if (open?.status === 'accepted') {
      state = repairSettled(state)
      this.#store.atomic(() => this.#integrated(String(open.id)))
    }
    if (open?.status === 'cancelled') {
      const root = tasks.find((task) => task.id === open.repairOf)
      const reason = `its repair ended: ${String(open.cancelledReason ?? 'cancelled')}`
      if (root !== undefined) this.#store.atomic(() => blockTask(this.#store, root, reason, this.#now))
      return
    }
    const run = await runIntegration(this.#controller(work, worktree), state, controllerTasks(tasks))
    if (this.#closing.signal.aborted) return
    this.#store.atomic(() => {
      const fresh = this.#store.engines.get(doc.id as string) as StoreDoc
      const { head, integrated, combined, failed, verifying } = run.state
      const { combined: _combined, failed: _failed, verifying: _verifying, ...rest } = fresh
      this.#store.engines.save({
        ...rest,
        head,
        integrated,
        ...(combined !== undefined && { combined: combined as unknown as Json }),
        ...(failed !== undefined && { failed: failed as unknown as Json }),
        ...(verifying !== undefined && { verifying }),
        updatedAt: this.#now,
      })
      this.#apply(work, doc, run.effect)
    })
  }

  #agreed(work: StoreDoc): boolean {
    return hostRunAgreed(this.#store, String(work.repoId))
  }

  /** The integration record, with its worktree made the first time a task is ready to merge. */
  async #integrationDoc(work: StoreDoc): Promise<StoreDoc | undefined> {
    const id = String(work.id)
    const known = this.#store.engines.get(integrationDocId(id))
    if (known !== undefined) return known
    const gitDir = String(work.git_dir)
    const base = String(work.base_sha)
    const branch = integrationBranch(id)
    const worktree = join(this.#dataDir, 'work', `integration-${id}`)
    await new Worktrees(gitDir).add({ path: worktree, branch, baseSha: base, createBranch: true })
    const repo = this.#repoOf(work)
    const bootstrap = Array.isArray(repo?.bootstrap) ? repo.bootstrap.map(String) : []
    for (const [index, command] of bootstrap.entries()) {
      if (!this.#agreed(work)) return undefined
      const [cmd = '', ...args] = argvOf(command)
      const spec = {
        name: `bootstrap_${index + 1}`,
        cmd,
        args,
        cwd: worktree,
        env: this.#checkEnv(id, worktree),
      }
      const outcome = await runCheck(spec, this.#closing.signal)
      if (this.#closing.signal.aborted) return undefined
      if (outcome.status !== 'passed') {
        const tail = redact(outcome.logTail, this.#fingerprints(), [])
        const reason = `bootstrap_failed: ${command}: ${tail.slice(-400)}`
        this.#store.atomic(() => {
          const before = this.#store.workItems.get(id)?.state
          blockWork(this.#store, id, reason, this.#now)
          if (before === 'blocked' || this.#store.workItems.get(id)?.state !== 'blocked') return
          // One line in the chat for this block (§12.7): the person sees why nothing moves.
          const blocks = this.#store.events
            .read(`work:${id}`)
            .filter((event) => event.type === 'work_blocked')
          const cause = `bootstrap_failed/${id}/${blocks.length}`
          const said = cutAtWord(tail.trim(), 200)
          this.#effects.enqueue('note', `note:${cause}`, {
            workItemId: id,
            cause,
            text: `The integration could not start: ${command} failed${said === '' ? '.' : `: ${said}`}`,
            at: this.#now,
          })
        })
        return undefined
      }
    }
    // No agent has been here, so all that is dirty is the machine's, an interrupted run's included.
    if (bootstrap.length > 0) await recordBootstrapOutput(worktree, {})
    const doc: StoreDoc = {
      id: integrationDocId(id),
      workItemId: id,
      repoId: work.repoId ?? null,
      branch,
      worktree,
      gitDir,
      head: base,
      integrated: {},
      updatedAt: this.#now,
    }
    this.#store.atomic(() => this.#store.engines.save(doc))
    return doc
  }

  /** Decision #25: the repo's commands run with a scrubbed env and no tools token. */
  #checkEnv(workItemId: string, worktree: string): Record<string, string> {
    const tempDir = join(this.#dataDir, 'tmp', `integration-${workItemId}`)
    mkdirSync(tempDir, { recursive: true })
    return buildAgentEnv({
      inherited: repoInherited(),
      home: tempDir,
      attempt: {
        MEC_WORKTREE: worktree,
        TMPDIR: tempDir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
  }

  #controller(work: StoreDoc, worktree: string): ControllerDeps {
    const id = String(work.id)
    const gitDir = String(work.git_dir)
    const repo = this.#repoOf(work)
    const registered = String(work.pin === undefined ? repo?.url : (work.pin as { url?: string }).url)
    return {
      git: {
        head: () => headSha(worktree),
        branchHead: async (branch) => {
          const read = await git(['rev-parse', '-q', '--verify', `refs/heads/${branch}`], {
            cwd: gitDir,
            allowFailure: true,
          })
          return read.code === 0 ? read.stdout.trim() : undefined
        },
        merge: async (branch, message) => {
          const paths = await clearMergePath({ worktree, taskBranch: branch })
          if (paths.length > 0) {
            const body = { branch, count: paths.length, paths: paths.slice(0, CLEARED_PATHS) }
            this.#store.atomic(() => this.#workEvent(id, 'integration_output_cleared', body))
          }
          return mergeIntoIntegration({
            gitDir,
            worktree,
            taskBranch: branch,
            message,
            identity: await commitIdentity(registered, gitDir),
          })
        },
        prepareRepair: (paths) => prepareMidMergeRepair({ sourceWorktree: worktree, conflictPaths: paths }),
      },
      checks: () => this.#combinedChecks(work, repo, worktree),
    }
  }

  /** The registered checks, run where the merge is. A close voids them: nothing is saved. */
  async #combinedChecks(
    work: StoreDoc,
    repo: StoreDoc | undefined,
    worktree: string,
  ): Promise<IntegrationCheck[]> {
    const workItemId = String(work.id)
    const checks = (Array.isArray(repo?.checks) ? repo.checks : []) as { name: string; cmd: string }[]
    const fingerprints = this.#fingerprints()
    const outcomes: IntegrationCheck[] = []
    for (const check of checks) {
      // Nothing is saved, as with a close: the next pass finds a head with no verdict and checks it.
      if (!this.#agreed(work)) throw new Later('the owner withdrew the agreement')
      const [cmd = '', ...args] = argvOf(check.cmd)
      const env = this.#checkEnv(workItemId, worktree)
      const outcome = await runCheck(
        { name: check.name, cmd, args, cwd: worktree, env },
        this.#closing.signal,
      )
      outcomes.push({
        name: check.name,
        status: outcome.status,
        logTail: redact(outcome.logTail, fingerprints, []),
      })
    }
    return outcomes
  }

  #fingerprints(): Parameters<typeof redact>[1] {
    return this.#store.slots
      .list()
      .flatMap((slot) => (slot.fingerprint === undefined ? [] : [slot.fingerprint])) as never
  }

  /** What a run means for the tasks. Runs in the transaction that saved its state. */
  #apply(work: StoreDoc, integration: StoreDoc, effect: IntegrationEffect): void {
    const id = String(work.id)
    const at = this.#now
    const task = (taskId: string | undefined): StoreDoc | undefined =>
      taskId === undefined ? undefined : this.#store.tasks.get(taskId)
    if (effect.kind === 'integrated') {
      this.#integrated(effect.taskId)
      this.#workEvent(id, 'task_integrated', { taskId: effect.taskId, sha: effect.sha })
    }
    if (effect.kind === 'failed') {
      this.#workEvent(id, 'combined_checks_failed', { taskId: effect.taskId, sha: effect.sha })
    }
    if (effect.kind === 'conflict') {
      this.#workEvent(id, 'integration_conflict', { taskId: effect.taskId, paths: effect.conflictedPaths })
    }
    if (effect.kind === 'refused') {
      const target = task(effect.taskId)
      if (target?.status === 'accepted') blockTask(this.#store, target, effect.reason, at)
      else blockWork(this.#store, id, effect.reason, at)
    }
    if (effect.kind === 'repair') {
      const root = task(effect.taskId) as StoreDoc
      openRepairTask(this.#store, this.#effects, this.#caps, {
        root,
        evidence: integrationEvidence(effect),
        worktree: String(integration.worktree),
        branch: String(integration.branch),
        id: `task_${randomBytes(6).toString('hex')}`,
        at,
      })
    }
  }

  /** Integration makes a task `integrated` (§10). Already there is already there. */
  #integrated(taskId: string): void {
    const task = this.#store.tasks.get(taskId)
    if (task === undefined || !canTransition(TASK_MACHINE, String(task.status), 'integrated')) return
    const status = transition(TASK_MACHINE, String(task.status), 'integrated')
    this.#store.tasks.save({ ...task, status, updatedAt: this.#now })
  }

  #repairTaskOf(tasks: readonly StoreDoc[], state: IntegrationState): StoreDoc | undefined {
    return tasks.filter((task) => task.repairOf === state.failed?.taskId).at(-1)
  }

  #repoOf(work: StoreDoc): StoreDoc | undefined {
    return typeof work.repoId === 'string' ? this.#store.engines.get(work.repoId) : undefined
  }

  #workEvent(workItemId: string, type: string, body: Record<string, Json>): void {
    const stream = `work:${workItemId}`
    const seq = (this.#store.events.read(stream).at(-1)?.seq ?? 0) + 1
    const at = this.#now
    this.#store.events.append(stream, { stream, seq, at, type, body: { workItemId, ...body, at } })
  }

  // ── The result path ────────────────────────────────────────────────────────────────────────

  #doc(workItemId: string): StoreDoc | undefined {
    return this.#store.engines.get(deliveryDocId(workItemId))
  }

  /** Sets these fields on the stored doc as it is now. `undefined` removes one. */
  #patch(workItemId: string, fields: Record<string, Json | undefined>): void {
    this.#store.atomic(() => this.#write(workItemId, fields))
  }

  /** `#patch` for a caller already in a transaction. */
  #write(workItemId: string, fields: Record<string, Json | undefined>): void {
    const doc = this.#doc(workItemId)
    if (doc === undefined) return
    const next: StoreDoc = { ...doc, updatedAt: this.#now }
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined) delete next[name]
      else next[name] = value
    }
    this.#store.engines.save(next)
  }

  /** §13, §15: the integration head moved past what the delivery speaks for. */
  #reconcile(workItemId: string, head: string): void {
    const doc = this.#doc(workItemId)
    if (doc === undefined || doc.head === head) return
    for (const card of [doc.pushCardId, doc.prCardId]) {
      if (typeof card === 'string') staleCard(this.release, card, head)
    }
    this.#patch(workItemId, {
      head,
      stage: 'moved',
      pushCardId: undefined,
      prCardId: undefined,
      limit: undefined,
      error: undefined,
      retryAt: undefined,
      pollAt: undefined,
      ci: undefined,
      ciAt: undefined,
    })
  }

  async #deliver(work: StoreDoc, integration: StoreDoc): Promise<void> {
    const id = String(work.id)
    const known = this.#doc(id)
    if (known === undefined || known.stage === 'moved') this.#recordResult(work, integration)
    const doc = this.#doc(id) as StoreDoc
    if (typeof doc.retryAt === 'string' && doc.retryAt > this.#now) return
    const { stage } = doc
    if (stage === 'local_complete' || stage === 'moved') await this.#openPush(work, doc)
    else if (stage === 'pushed') await this.#openPr(work, doc)
    else if (stage === 'pr_open' || stage === 'ready') await this.#observe(work, doc)
  }

  /** The reducer's output, once per head: an event for the record, a note for the next turn (§6). */
  #recordResult(work: StoreDoc, integration: StoreDoc): void {
    const id = String(work.id)
    const result = workResultOf(this.#store, id)
    const head = String(result.head)
    const branch = String(integration.branch)
    const checks = result.checks.map((check) => `${check.name} ${check.status}`).join(', ')
    const text = `Locally complete: ${result.integrated.length} task(s) on ${branch} at ${head}; ${checks}. Nothing has left this machine.`
    this.#store.atomic(() => {
      const fields: StoreDoc = { workItemId: id, head, branch, summary: text, updatedAt: this.#now }
      const doc = this.#doc(id)
      this.#store.engines.save({
        ...(doc ?? { id: deliveryDocId(id), repoId: work.repoId ?? null }),
        ...fields,
        stage: 'local_complete',
      })
      this.#workEvent(id, 'local_result', {
        head,
        branch,
        summary: text,
        result: result as unknown as Json,
      })
      this.#effects.enqueue('note', `note:local_result/${id}/${head}`, {
        workItemId: id,
        cause: `local_result/${id}/${head}`,
        text,
        at: this.#now,
      })
    })
  }

  /** Holds a refused step for a while, with its reason on the record. */
  #hold(workItemId: string, error: unknown): void {
    const refusal = refusalOf(error)
    if (refusal === undefined) throw error
    const retryAt = new Date(this.release.now().getTime() + RETRY_MS).toISOString()
    this.#patch(workItemId, { error: `${refusal.error}: ${refusal.detail}`, retryAt })
  }

  async #openPush(work: StoreDoc, doc: StoreDoc): Promise<void> {
    const id = String(work.id)
    const repoId = String(work.repoId)
    const branch = String(doc.branch)
    const head = String(doc.head)
    try {
      const { repo } = await pushTarget(this.release, repoId, branch)
      const range = `${String(work.base_sha)}..${head}`
      const changed = await gitLines(['diff', '--name-only', range], { cwd: String(work.git_dir) })
      if (changed.length === 0) {
        this.#patch(id, { stage: 'no_change', repo })
        return
      }
      // MEC's own open PR is not a duplicate of the head it is about to carry.
      if (doc.prNumber === undefined) {
        const defaultBranch = String(work.default_branch)
        const { yieldTo } = await yieldCheck(this.release.run, repo, changed, {
          defaultBranch,
          ownBranch: branch,
        })
        if (yieldTo !== null) {
          this.#patch(id, { stage: 'dropped', repo, yieldTo })
          this.#store.atomic(() => this.#workEvent(id, 'delivery_dropped', { yieldTo }))
          return
        }
      }
      const card = await openPushCard(this.release, { repoId, branch, headSha: head, workItemId: id })
      this.#patch(id, { stage: 'push_card', repo, pushCardId: card.confirmationId, error: undefined })
    } catch (error) {
      this.#hold(id, error)
    }
  }

  async #openPr(work: StoreDoc, doc: StoreDoc): Promise<void> {
    const id = String(work.id)
    if (doc.prNumber !== undefined) {
      this.#patch(id, { stage: 'pr_open' })
      return
    }
    const request = this.#request(work)
    try {
      const card = await createPrBehindCard(this.release, {
        repo: String(doc.repo),
        branch: String(doc.branch),
        headSha: String(doc.head),
        title: titleOf(request),
        body: this.#prBody(work, doc, request),
        workItemId: id,
      })
      this.#patch(id, { stage: 'pr_card', prCardId: card.confirmationId, error: undefined })
    } catch (error) {
      this.#hold(id, error)
    }
  }

  #request(work: StoreDoc): string {
    return String(this.#store.messages.get(mandateOf(work).originMessageId)?.text ?? '')
  }

  #prBody(work: StoreDoc, doc: StoreDoc, request: string): string {
    const id = String(work.id)
    const result = workResultOf(this.#store, id)
    const tasks = this.#store.tasks.list({ workItemId: id }).filter((task) => task.repairOf === undefined)
    const shaOf = new Map(result.integrated.map((task) => [task.id, task.sha]))
    const attempts = this.#store.attempts.list({ workItemId: id })
    const slots = [...new Set(attempts.map((attempt) => String(attempt.slotId)))]
    return buildPrBody({
      request,
      tasks: tasks
        .filter((task) => task.status === 'integrated')
        .map((task) => {
          const sha = shaOf.get(String(task.id))
          return {
            id: String(task.localKey ?? task.id),
            role: String(task.role),
            ...(sha !== undefined && { acceptedSha: sha }),
          }
        }),
      integrationSha: String(doc.head),
      checks: result.checks,
      findings: tasks.flatMap((task) =>
        Array.isArray(task.findings)
          ? (task.findings as { text: string; disposition: string }[]).map(
              (finding) => `${finding.text} (${finding.disposition})`,
            )
          : [],
      ),
      decisions: [
        ...result.excluded.map((task) => `Excluded ${task.id}: ${task.reason}`),
        ...(slots.length > 0 ? [`Slots: ${slots.join(', ')}`] : []),
      ],
    })
  }

  /** Reads GitHub. Nothing here is taken from an API answer to an action of ours (#12, §14). */
  async #observe(work: StoreDoc, doc: StoreDoc): Promise<void> {
    const id = String(work.id)
    if (typeof doc.pollAt === 'string' && doc.pollAt > this.#now) return
    this.#patch(id, { pollAt: new Date(this.release.now().getTime() + this.#pollMs).toISOString() })
    const repo = String(doc.repo)
    const branch = String(doc.branch)
    const prNumber = Number(doc.prNumber)
    const { run } = this.release
    const pr = await readPr(run, repo, prNumber)
    if (pr === undefined) return
    if (pr.state === 'MERGED') return this.#merged(work, repo, branch)
    if (pr.state !== 'OPEN') {
      movePrFlow(this.release, repo, branch, 'pr_closed')
      this.#patch(id, { stage: 'closed', ready: undefined })
      return
    }
    const notReady = (seen?: { ci: string; ciAt: string }): void =>
      this.#patch(id, { stage: 'pr_open', limit: undefined, ci: seen?.ci, ciAt: seen?.ciAt })
    if (pr.headRefOid !== doc.head) {
      movePrFlow(this.release, repo, branch, 'target_moved')
      return notReady()
    }
    const target = await remoteHead(run, repo, String(work.default_branch))
    if (target !== undefined && doc.targetSha !== target) {
      this.#patch(id, { targetSha: target })
      if (doc.targetSha !== undefined) {
        // §14: required checks speak for the old target. The next read decides again.
        movePrFlow(this.release, repo, branch, 'target_moved')
        releaseEvent(this.release, repo, branch, 'target_moved', { target })
        return notReady()
      }
    }
    const { verdict } = await readRequiredChecks(run, repo, prNumber)
    // What this read saw, for the page: it says nothing about a head read later.
    const seen = { ci: verdict, ciAt: this.#now }
    if (verdict === 'green' || verdict === 'no_required_checks') {
      movePrFlow(this.release, repo, branch, 'ci_passed')
      if (doc.stage !== 'ready') releaseEvent(this.release, repo, branch, 'pr_ready', { prNumber, verdict })
      // Decision #34: ready on local checks, with the limit stated. The merge card still holds.
      this.#patch(id, { stage: 'ready', limit: verdict === 'green' ? undefined : verdict, ...seen })
      // After the patch: this frame makes the page read the stage back.
      if (doc.stage !== 'ready') workEvent(this.release, id, 'pr_ready', { prNumber, verdict })
      return
    }
    if (verdict === 'ci_failed') movePrFlow(this.release, repo, branch, 'ci_failed')
    notReady(seen)
  }

  /** §14: only GitHub's own state says merged, and #29 ends the work there. */
  #merged(work: StoreDoc, repo: string, branch: string): void {
    const id = String(work.id)
    movePrFlow(this.release, repo, branch, 'ci_passed')
    movePrFlow(this.release, repo, branch, 'merged_on_github')
    this.#patch(id, { stage: 'merged' })
    this.#store.atomic(() => {
      const fresh = this.#store.workItems.get(id) as StoreDoc
      if (!canTransition(WORK_ITEM_MACHINE, String(fresh.state), 'work_done')) return
      const state = transition(WORK_ITEM_MACHINE, String(fresh.state), 'work_done')
      this.#store.workItems.save({ ...fresh, state, updatedAt: this.#now })
    })
  }

  // ── Cards ──────────────────────────────────────────────────────────────────────────────────

  #pushSource(repoId: string, branch: string): { gitDir: string } | undefined {
    const work = this.#store.workItems
      .list()
      .find((doc) => doc.repoId === repoId && integrationBranch(String(doc.id)) === branch)
    return typeof work?.git_dir === 'string' ? { gitDir: work.git_dir } : undefined
  }

  /** §10, §12: a stop withdraws the work's cards and a hold keeps them waiting. */
  #cardBlocked(card: StoreDoc): CardBlock | undefined {
    const works = this.#worksOfCard(card)
    if (works.some((work) => mandateOf(work).status === 'withdrawn')) {
      return { reason: 'mandate_withdrawn', withdraw: true }
    }
    return works.some(isHeld) ? { reason: 'held', withdraw: false } : undefined
  }

  /**
   * The work a card would act for. A merge names its PR, since a head name carries no owner. A PR
   * card names no repository id, so a same-named branch elsewhere errs on the side of waiting.
   */
  #worksOfCard(card: StoreDoc): StoreDoc[] {
    const payload = card.payload as { repoId?: string; repo?: string; branch?: string; prNumber?: number }
    if (card.cls === 'pr_merge') {
      const doc = this.#store.engines
        .list()
        .find(
          (row) =>
            String(row.id).startsWith('delivery/') &&
            row.repo === payload.repo &&
            row.prNumber === payload.prNumber,
        )
      const work = doc === undefined ? undefined : this.#store.workItems.get(String(doc.workItemId))
      return work === undefined ? [] : [work]
    }
    return this.#store.workItems
      .list()
      .filter(
        (work) =>
          integrationBranch(String(work.id)) === payload.branch &&
          (payload.repoId === undefined || work.repoId === payload.repoId),
      )
  }

  #onCardSettled(card: StoreDoc, outcome: CardOutcome): void {
    const payload = card.payload as { repo?: string; branch?: string; prNumber?: number }
    const doc = this.#store.engines
      .list()
      .find(
        (row) =>
          String(row.id).startsWith('delivery/') &&
          row.branch === payload.branch &&
          (row.repo === undefined || row.repo === payload.repo),
      )
    if (doc === undefined) return
    // A branch name alone proves nothing: another PR or a card opened by hand can share it.
    if (card.cls === 'push' && card.id !== doc.pushCardId) return
    if (card.cls === 'pr_create' && card.id !== doc.prCardId) return
    if (card.cls === 'pr_merge' && payload.prNumber !== doc.prNumber) return
    const id = String(doc.workItemId)
    if (card.cls === 'push') this.#afterPush(id, doc, outcome)
    if (card.cls === 'pr_create') this.#afterPrCreate(id, outcome)
    if (card.cls === 'pr_merge' && outcome.merged === true) {
      this.#patch(id, { stage: 'merged' })
      const work = this.#store.workItems.get(id)
      if (work !== undefined) this.#merged(work, String(doc.repo), String(doc.branch))
    }
    this.kick()
  }

  #afterPush(id: string, doc: StoreDoc, outcome: CardOutcome): void {
    if (outcome.pushed === true) {
      if (outcome.headSha === doc.head) this.#patch(id, { stage: 'pushed', error: undefined })
      return
    }
    // A failed push spent its approval (§13); a retry is a new card, never a replay.
    if (outcome.status === 'approved')
      this.#patch(id, { stage: 'failed', error: outcome.error ?? 'push failed' })
    else if (outcome.status !== 'stale') this.#declined(id, outcome)
  }

  /** §13: the local result stands, the PR target stays pending, and only the owner's `retry` asks again. */
  #declined(id: string, outcome: CardOutcome): void {
    this.#patch(id, { stage: 'declined', answer: outcome.status, prTarget: 'pending' })
  }

  #afterPrCreate(id: string, outcome: CardOutcome): void {
    if (outcome.prNumber !== undefined) {
      this.#patch(id, {
        stage: 'pr_open',
        prNumber: outcome.prNumber,
        ...(outcome.prUrl !== undefined && { prUrl: outcome.prUrl }),
        error: undefined,
      })
      return
    }
    if (outcome.status === 'approved') {
      this.#patch(id, { stage: 'failed', error: outcome.error ?? 'gh pr create failed' })
    } else if (outcome.status !== 'stale') this.#declined(id, outcome)
  }
}

function stateOf(doc: StoreDoc): IntegrationState {
  return {
    head: String(doc.head),
    integrated: (doc.integrated ?? {}) as Record<string, string>,
    ...(doc.combined !== undefined && { combined: doc.combined as IntegrationState['combined'] & object }),
    ...(doc.failed !== undefined && { failed: doc.failed as IntegrationState['failed'] & object }),
    ...(typeof doc.verifying === 'string' && { verifying: doc.verifying }),
  }
}

/** The queue's view: repair tasks finish a merge, they are not merged themselves. */
function controllerTasks(tasks: readonly StoreDoc[]): ControllerTask[] {
  return tasks
    .filter((task) => task.repairOf === undefined && task.status !== 'cancelled')
    .map((task) => ({
      taskId: String(task.id),
      dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : [],
      basePolicy: task.basePolicy === 'contract' ? 'contract' : 'integration',
      accepted: task.status === 'accepted' || task.status === 'integrated',
      branch: String(task.acceptedBranch ?? ''),
      head: String(task.acceptedHead ?? ''),
    }))
}

function integrationEvidence(effect: Extract<IntegrationEffect, { kind: 'repair' }>): string {
  if (effect.reason === 'conflict') {
    const paths = (effect.conflictedPaths ?? []).join(', ')
    return `Merging task ${effect.taskId} conflicted in: ${paths}. This worktree is mid-merge with both sides on disk. Resolve every conflict, leave the result in the worktree, and MEC completes the merge.`
  }
  const failing = effect.failing ?? []
  return repairEvidence({
    verdict: 'repair',
    reason: 'checks_failed',
    head: String(effect.sha),
    failing,
    findings: [],
  })
}

const titleOf = (request: string): string => {
  const first = request.trim().split('\n')[0] ?? ''
  return first.length > TITLE_CHARS ? `${first.slice(0, TITLE_CHARS - 1)}…` : first || 'MEC delivery'
}
