/**
 * The contracts `Runtime` (plan §8, §17): one engine process per attempt, from a started engine
 * to a verdict on an exact SHA. The launch path prepares the worktree and the brief; this module
 * starts the engine, returns, and a monitor owns the attempt from there, so a long attempt never
 * holds an effects-queue job.
 *
 * Per event, in this order (§8.6): redact, append and fsync to the journal, one store transaction
 * for facts, state and event, then ack. The adapter restarts seq at 1, so seq is assigned here and
 * the generation stays on the event. A store failure leaves the event unacknowledged in the
 * journal for replay.
 *
 * After a completed exit: seal the token, commit any leftover tree, read the head, refuse a
 * history that holds `.mec/`, then run the repo's checks on that head. Only checks passing on the
 * head give `succeeded`; an exit code never does.
 *
 * `@mec/engines` depends on this package and this package has no git of its own, so the adapter
 * and the git operations are injected, and domain state belongs to the `AttemptFacts` behind them.
 */
import { join } from 'node:path'
import type {
  AttemptBrief,
  AttemptRef,
  CoreForEngines,
  EngineAdapter,
  EngineEvent,
  ExitPayload,
  Input,
  KeyFingerprint,
  LaunchModel,
  LaunchSpec,
  PermissionBridge,
} from '@mec/contracts'
import { redact } from '@mec/slots'
import { type CheckOutcome, type CheckSpec, runCheck } from './checks'
import { AttemptJournal } from './journal'
import { parkFromEvents } from './park'
import { redactEvent } from './redact-events'
import type { Supervisor } from './supervisor'

/** A `Runtime` call whose wiring belongs to a later milestone; it fails by name, never quietly. */
export class NotWiredError extends Error {
  constructor(call: string, milestone: string) {
    super(`runtime: ${call} is not wired until ${milestone}`)
    this.name = 'NotWiredError'
  }
}

/** `CoreForEngines` plus what the runner needs a store to do: state belongs on that side. */
export interface AttemptFacts extends CoreForEngines {
  atomic<T>(fn: () => T): T
  /** One journalled engine event on the attempt's stream. */
  engineEvent(attempt: AttemptRef, event: EngineEvent): void
  workCompleted(attempt: AttemptRef, head: string): void
  checksFinished(attempt: AttemptRef, head: string, outcomes: CheckOutcome[], passed: boolean): void
  checksSkipped(attempt: AttemptRef, head: string, reason: string): void
  attemptParked(attempt: AttemptRef, state: ParkedState, reason: string): void
  attemptInterrupted(attempt: AttemptRef, reason: string): void
  attemptFailed(attempt: AttemptRef, reason: string): void
}

export type ParkedState = 'quota_wait' | 'auth_required' | 'provider_down'

export interface AttemptGit {
  commitAll(path: string, message: string, opts: { name: string; email: string }): Promise<string | null>
  headSha(path: string): Promise<string>
  historyTouches(worktree: string, base: string, head: string, path: string): Promise<boolean>
}

/** What a brief cannot carry: everything secret, host-side or not persisted (§5.12, §17). */
export type AttemptPlan = {
  env: Record<string, string>
  cwd: string
  bridge: PermissionBridge
  model?: LaunchModel
  slotId: string
  checks: readonly CheckSpec[]
  identity: { name: string; email: string }
  fingerprints: readonly KeyFingerprint[]
  exacts: readonly string[]
  /** Runs before anything repo-controlled does: the token leaves the worktree (decision #25). */
  seal: () => void
  /** The tail of the engine's stderr, for the reason a crash gives; redacted before it is stored. */
  stderrTail?: () => string
}

export type AttemptRunnerDeps = {
  journalRoot: string
  supervisor: Supervisor
  facts: AttemptFacts
  git: AttemptGit
  adapterFor: (brief: AttemptBrief) => EngineAdapter
  planFor: (brief: AttemptBrief) => AttemptPlan
}

/** Engines whose `send` a real run has proven. Codex and OpenCode arrive with M2.4. */
const PROVEN_INPUT: readonly string[] = ['claude']

/** What an adapter may add to `send`: the moment the turn that carried an input ended. */
type InputEvidence = {
  inputFinished?: (handle: Live['handle'], inputId: string) => Promise<void>
}

type StopReason = 'stop_requested' | 'wall_clock' | 'server_closing'

