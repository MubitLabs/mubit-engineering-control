/**
 * The effects queue (CONTRACTS §7, plan §17): what MEC does after a decision is stored first
 * and done after commit. One row per (kind, key); re-enqueueing a waiting key coalesces — the
 * payload is replaced and the row returns to pending, keeping its due time and queue order.
 *
 * A pass runs due rows oldest first (next_run_at, then arrival order) up to the kind's
 * concurrency (default 2). The kinds `relay` and `note` are ordered by nature: strictly one at
 * a time, in queue order, and a failing head holds back later jobs of the same kind until its
 * attempts exhaust — then the queue gives up on it (the row stays `failed`) and moves on. A
 * succeeded job is deleted (drained — there is no `done` state); only a `Later` deferral
 * leaves a `waiting` row, due again in 30 s without counting a failure. Failures retry with
 * exponential backoff — 1 s, 4 s, 16 s, 64 s, then the 5-minute cap — recording attempts and
 * the last error; the failure past the last backoff marks the row `failed` (attempts
 * exhausted). Each kind claims a `effects:<kind>` health entry that turns error after three
 * consecutive failures and clears on the kind's next success (§19).
 *
 * Passes overlap by design: a timer starts one every two seconds and a slow launch delays only
 * its own task (§11), so a pass never waits for an earlier pass's jobs. Picking is synchronous,
 * which keeps it one at a time, and a job in flight is not picked again: its row stays out of
 * every later pass and still counts against the kind's concurrency until it settles. Rows left
 * `running` by a crash are returned to pending once, by `resumeRunning` at boot.
 */

import type {
  EffectKind,
  EffectState,
  Effects,
  HealthBoard,
  HealthClaim,
  HealthName,
  Json,
} from '@mec/contracts'
import { Later } from '@mec/contracts'
import type Database from 'better-sqlite3'

/** Kinds that process strictly in queue order, one at a time (plan §17 table). */
const ORDERED_KINDS: ReadonlySet<EffectKind> = new Set(['relay', 'note'])
const DEFAULT_CONCURRENCY = 2
const BACKOFF_STEPS_SECONDS = [1, 4, 16, 64]
const BACKOFF_CAP_SECONDS = 300
/** One run per backoff step (the last at the cap); the failure past them all is terminal. */
const MAX_ATTEMPTS = BACKOFF_STEPS_SECONDS.length + 1
const LATER_DELAY_SECONDS = 30
const HEALTH_ERROR_AFTER_FAILURES = 3

export type EffectHandler = (payload: Json) => Promise<void>

export interface EffectsQueueOptions {
  now?: () => Date
  health?: HealthBoard
}

/** A single pass of the queue; `now` overrides the clock for tests. */
export interface RunPass {
  now?: Date
}

/** One queue row as test/debug code sees it; a succeeded job has no row at all. */
export interface EffectJobSnapshot {
  kind: EffectKind
  key: string
  state: EffectState
  payload: Json
  attempts: number
  nextRunAt: string
  lastError?: string
}

/** A health snapshot's state (§19); the claiming part's handle moves it. */
export type HealthState = 'starting' | 'ready' | 'paused' | 'error'

/** A snapshot of one health entry (§19). */
export interface HealthEntry {
  state: HealthState
  detail?: string
  at: string
}

interface Registration {
  run: EffectHandler
  concurrency: number
  ordered: boolean
}

interface InFlightJob {
  kind: string
  done: Promise<void>
}

interface EffectRow {
  kind: string
  key: string
  state: string
  payload: string
  attempts: number
  next_run_at: string
}

export class EffectsQueue implements Effects {
  private readonly registrations = new Map<EffectKind, Registration>()
  private readonly consecutiveFailures = new Map<EffectKind, number>()
  private readonly healthHandles = new Map<EffectKind, HealthClaim>()
  /** Jobs whose handler has not settled, by kind + key; only this process's jobs are here. */
  private readonly inFlight = new Map<string, InFlightJob>()
  private readonly now: () => Date
  private readonly health?: HealthBoard
  private statements: Statements | undefined

