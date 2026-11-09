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
  deliveryStopped,
  TASK_MACHINE,
  transition,
  WORK_ITEM_MACHINE,
} from '@mec/domain'
import {
  clearMergePath,
  git,
  gitLines,
  headSha,
  isMidMerge,
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
  profileChanged,
  RepoAdmissionError,
  repairEvidence,
  revalidateWork,
  workResultOf,
} from '@mec/meta'
import { loadPolicy } from '@mec/policy'
import { buildAgentEnv, runCheck } from '@mec/runtime'
import { redact } from '@mec/slots'
import { argvOf, commitIdentity, repoInherited } from './attempt-launch'
import { reasonWords } from './reason-words'
import {
  buildPrBody,
  type CardBlock,
  type CardOutcome,
  createPrBehindCard,
  defaultGhRun,
  fetchGitHubBranches,
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
/** The refusal of a retry on work admitted under other commands, in the gates' own code. */
const PROFILE_CHANGED = 'repo_profile_changed'
/** How many cleared paths an event names; the count says the rest. */
const CLEARED_PATHS = 50

/** How many conflicted paths an update's words name; the rest are counted. */
const UPDATE_PATHS = 10

/**
 * `repair`: the owner's Try again on blocked work, one fresh repair attempt (owner ruling 2026-11-07).
 * `update`: Bring up to date, for an open pull request that is behind its target or whose head
 * moved on GitHub (owner, 9 November 2026).
 */
export type RetryKind = 'integration' | 'push' | 'pr' | 'repair' | 'update'
export type RetryOffer = { kind: RetryKind; reason: string }
export type RetryOutcome =
  | { status: 'retrying'; kind: RetryKind }
  | { status: 'missing' }
  | { status: 'refused'; error: string }

/** An accepted task integration refused. Its head stands, so a retry merges it and starts nothing. */
const refusedTask = (task: StoreDoc): boolean =>
  task.status === 'blocked' && typeof task.acceptedHead === 'string'

/**
 * Work admitted under commands that have since changed (§14, decision #41): every retry of it is
 * refused, by the integration step or the launch gate, so none is offered. The same question
 * those gates ask. A repository that is no longer registered is the gates' refusal, not this one.
 */
export function admittedUnderOtherCommands(store: Store, work: StoreDoc): boolean {
  if (typeof work.repoId !== 'string') return false
  try {
    return profileChanged(store, work.repoId, work)
  } catch (error) {
    if (error instanceof RepoAdmissionError) return false
    throw error
  }
}

/**
 * What a person may ask for again (§11: blocked work and failed deliveries, never as a loop). A
 * delivery's retry is a new card (§13). Held and stopped work offers nothing, and neither does an
 * open repair, whose worktree is not a retry's to run in, nor work whose commands changed since it
 * was admitted, which no retry can deliver.
 */
export function retryOffer(store: Store, work: StoreDoc): RetryOffer | undefined {
  if (isTerminal(work) || isHeld(work) || mandateOf(work).status === 'withdrawn') return undefined
  if (admittedUnderOtherCommands(store, work)) return undefined
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
  if (doc === undefined) return undefined
  const stop = deliveryStopped(doc)
  if (stop !== undefined) return { kind: stop.step, reason: clean(stoppedWords(doc)) }
  // Bringing up to date runs the repository's checks here, so it waits for the agreement too.
  const update = updateWords(doc, String(work.default_branch ?? 'the target branch'))
  if (update === undefined || !hostRunAgreed(store, String(work.repoId))) return undefined
  return { kind: 'update', reason: clean(update) }
}

/** The head GitHub shows that MEC did not adopt, in words (owner, 9 November 2026). */
export function movedWords(doc: StoreDoc): string | undefined {
  const sha = (doc.headMoved as { sha?: unknown } | undefined)?.sha
  return typeof sha === 'string'
    ? `The branch changed on GitHub (now ${sha.slice(0, 7)}). MEC won’t merge commits it didn’t check.`
    : undefined
}

/**
 * Why an open pull request needs bringing up to date, or what the last try said: undefined when
 * it does not, or while a try is on its way. A try that failed says so first, since it is the
 * newer fact and the cause it answered still stands.
 */
export function updateWords(doc: StoreDoc, target: string): string | undefined {
  if (doc.stage !== 'pr_open' && doc.stage !== 'ready') return undefined
  const moved = movedWords(doc)
  if (moved === undefined && doc.behind !== true) return undefined
  const update = doc.update as
    | { status?: string; paths?: string[]; failing?: string[]; sha?: string; reason?: string }
    | undefined
  const trying = `Bringing it up to date with ${target}`
  switch (update?.status) {
    case 'requested':
      return undefined
    case 'conflict': {
      const paths = update.paths ?? []
      const more = paths.length > UPDATE_PATHS ? ` and ${paths.length - UPDATE_PATHS} more` : ''
      return `${trying} conflicted in ${paths.slice(0, UPDATE_PATHS).join(', ')}${more}. Nothing was pushed.`
    }
    case 'failed':
      return update.failing !== undefined
        ? `${trying} failed the checks on ${String(update.sha).slice(0, 7)}: ${update.failing.join(', ')}. Nothing was pushed.`
        : `${trying} could not run: ${reasonWords(String(update.reason ?? 'no detail'))}. Nothing was pushed.`
    case 'current':
      return `It is already up to date with ${target} here, so there is nothing to push.`
    default:
      return moved ?? `The pull request is behind ${target}.`
  }
}

/** What stopped a delivery short, in words: the card's answer, or the step's failure. */
export function stoppedWords(doc: StoreDoc): string {
  const step = typeof doc.prCardId === 'string' ? 'pull request' : 'push'
  return doc.stage === 'failed'
    ? `The ${step} failed: ${String(doc.error ?? 'no detail')}`
    : `The ${step} card was ${String(doc.answer ?? 'declined')}`
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
        if (admittedUnderOtherCommands(this.#store, work)) {
          return { status: 'refused', error: PROFILE_CHANGED }
        }
        const waits = work.state === 'blocked' && !this.#agreed(work)
        return { status: 'refused', error: waits ? HOST_RUN_UNAGREED : 'nothing_to_retry' }
      }
      if (offer.kind === 'repair') {
        const outcome = ownerRetryRepair(this.#store, workItemId, at)
        if (outcome.status !== 'retrying') return outcome
        return { status: 'retrying', kind: 'repair' }
      }
      if (offer.kind === 'integration') this.#resumeIntegration(work, at)
      else if (offer.kind === 'update') this.#write(workItemId, { update: { status: 'requested', at } })
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
    if (profileChanged(this.#store, String(work.repoId), work)) {
      const reason = 'repo_profile_changed: this work was admitted under other commands'
      this.#store.atomic(() => blockWork(this.#store, id, reason, this.#now))
      return
    }
    // An update a close or a kill cut short leaves its trial merge in the worktree: put it back
    // first, or the integration would take that unchecked head for a move and check it as one.
    const interrupted = this.#store.engines.get(integrationDocId(id))
    if (interrupted?.updating !== undefined) await this.#putBack(interrupted)
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
      ciSince: undefined,
      ciQueued: undefined,
      // What GitHub showed speaks for the old head; the new one is pushed, then read again.
      prHead: undefined,
      headMoved: undefined,
      behind: undefined,
      update: undefined,
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
    else if (stage === 'pr_open' || stage === 'ready') {
      const update = doc.update as { status?: string } | undefined
      if (update?.status === 'requested') await this.#bringUpToDate(work, integration)
      else await this.#observe(work, doc)
    }
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
    type Seen = { ci: string; ciAt: string; ciSince?: string; ciQueued?: true }
    const notReady = (seen?: Seen): void =>
      this.#patch(id, {
        stage: 'pr_open',
        limit: undefined,
        ci: seen?.ci,
        ciAt: seen?.ciAt,
        ciSince: seen?.ciSince,
        ciQueued: seen?.ciQueued,
      })
    // Behind its target: GitHub will not merge it under strict checks, so Bring up to date is offered.
    const behind = pr.mergeStateStatus === 'BEHIND'
    if (behind !== (doc.behind === true)) this.#patch(id, { behind: behind ? true : undefined })
    // The head the delivery speaks for: the one MEC pushed, or a GitHub update MEC adopted (#c).
    const speaksFor = String(doc.prHead ?? doc.head)
    if (pr.headRefOid !== speaksFor) {
      // Only a listed prflow row moves (ci_green to ci_pending); from pr_open this changes nothing.
      movePrFlow(this.release, repo, branch, 'target_moved')
      if (!(await this.#adoptMoved(work, doc, speaksFor, pr.headRefOid))) return notReady()
    } else if (doc.headMoved !== undefined) {
      this.#patch(id, { headMoved: undefined })
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
    const { verdict, checks } = await readRequiredChecks(run, repo, prNumber)
    // What this read saw, for the page: it says nothing about a head read later. A wait on GitHub
    // keeps when it began, and says whether any required check has started (owner, 9 November 2026).
    const waiting = verdict === 'ci_pending'
    const since = doc.ci === 'ci_pending' && typeof doc.ciSince === 'string' ? doc.ciSince : this.#now
    const started = checks.some((row) => String(row.state).toUpperCase() === 'IN_PROGRESS')
    const seen: Seen = {
      ci: verdict,
      ciAt: this.#now,
      ...(waiting && { ciSince: since }),
      ...(waiting && !started && { ciQueued: true as const }),
    }
    if (verdict === 'green' || verdict === 'no_required_checks') {
      movePrFlow(this.release, repo, branch, 'ci_passed')
      if (doc.stage !== 'ready') releaseEvent(this.release, repo, branch, 'pr_ready', { prNumber, verdict })
      // Decision #34: ready on local checks, with the limit stated. The merge card still holds.
      this.#patch(id, {
        stage: 'ready',
        limit: verdict === 'green' ? undefined : verdict,
        ...seen,
        ciSince: undefined,
        ciQueued: undefined,
      })
      // After the patch: this frame makes the page read the stage back.
      if (doc.stage !== 'ready') workEvent(this.release, id, 'pr_ready', { prNumber, verdict })
      return
    }
    if (verdict === 'ci_failed') movePrFlow(this.release, repo, branch, 'ci_failed')
    notReady(seen)
  }

  /**
   * The pull request's head on GitHub is not the one the delivery speaks for (owner, 9 November
   * 2026). It is adopted without asking only when it is GitHub's Update branch and nothing else:
   * the head MEC speaks for is one of its parents, every other parent is on the target branch, and
   * its changes against the target are exactly the ones MEC checked, file for file. Then the new
   * head is recorded with why, and this read goes on to its checks. Anything else is said in words
   * and nothing merges. A head is judged once: the next reads of the same head only wait.
   */
  async #adoptMoved(work: StoreDoc, doc: StoreDoc, speaksFor: string, observed: string): Promise<boolean> {
    const id = String(work.id)
    const seen = doc.headMoved as { sha?: string; judged?: boolean } | undefined
    if (seen?.sha === observed && seen.judged !== false) return false
    const branch = String(doc.branch)
    let why: string
    try {
      const github = await fetchGitHubBranches(this.release, String(work.repoId), branch)
      why = github.head !== observed ? 'github_disagrees' : await baseMergeOf(github, speaksFor)
    } catch (error) {
      const refusal = refusalOf(error)
      if (refusal === undefined) throw error
      // Unreadable now is not judged: the next read tries again, and the page says what it saw.
      this.#patch(id, { headMoved: { sha: observed, at: this.#now, why: refusal.error, judged: false } })
      return false
    }
    if (why === 'adopted') {
      this.#patch(id, { prHead: observed, headMoved: undefined, ci: undefined, ciAt: undefined })
      const reason =
        'GitHub merged the target branch into the pushed head, and the changes are the ones MEC checked'
      this.#store.atomic(() => this.#workEvent(id, 'head_adopted', { from: speaksFor, to: observed, reason }))
      return true
    }
    this.#patch(id, { headMoved: { sha: observed, at: this.#now, why } })
    this.#store.atomic(() =>
      this.#workEvent(id, 'head_moved_on_github', { from: speaksFor, sha: observed, why }),
    )
    return false
  }

  /**
   * Bring up to date (owner, 9 November 2026): the target merges into the integration branch here,
   * the repository's checks run on the result, and only a pass moves the branch, forward, from the
   * head it was on. The push card then asks about exactly that commit, as for any new head. A
   * conflict or a failing check moves nothing and says so. Starting from an adopted head keeps the
   * push a fast-forward of what GitHub has; a branch that diverged otherwise is refused by the push.
   */
  async #bringUpToDate(work: StoreDoc, integration: StoreDoc): Promise<void> {
    const id = String(work.id)
    const worktree = String(integration.worktree)
    const branch = String(integration.branch)
    const from = String(integration.head)
    const doc = this.#doc(id) as StoreDoc
    const settle = (update: Record<string, Json>): void => {
      this.#patch(id, { update: { ...update, at: this.#now } })
      this.#store.atomic(() => this.#workEvent(id, 'update_not_pushed', update))
    }
    let github: Awaited<ReturnType<typeof fetchGitHubBranches>>
    try {
      github = await fetchGitHubBranches(this.release, String(work.repoId), branch)
    } catch (error) {
      const refusal = refusalOf(error)
      if (refusal === undefined) throw error
      return settle({ status: 'failed', reason: `${refusal.error}: ${refusal.detail}` })
    }
    const start = typeof doc.prHead === 'string' && github.head === doc.prHead ? doc.prHead : from
    const contains = await git(['merge-base', '--is-ancestor', github.target, start], {
      cwd: github.gitDir,
      allowFailure: true,
    })
    if (contains.code === 0) return settle({ status: 'current' })

    this.#store.atomic(() => {
      const fresh = this.#store.engines.get(String(integration.id)) as StoreDoc
      this.#store.engines.save({ ...fresh, updating: { from, at: this.#now }, updatedAt: this.#now })
    })
    const identity = await commitIdentity(this.#registeredUrl(work), String(work.git_dir))
    let moved = false
    try {
      await git(['checkout', '--quiet', '--detach', start], { cwd: worktree })
      await clearMergePath({ worktree, taskBranch: github.target })
      const message = `mec: bring ${branch} up to date with ${github.targetBranch}`
      const merged = await git(
        [
          ...['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`],
          ...['merge', '--no-ff', '--no-edit', '-m', message, github.target],
        ],
        { cwd: worktree, allowFailure: true },
      )
      if (merged.code !== 0) {
        if (!(await isMidMerge(worktree))) {
          const said = redact(
            (merged.stderr.trim() || merged.stdout.trim()).slice(-400),
            this.#fingerprints(),
            [],
          )
          return settle({ status: 'failed', reason: `integration: ${said}` })
        }
        const paths = await gitLines(['diff', '--name-only', '--diff-filter=U'], { cwd: worktree })
        return settle({ status: 'conflict', paths })
      }
      const sha = await headSha(worktree)
      const checks = await this.#combinedChecks(work, this.#repoOf(work), worktree)
      if (this.#closing.signal.aborted) return
      const failing = checks.filter((check) => check.status !== 'passed').map((check) => check.name)
      if (failing.length > 0) return settle({ status: 'failed', sha, failing })
      // Compare-and-set: the branch moves only from the head this started on, and only forward.
      await git(['update-ref', `refs/heads/${branch}`, sha, from], { cwd: worktree })
      await git(['checkout', '--quiet', branch], { cwd: worktree })
      moved = true
      this.#store.atomic(() => {
        const fresh = this.#store.engines.get(String(integration.id)) as StoreDoc
        const { updating: _updating, ...rest } = fresh
        this.#store.engines.save({
          ...rest,
          head: sha,
          combined: { sha, passed: true, checks: checks as unknown as Json },
          diffBase: github.target,
          updatedAt: this.#now,
        })
        this.#workEvent(id, 'brought_up_to_date', { from, to: sha, target: github.target })
      })
    } finally {
      // Aborted by a close, the worktree is put back too; the request stands, so the next start runs it.
      if (!moved) await this.#putBack(this.#store.engines.get(String(integration.id)) as StoreDoc)
    }
  }

  /** Back to the integration branch as it was before an update tried a merge. Never moves the branch. */
  async #putBack(integration: StoreDoc): Promise<void> {
    const worktree = String(integration.worktree)
    if (await isMidMerge(worktree)) await git(['merge', '--abort'], { cwd: worktree })
    await git(['checkout', '--quiet', String(integration.branch)], { cwd: worktree })
    this.#store.atomic(() => {
      const fresh = this.#store.engines.get(String(integration.id)) as StoreDoc
      const { updating: _updating, ...rest } = fresh
      this.#store.engines.save({ ...rest, updatedAt: this.#now })
    })
  }

  #registeredUrl(work: StoreDoc): string {
    const repo = this.#repoOf(work)
    return String(work.pin === undefined ? repo?.url : (work.pin as { url?: string }).url)
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