type Live = {
  attempt: AttemptRef
  brief: AttemptBrief
  plan: AttemptPlan
  journal: AttemptJournal
  adapter: EngineAdapter
  handle: Awaited<ReturnType<EngineAdapter['launch']>>
  timer: NodeJS.Timeout
  sawSession: boolean
  stopReason?: StopReason
  /** A stop cancels a repo check as well: the check runs after the engine's group is gone. */
  checks: AbortController
  done: Promise<void>
}

const keyOf = (attempt: AttemptRef): string => `${attempt.attempt_id} ${attempt.generation}`

export class AttemptRunner {
  readonly #deps: AttemptRunnerDeps
  readonly #live = new Map<string, Live>()

  constructor(deps: AttemptRunnerDeps) {
    this.#deps = deps
  }

  /** Returns once the engine has started; the monitor owns the attempt from there. */
  async launchAttempt(attempt: AttemptRef, brief: AttemptBrief): Promise<void> {
    const { journalRoot, adapterFor, planFor } = this.#deps
    const plan = planFor(brief)
    const journal = AttemptJournal.open(join(journalRoot, attempt.attempt_id))
    const adapter = adapterFor(brief)
    const spec: LaunchSpec = {
      brief,
      env: plan.env,
      cwd: plan.cwd,
      bridge: plan.bridge,
      ...(plan.model !== undefined && { model: plan.model }),
    }
    const handle = await adapter.launch(spec)
    const live: Live = {
      attempt,
      brief,
      plan,
      journal,
      adapter,
      handle,
      sawSession: false,
      checks: new AbortController(),
      timer: setTimeout(() => {
        this.#stop(live, 'wall_clock').catch(() => {})
      }, brief.budget.wall_clock_ms),
      done: Promise.resolve(),
    }
    live.timer.unref()
    this.#live.set(keyOf(attempt), live)
    live.done = this.#monitor(live).finally(() => {
      clearTimeout(live.timer)
      this.#live.delete(keyOf(attempt))
    })
  }

  /**
   * Resolves once the engine took the input; a rejection is a failed delivery (§12.4). The end of
   * the turn that carried it comes later, as `inputsRead`, when the adapter can say so.
   */
  async deliver(attempt: AttemptRef, input: Input): Promise<void> {
    const { facts } = this.#deps
    const live = this.#live.get(keyOf(attempt))
    if (live === undefined) throw new Error(`runtime: ${attempt.attempt_id} has no running engine`)
    const { engine } = live.brief
    if (!PROVEN_INPUT.includes(engine)) throw new Error(`runtime: engine ${engine} has no proven input`)
    await live.adapter.send(live.handle, input)
    const { inputFinished } = live.adapter as InputEvidence
    inputFinished
      ?.call(live.adapter, live.handle, input.id)
      .then(() => facts.atomic(() => facts.inputsRead(attempt, [input.id])))
      .catch(() => {})
  }

  replay(_attempt: AttemptRef): Promise<void> {
    return Promise.reject(new NotWiredError('replay', 'M2.4'))
  }

  /** §8.1: signal the group, confirm it gone, and wait for the monitor to record the end. */
  async stop(attempt: AttemptRef): Promise<void> {
    const live = this.#live.get(keyOf(attempt))
    if (live !== undefined) await this.#stop(live, 'stop_requested')
  }

  /** Attempts with a monitor running, for whoever acts on a stop request. */
  live(): AttemptRef[] {
    return [...this.#live.values()].map((entry) => entry.attempt)
  }

  /** §20: every owned group stops, and each attempt's end is recorded first. */
  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.#live.values()].map((live) => this.#stop(live, 'server_closing')))
  }

  /** Resolves when every monitor has finished. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.#live.values()].map((live) => live.done))
  }

  async #stop(live: Live, reason: StopReason): Promise<void> {
    live.stopReason ??= reason
    live.checks.abort()
    await this.#stopGroup(live)
    await live.done
  }

  async #stopGroup(live: Live): Promise<void> {
    const { supervisor } = this.#deps
    const { attempt_id, generation } = live.attempt
    if (supervisor.owns(attempt_id, generation)) await supervisor.stop(attempt_id, generation)
  }

  async #monitor(live: Live): Promise<void> {
    const { facts } = this.#deps
    const { attempt } = live
    try {
      let exit: ExitPayload | undefined
      for await (const event of live.adapter.events(live.handle)) {
        this.#ingest(live, event)
        if (event.type === 'exit') exit = event
      }
      await this.#stopGroup(live)
      live.plan.seal()
      await this.#finish(live, exit)
    } catch (error) {
      live.plan.seal()
      await this.#stopGroup(live).catch(() => {})
      try {
        const detail = error instanceof Error ? error.message : String(error)
        facts.atomic(() => facts.attemptFailed(attempt, this.#clean(live, `monitor_error: ${detail}`)))
      } catch {
        // The store itself is what failed. The journal keeps the tail for replay.
      }
    }
  }

  /** §8.6, in order: the journal holds only redacted text, and ack follows the commit. */
  #ingest(live: Live, raw: EngineEvent): void {
    const { facts } = this.#deps
    const { attempt, journal, plan } = live
    const seq = (journal.lastSeq() ?? 0) + 1
    const event = redactEvent({ ...raw, seq }, plan.fingerprints, plan.exacts)
    journal.append(event)
    facts.atomic(() => {
      facts.engineEvent(attempt, event)
      this.#factsOf(live, event)
    })
    journal.ack(seq)
  }

  #factsOf(live: Live, event: EngineEvent): void {
    const { facts } = this.#deps
    const { attempt, plan } = live
    switch (event.type) {
      case 'session_started':
        live.sawSession = true
        facts.attemptStarted(attempt, attempt.generation, event.session_id, event.at)
        break
      case 'usage':
        facts.usageObserved(attempt, event)
        break
      case 'rate_limit':
        facts.rateLimitObserved(attempt, plan.slotId, {
          window: event.window,
          ...(event.utilization !== undefined && { utilization: event.utilization }),
          resets_at: event.resets_at,
          observed_at: event.at,
          source: 'engine_event',
        })
        break
      case 'exit':
        facts.attemptExited(attempt, attempt.generation, event)
        break
      default:
    }
  }

  async #finish(live: Live, exit: ExitPayload | undefined): Promise<void> {
    const { facts } = this.#deps
    const { attempt, journal } = live
    if (live.stopReason !== undefined) {
      const reason = live.stopReason
      facts.atomic(() => facts.attemptInterrupted(attempt, reason))
      return
    }
    if (!live.sawSession) return this.#fail(live, 'no_session')
    if (exit?.terminal_reason === 'completed') return this.#settle(live)
    const park = parkFromEvents(journal.events())
    if (park.park) {
      facts.atomic(() => facts.attemptParked(attempt, park.state, park.reason))
      return
    }
    this.#fail(live, `engine_${exit?.terminal_reason ?? 'crashed'}`)
  }

  /** The agent stopped. Decides `work_complete`, then what the head's checks say about it. */
  async #settle(live: Live): Promise<void> {
    const { facts, git } = this.#deps
    const { attempt, brief, plan } = live
    const message = `mec: ${brief.task_id} attempt ${attempt.attempt_id}`
    let head: string
    try {
      await git.commitAll(brief.worktree, message, plan.identity)
      head = await git.headSha(brief.worktree)
      if (await git.historyTouches(brief.worktree, brief.base_sha, head, '.mec')) {
        return this.#fail(live, 'mec_in_history')
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return this.#fail(live, `commit_failed: ${detail}`)
    }
    facts.atomic(() => facts.workCompleted(attempt, head))
    if (plan.checks.length === 0) {
      facts.atomic(() => {
        facts.checksSkipped(attempt, head, 'no checks are registered for this repository')
      })
      return
    }
    const outcomes: CheckOutcome[] = []
    for (const spec of plan.checks) {
      if (live.stopReason !== undefined) {
        const skipped = `stopped before check ${spec.name}: ${live.stopReason}`
        facts.atomic(() => facts.checksSkipped(attempt, head, skipped))
        return
      }
      const outcome = await runCheck(spec, live.checks.signal)
      // A stopped attempt gets no verdict, whatever the check's last act was.
      if (live.stopReason !== undefined) {
        const skipped = `stopped during check ${spec.name}: ${live.stopReason}`
        facts.atomic(() => facts.checksSkipped(attempt, head, skipped))
        return
      }
      outcomes.push({ ...outcome, logTail: this.#clean(live, outcome.logTail) })
    }
    const passed = outcomes.every((outcome) => outcome.status === 'passed')
    facts.atomic(() => facts.checksFinished(attempt, head, outcomes, passed))
  }

  /** §17: every failure after the engine started ends here; a launch failure ends the same way. */
  #fail(live: Live, reason: string): void {
    const { facts } = this.#deps
    const stderr = live.plan.stderrTail?.().trim() ?? ''
    const detail = stderr === '' ? reason : `${reason}: ${stderr}`
    facts.atomic(() => facts.attemptFailed(live.attempt, this.#clean(live, detail)))
  }

  #clean(live: Live, text: string): string {
    return redact(text, live.plan.fingerprints, live.plan.exacts)
  }
}