  constructor(
    private readonly db: Database.Database,
    opts?: EffectsQueueOptions,
  ) {
    this.now = opts?.now ?? (() => new Date())
    this.health = opts?.health
  }

  /** §26 Pause: every pending/waiting job's deadline moves later by ms. */
  shiftWaiting(ms: number): void {
    this.db
      .prepare(
        `UPDATE effects SET next_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(next_run_at) + (? / 86400000.0)) WHERE state IN ('pending', 'waiting')`,
      )
      .run(ms)
  }

  /**
   * A crash may have left rows marked running; a restart resumes them (plan §17). Call once at
   * boot, before the first pass: on a live queue it would hand running jobs to the next pass.
   */
  resumeRunning(): void {
    this.stmt().resumeRunning.run(this.now().toISOString())
  }

  /**
   * Joins the caller's transaction when one is open (§7: enqueue happens inside the command's
   * transaction) and autocommits otherwise. Coalescing: one row per kind+key, the payload is
   * replaced and the row returns to pending while next_run_at and attempts are kept.
   */
  enqueue(kind: EffectKind, key: string, payload: Json): void {
    const iso = this.now().toISOString()
    this.stmt().upsert.run(kind, key, JSON.stringify(payload), iso, iso)
  }

  /**
   * The opts match the contract's shape (`concurrency` required); the default keeps the plan's
   * table ergonomic for the queue's own callers — a bare `handle(kind, run)` runs two at once.
   */
  handle(
    kind: EffectKind,
    run: EffectHandler,
    opts: { concurrency: number; ordered?: boolean } = { concurrency: DEFAULT_CONCURRENCY },
  ): void {
    if (this.registrations.has(kind)) {
      throw new Error(`mec: an effects handler for ${kind} is already registered`)
    }
    const ordered = ORDERED_KINDS.has(kind) || opts.ordered === true
    this.registrations.set(kind, {
      run,
      // Ordered kinds are strictly one at a time regardless of the requested limit.
      concurrency: ordered ? 1 : Math.max(1, opts.concurrency),
      ordered,
    })
    if (this.health !== undefined) {
      this.healthHandles.set(kind, this.health.claim(`effects:${kind}` satisfies HealthName))
    }
  }

  /** One pass: every due job the concurrency limits allow, awaited to completion. */
  async run(pass?: RunPass): Promise<void> {
    await this.runPass(pass?.now ?? this.now())
  }

  /**
   * Runs passes until no due job remains and no job is in flight, an earlier pass's included
   * (jobs deferred by backoff or `Later`, or failed for good, stop the drain).
   */
  async drain(): Promise<void> {
    for (;;) {
      if ((await this.runPass(this.now())) > 0) continue
      if (this.inFlight.size === 0) return
      await Promise.allSettled([...this.inFlight.values()].map((job) => job.done))
    }
  }