/** A file's change as git states it: where, how, and what the file holds after it. */
async function changesOf(gitDir: string, target: string, head: string): Promise<string[] | undefined> {
  const base = await git(['merge-base', target, head], { cwd: gitDir, allowFailure: true })
  if (base.code !== 0) return undefined
  const { stdout } = await git(
    ['diff', '--raw', '--no-renames', '--no-abbrev', '-z', base.stdout.trim(), head],
    {
      cwd: gitDir,
    },
  )
  // `:<old mode> <new mode> <old blob> <new blob> <status>\0<path>\0`: the old side is the base's,
  // which the target may have moved, so only the status, the path and the new side are compared.
  const fields = stdout.split('\0')
  const changes: string[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [, newMode = '', , newBlob = '', status = ''] = String(fields[index]).slice(1).split(' ')
    changes.push(`${status} ${newMode} ${newBlob} ${String(fields[index + 1])}`)
  }
  return changes.sort()
}

/**
 * Whether `observed` is GitHub's Update branch on `speaksFor` and nothing more (owner, 9 November
 * 2026): `speaksFor` is one of its parents, every other parent is on the target, and its changes
 * against the target are the ones `speaksFor` carries, file for file. `adopted`, or why not.
 */
async function baseMergeOf(
  github: { gitDir: string; head: string; target: string },
  speaksFor: string,
): Promise<string> {
  const cwd = github.gitDir
  const [, ...parents] = (await gitLines(['rev-list', '--parents', '-n', '1', github.head], { cwd }))
    .join(' ')
    .split(' ')
  if (!parents.includes(speaksFor)) return 'not_on_mec_head'
  for (const parent of parents.filter((sha) => sha !== speaksFor)) {
    const onTarget = await git(['merge-base', '--is-ancestor', parent, github.target], {
      cwd,
      allowFailure: true,
    })
    if (onTarget.code !== 0) return 'not_a_target_merge'
  }
  const checked = await changesOf(cwd, github.target, speaksFor)
  const now = await changesOf(cwd, github.target, github.head)
  if (checked === undefined || now === undefined) return 'changes_unreadable'
  return checked.join('\n') === now.join('\n') ? 'adopted' : 'changes_differ'
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