  /** Waits for the jobs in flight and starts none: a paused close leaves every row for the next start. */
  async settle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()].map((job) => job.done))
    }
  }

  /** Test/debug view of one queue row; undefined once the job succeeded (drained). */
  snapshot(kind: EffectKind, key: string): EffectJobSnapshot | undefined {
    const row = this.stmt().byKindKey.get(kind, key)
    if (row === undefined) return undefined
    return {
      kind,
      key,
      state: row.state as EffectState,
      payload: JSON.parse(row.payload) as Json,
      attempts: row.attempts,
      nextRunAt: row.next_run_at,
      lastError: row.last_error ?? undefined,
    }
  }

  private async runPass(now: Date): Promise<number> {
    const picked = this.pickDue(now)
    const nowIso = now.toISOString()
    for (const { row } of picked) {
      this.stmt().markRunning.run(nowIso, row.kind, row.key)
    }
    if (picked.length > 0) {
      await Promise.all(picked.map(({ row, registration }) => this.track(row, registration, now)))
    }
    return picked.length
  }

  /** Runs one picked job, holding its in-flight entry until the handler settles. */
  private track(row: EffectRow, registration: Registration, now: Date): Promise<void> {
    const id = inFlightId(row.kind, row.key)
    const done = this.execute(row, registration, now).finally(() => this.inFlight.delete(id))
    this.inFlight.set(id, { kind: row.kind, done })
    return done
  }

  private inFlightOfKind(kind: EffectKind): number {
    let count = 0
    for (const job of this.inFlight.values()) if (job.kind === kind) count += 1
    return count
  }

  private pickDue(now: Date): Array<{ row: EffectRow; registration: Registration }> {
    const statements = this.stmt()
    const nowIso = now.toISOString()
    const picked: Array<{ row: EffectRow; registration: Registration }> = []
    for (const [kind, registration] of this.registrations) {
      if (registration.ordered) {
        // The earliest row of the kind that has not been drained or failed, in arrival order.
        // While it waits on a `Later` deferral or a backoff everything behind it is held; when
        // it is running the kind is busy; once it is `failed` the queue gives up on it and this
        // query returns the next row instead. An in-flight head re-enqueued mid-run reads
        // pending, so the kind's in-flight count decides busy, not the row's state alone.
        const head = statements.headOfKind.get(kind)
        if (head === undefined || head.state === 'running' || head.next_run_at > nowIso) continue
        if (this.inFlightOfKind(kind) > 0) continue
        picked.push({ row: head, registration })
        continue
      }
      // At most the kind's in-flight jobs read as due (re-enqueued mid-run), so asking for the
      // full limit still leaves every free place filled once they are dropped.
      const free = registration.concurrency - this.inFlightOfKind(kind)
      const due = statements.dueOfKind
        .all(kind, nowIso, registration.concurrency)
        .filter((row) => !this.inFlight.has(inFlightId(row.kind, row.key)))
      for (const row of due.slice(0, Math.max(0, free))) picked.push({ row, registration })
    }
    return picked
  }

  private async execute(row: EffectRow, registration: Registration, now: Date): Promise<void> {
    let payload: Json
    try {
      payload = JSON.parse(row.payload) as Json
    } catch {
      payload = null
    }
    const kind = row.kind as EffectKind
    try {
      await registration.run(payload)
    } catch (error) {
      if (error instanceof Later) {
        // Defer without counting a failure: `waiting`, due again in 30 s, attempts and health untouched.
        const at = new Date(now.getTime() + LATER_DELAY_SECONDS * 1000).toISOString()
        this.stmt().reschedule.run(at, row.attempts, now.toISOString(), row.kind, row.key)
        return
      }
      const attempts = row.attempts + 1
      const message = error instanceof Error ? error.message : String(error)
      const backoffSeconds = BACKOFF_STEPS_SECONDS[attempts - 1] ?? BACKOFF_CAP_SECONDS
      const nextRunAt = new Date(now.getTime() + backoffSeconds * 1000).toISOString()
      // The failure past the last backoff exhausts the attempts: the row turns `failed` and is
      // never picked again (an ordered kind then gives up on it and moves to the next job).
      const state: EffectState = attempts > MAX_ATTEMPTS ? 'failed' : 'pending'
      this.stmt().fail.run(state, attempts, nextRunAt, message, now.toISOString(), row.kind, row.key)
      this.noteFailure(kind, message)
      return
    }
    // Success drains the row: done is the absence of the row, not a state. A new payload
    // enqueued mid-run is newer work and stays pending; the same payload is the job just done.
    this.stmt().deleteRow.run(row.kind, row.key, row.payload)
    this.noteSuccess(kind)
  }

  private noteFailure(kind: EffectKind, message: string): void {
    const failures = (this.consecutiveFailures.get(kind) ?? 0) + 1
    this.consecutiveFailures.set(kind, failures)
    if (failures >= HEALTH_ERROR_AFTER_FAILURES) {
      this.healthHandles.get(kind)?.error(`${kind} item failed ${failures} times in a row: ${message}`)
    }
  }

  private noteSuccess(kind: EffectKind): void {
    const failures = this.consecutiveFailures.get(kind) ?? 0
    if (failures === 0) return
    this.consecutiveFailures.set(kind, 0)
    if (failures >= HEALTH_ERROR_AFTER_FAILURES) {
      // The kind's own next success clears the error (§19).
      this.healthHandles.get(kind)?.ready(`${kind} recovered after ${failures} consecutive failures`)
    }
  }

  private stmt(): Statements {
    if (this.statements === undefined) this.statements = new Statements(this.db)
    return this.statements
  }
}

const inFlightId = (kind: string, key: string): string => `${kind}\0${key}`

class Statements {
  readonly upsert: Database.Statement<[string, string, string, string, string], unknown>
  readonly byKindKey: Database.Statement<[string, string], EffectRow & { last_error: string | null }>
  readonly resumeRunning: Database.Statement<[string], unknown>
  readonly headOfKind: Database.Statement<[string], EffectRow>
  readonly dueOfKind: Database.Statement<[string, string, number], EffectRow>
  readonly markRunning: Database.Statement<[string, string, string], unknown>
  readonly reschedule: Database.Statement<[string, number, string, string, string], unknown>
  readonly fail: Database.Statement<[string, number, string, string, string, string, string], unknown>
  readonly deleteRow: Database.Statement<[string, string, string], unknown>

  constructor(db: Database.Database) {
    this.upsert = db.prepare(
      `INSERT INTO effects (kind, key, state, payload, attempts, next_run_at, last_error, updated_at)
       VALUES (?, ?, 'pending', ?, 0, ?, NULL, ?)
       ON CONFLICT (kind, key) DO UPDATE SET
         payload = excluded.payload,
         state = 'pending',
         updated_at = excluded.updated_at`,
    )
    this.byKindKey = db.prepare(
      'SELECT kind, key, state, payload, attempts, next_run_at, last_error FROM effects WHERE kind = ? AND key = ?',
    )
    this.resumeRunning = db.prepare(
      "UPDATE effects SET state = 'pending', updated_at = ? WHERE state = 'running'",
    )
    this.headOfKind = db.prepare(
      "SELECT kind, key, state, payload, attempts, next_run_at FROM effects WHERE kind = ? AND state IN ('pending', 'waiting', 'running') ORDER BY rowid LIMIT 1",
    )
    this.dueOfKind = db.prepare(
      "SELECT kind, key, state, payload, attempts, next_run_at FROM effects WHERE kind = ? AND state IN ('pending', 'waiting') AND next_run_at <= ? ORDER BY next_run_at, rowid LIMIT ?",
    )
    this.markRunning = db.prepare(
      "UPDATE effects SET state = 'running', updated_at = ? WHERE kind = ? AND key = ?",
    )
    this.reschedule = db.prepare(
      "UPDATE effects SET state = 'waiting', next_run_at = ?, attempts = ?, updated_at = ? WHERE kind = ? AND key = ?",
    )
    this.fail = db.prepare(
      'UPDATE effects SET state = ?, attempts = ?, next_run_at = ?, last_error = ?, updated_at = ? WHERE kind = ? AND key = ?',
    )
    this.deleteRow = db.prepare('DELETE FROM effects WHERE kind = ? AND key = ? AND payload = ?')
  }
}

/**
 * The health board (§7/§19): one entry per part, each claimed exactly once — a second claim is
 * refused. The claiming part moves its own state through the returned handle.
 */
export class HealthBoardImpl implements HealthBoard {
  private readonly entries = new Map<HealthName, MutableHealthEntry>()

  claim(name: HealthName): HealthClaim {
    if (this.entries.has(name)) throw new Error(`mec: health entry ${name} is already claimed`)
    const entry: MutableHealthEntry = { state: 'starting', at: new Date().toISOString() }
    this.entries.set(name, entry)
    const set = (state: HealthState, detail?: string): void => {
      entry.state = state
      entry.detail = detail
      entry.at = new Date().toISOString()
    }
    return {
      starting: () => set('starting'),
      ready: (detail?: string) => set('ready', detail),
      paused: () => set('paused'),
      error: (detail: string) => set('error', detail),
    }
  }

  /** A copy of one entry, or undefined when nothing has claimed the name yet. */
  entry(name: HealthName): HealthEntry | undefined {
    const entry = this.entries.get(name)
    return entry === undefined ? undefined : { ...entry }
  }

  names(): HealthName[] {
    return [...this.entries.keys()]
  }
}

interface MutableHealthEntry {
  state: HealthState
  detail?: string
  at: string
}
