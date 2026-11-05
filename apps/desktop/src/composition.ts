/**
 * The composition root (plan §17/§21): one process owns the data directory (`DirLock`),
 * opens and migrates the SQLite store, registers the effect handlers, keeps the §21.2
 * health snapshot that `mec status` reads warm, starts the mec-tools MCP server and serves
 * the composition server. Every seam above is a landed package; this module only wires
 * them and owns their lifetimes.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LaunchSpec, Store } from '@mec/contracts'
import { Later } from '@mec/contracts'
import { BridgeImpl, MecToolsServer } from '@mec/mec-tools'
import {
  failLaunch,
  fakeBrain,
  launchAuthority,
  launchFailure,
  MetaAgentService,
  type MetaBrain,
  processingOf,
  RealClaudeBrain,
  refuseLaunch,
  saveProcessing,
} from '@mec/meta'
import { loadPolicy } from '@mec/policy'
import { defaultsRoot, loadModelsTable, userModelsPath } from '@mec/prompts'
import { parkFromEvents } from '@mec/runtime'
import { probeModelAvailabilitySync } from '@mec/slots'
import type { EffectHandler, HealthClaim, Json } from '@mec/store'
import { DirLock, HealthBoardImpl, InspectionReads, MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import { FakeEngine } from '@mec/testkit'
import Database from 'better-sqlite3'
import { buildHealthSnapshot, buildServer } from './server'

/** A minimal valid policy: nothing is pre-authorised (§13); the user's file replaces it. */
const DEFAULT_POLICY_TEXT = '{"preAuthorised":{}}'

/** The recorded fixture the fake launch path replays (CONTRACTS §1's smoke recording). */
const FIXTURE_SMOKE_DIR = fileURLToPath(
  new URL('../../../packages/testkit/fixtures/claude/2.1.317/smoke', import.meta.url),
)

/** A1: queue passes every two seconds; handlers drain what commands committed. */
const PASS_INTERVAL_MS = 2000

/** §20 Shutdown: how long in-flight work gets before the process goes without it. */
const CLOSE_BOUND_MS = 10_000

/** The stop and the brain's close: a stopped engine ends at once, and the rest is not slow. */
const BRAIN_CLOSE_GRACE_MS = 1000

/**
 * The safe-side decider both engines and mec-tools see in this milestone. Composition
 * point: once the confirmation inbox backs the bridge, this callback becomes
 * `openConfirmation` + wait-for-resolution (plan §9/§13); until then an ask answers deny.
 */
const DENY_BRIDGE = new BridgeImpl(async () => 'deny')

export interface RunningServer {
  url: string
  port: number
  close: () => Promise<void>
  /** §26 Pause: stops new passes; running turns finish; resume shifts waiting deadlines. */
  pause: () => void
  resume: () => void
  isPaused: () => boolean
}

/** The wizard's persisted meta-slot choice → that slot's home dir. Best-effort: an absent
 *  or dangling choice means "not chosen yet" (undefined), never a crash on startup. */
function metaSlotFromStore(store: Store): string | undefined {
  const setting = store.engines.get('settings/meta-slot')
  const slotId = setting !== undefined && typeof setting.slotId === 'string' ? setting.slotId : undefined
  if (slotId === undefined) return undefined
  const slot = store.slots.get(slotId)
  return slot !== undefined && typeof slot.home === 'string' && slot.home !== '' ? slot.home : undefined
}

export async function startServer(opts: {
  dataDir: string
  policyText?: string
  /** The meta agent's slot home. Default: the wizard's persisted choice in the store, then
   *  MEC_META_SLOT as the override (review 2026-11-04 §3.2 — the env var stops being the way). */
  metaSlotDir?: string
  /** A test seam: the planner to compose in place of the engine-backed or scripted one. */
  brain?: MetaBrain
  /** A test seam: §20's shutdown bound, which is 10 s everywhere else. */
  closeBoundMs?: number
}): Promise<RunningServer> {
  // Fail fast: a build without its prompts never starts, before it takes the lock (§16).
  defaultsRoot()
  const lock = DirLock.acquire(opts.dataDir)
  mkdirSync(opts.dataDir, { recursive: true })
  const db = new Database(join(opts.dataDir, 'mec.db'))
  migrate(db, MIGRATIONS_v1)
  const store = new SqliteStore(db)
  const metaSlotDir = opts.metaSlotDir ?? metaSlotFromStore(store) ?? process.env.MEC_META_SLOT
  const health = new HealthBoardImpl()
  health.claim('runtime').ready('composition root up')
  // Fail fast: a policy that cannot load never starts a server that would enforce it.
  const policy = loadPolicy(opts.policyText ?? DEFAULT_POLICY_TEXT)

  // The relay handler reads this late: rows can wait for a meta agent, and one may never come.
  let metaAgent: MetaAgentService | undefined
  registerEffectHandlers(store, health, policy.versionHash, () => metaAgent)

  // §26 Restart mid-attempt: a previous process's attempts stuck in 'running' reconcile to
  // 'stalled' with a recovery note — one live attempt per task, no duplicate dispatch (the
  // journal owns deeper replay; this is the state the scheduler re-checks before replacing).
  reconcileRunningAttempts(store)
  // Plan §17: rows a previous process left running resume here, once, before the first pass.
  // A later pass must not touch them: the running ones are then this process's own jobs.
  store.effects.resumeRunning()
  // §26 Capability drift: probe the configured engine slot at startup; a binary that lost a
  // required flag degrades the slot to engine_unsupported BEFORE any attempt starts.
  if (process.env.MEC_PROBE_SLOT !== undefined && process.env.MEC_PROBE_SLOT !== '') {
    await probeSlotAtStartup(store, health, process.env.MEC_PROBE_SLOT)
  }

  // §26 Pause: no launch, deliver, relay or outbound message runs while paused; jobs that
  // were mid-handler finish (the pass simply stops starting new ones). On resume, waiting
  // deadlines shift by the pause length so nothing fires late-but-eagerly. Decision #21: the
  // pause is stored, so it outlives a restart and the shift still counts from its first moment.
  const stored = processingOf(store)
  let paused = stored.paused
  let pausedAt = stored.pausedAt
  const pauseControl = {
    pause(): void {
      if (paused) return
      const at = new Date().toISOString()
      paused = true
      pausedAt = at
      store.atomic(() => saveProcessing(store, { paused, pausedAt: at }, at))
    },
    resume(): void {
      if (!paused) return
      const at = new Date()
      const shift = at.getTime() - Date.parse(pausedAt ?? at.toISOString())
      paused = false
      pausedAt = undefined
      store.atomic(() => {
        saveProcessing(store, { paused }, at.toISOString())
        if (shift > 0) store.effects.shiftWaiting?.(shift)
      })
      // After the shift, so a message the pause held back runs on the next pass (#27).
      metaAgent?.enqueueResumes()
    },
    isPaused(): boolean {
      return paused
    },
  }

  const planner = composePlanner(store, opts, metaSlotDir)
  metaAgent = planner?.service
  // §20 App crash: a turn the crash cut short resumes through the queue, never inline. While
  // paused, resume does this instead, and it comes after the deadline shift.
  if (!paused) metaAgent?.enqueueResumes()

  const queueTimer = setInterval(() => {
    if (paused) return
    void store.effects.run().catch(() => {})
  }, PASS_INTERVAL_MS)
  queueTimer.unref()
  if (!paused) void store.effects.run().catch(() => {})

  // The §21.2 snapshot writer: `mec status` reads <dataDir>/health.json (B0's main reads
  // ~/.mec/health.json — the dataDir IS that root). Rewritten when the board changes and at
  // least every 2s, so a stale file can only ever be one tick old.
  const healthPath = join(opts.dataDir, 'health.json')
  let lastHealthText = ''
  const writeHealth = (): void => {
    const text = JSON.stringify(buildHealthSnapshot(store, health), null, 2)
    if (text === lastHealthText) return
    lastHealthText = text
    writeFileSync(healthPath, `${text}\n`)
  }
  writeHealth()
  const healthTimer = setInterval(writeHealth, PASS_INTERVAL_MS)
  healthTimer.unref()

  // mec-tools (A3) on an ephemeral port with a per-process secret. Composition point: the
  // scheduler mints attempt-scoped tokens (`issueToken`) at launch (plan §6); no tokens are
  // issued here — the transport being up is what this milestone proves.
  const tools = new MecToolsServer({
    secret: randomBytes(32).toString('hex'),
    bridge: DENY_BRIDGE,
    onCall: async () => {
      throw new Error('mec-tools: tool execution is not wired at this composition milestone')
    },
  })
  await tools.start()

  const app = buildServer({
    store,
    effects: store.effects,
    health,
    inspection: new InspectionReads(db),
    policyText: opts.policyText ?? DEFAULT_POLICY_TEXT,
    pauseControl,
    // The data dir is the keystore root (§5.4), so a scratch server never reads real state.
    keystoreRoot: opts.dataDir,
    ...(metaAgent !== undefined && { metaAgent }),
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') {
    throw new Error(`unexpected listen address: ${JSON.stringify(address)}`)
  }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    clearInterval(queueTimer)
    clearInterval(healthTimer)
    planner?.quiesce()
    // The final snapshot answers `not running` (instances 0, not answering) so `mec status`
    // never reports a dead server as healthy.
    const final = buildHealthSnapshot(store, health)
    final.runtime = { state: 'paused', instances: 0, answering: false }
    writeFileSync(healthPath, `${JSON.stringify(final, null, 2)}\n`)
    await tools.stop()
    // §20, decision #36: only work already in flight finishes, within the bound. A drain would
    // start paid planner turns on the way out; pending rows are for the next start. Past the
    // bound the engine is stopped, or its pipes would keep this process up. A turn that still
    // answers fails quietly at its next write, so its row stays running for boot.
    await within(
      opts.closeBoundMs ?? CLOSE_BOUND_MS,
      Promise.allSettled([app.close(), store.effects.settle()]),
    )
    app.server.closeAllConnections()
    if (planner !== undefined) {
      await within(
        BRAIN_CLOSE_GRACE_MS,
        planner.abort().then(() => planner.close()),
      )
    }
    db.close()
    lock.release()
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close,
    pause: pauseControl.pause,
    resume: pauseControl.resume,
    isPaused: pauseControl.isPaused,
  }
}

/** Waits for `work` no longer than `ms`; what `work` does later, or how it ends, is its own. */
async function within(ms: number, work: Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  await Promise.race([work.catch(() => {}), limit])
  clearTimeout(timer)
}

/** The planner's lifetime, as `close` drives it; a scripted brain has no engine to stop. */
type PlannerLifetime = { quiesce: () => void; abort: () => Promise<void>; close: () => Promise<void> }

const NO_ENGINE: PlannerLifetime = { quiesce: () => {}, abort: async () => {}, close: async () => {} }

/**
 * §6 composed path: the meta-agent executor owns chat turns. MEC_FAKE_ENGINE=1 uses the scripted
 * fake; otherwise the REAL brain (R1.4), the meta agent on a dedicated Claude slot
 * (MEC_META_SLOT) through the platform tools. With neither, there is no meta agent.
 */
function composePlanner(
  store: SqliteStore,
  opts: { dataDir: string; brain?: MetaBrain },
  metaSlotDir: string | undefined,
): ({ service: MetaAgentService } & PlannerLifetime) | undefined {
  if (opts.brain !== undefined) {
    return {
      service: new MetaAgentService({ store, effects: store.effects, brain: opts.brain }),
      ...NO_ENGINE,
    }
  }
  if (process.env.MEC_FAKE_ENGINE === '1') {
    return {
      service: new MetaAgentService({
        store,
        effects: store.effects,
        brain: fakeBrain({
          ack: 'On it: I will split this into implementation and review tasks.',
          plan: {
            tasks: [
              {
                taskId: 'implement',
                objective: 'Implement the request from the originating message.',
                dependsOn: [],
                role: 'implementer',
              },
              {
                taskId: 'review',
                objective: 'Review the implementation against the request.',
                dependsOn: ['implement'],
                role: 'code_reviewer',
              },
            ],
          },
        }),
      }),
      ...NO_ENGINE,
    }
  }
  if (metaSlotDir === undefined) return undefined
  // Held so `close` can reach it; its close waits for a turn in flight, so `close` bounds that.
  const brain = new RealClaudeBrain({
    slotDir: metaSlotDir,
    toolsSecret: randomBytes(24).toString('hex'),
    // §5.4: the data dir is the root, so a scratch server never reads the real prompts.
    promptsRoot: join(opts.dataDir, 'prompts'),
  })
  return {
    service: new MetaAgentService({
      store,
      effects: store.effects,
      // Issue #14: the planner's capability-table supplier — without it the service
      // falls back to an EMPTY table, every tier is unplaceable, every plan rejected.
      modelsTable: () => {
        try {
          const loaded = loadModelsTable({ userPath: userModelsPath(opts.dataDir) })
          return {
            table: loaded.table,
            provenance: {
              sha256: loaded.provenance.sha256,
              origin: loaded.provenance.source,
            },
          }
        } catch {
          return undefined
        }
      },
      // Issue #14, seam two: per-turn availability marks — the config-declared probe
      // for opencode slots (the slot's own opencode.json), honestly unlisted elsewhere.
      marks: () => {
        const out: Record<string, Record<string, 'available' | 'unavailable' | 'unlisted'>> = {}
        for (const slot of store.slots.list()) {
          if (slot.engine !== 'opencode' || typeof slot.home !== 'string') continue
          try {
            const report = probeModelAvailabilitySync('opencode', {
              configDir: join(slot.home, 'config'),
            })
            out[String(slot.id)] = report.availability
          } catch {
            // a slot whose config cannot be read is honestly unlisted (empty marks)
          }
        }
        return out
      },
      brain: brain.asBrain(),
    }),
    quiesce: () => brain.quiesce(),
    abort: () => brain.abort(),
    close: () => brain.close(),
  }
}

const EFFECT_KINDS = ['launch', 'deliver', 'relay', 'note', 'reply', 'external', 'probe'] as const

/**
 * §26 Capability drift: a startup probe degrades the slot before any attempt starts. The
 * probe is the vendor's own --version/--help/auth status (§5.8); MEC_PROBE_SLOT is a
 * dedicated CLAUDE_CONFIG_DIR home.
 */
async function probeSlotAtStartup(
  store: SqliteStore,
  health: HealthBoardImpl,
  slotDir: string,
): Promise<void> {
  const claim = health.claim('engine:claude')
  claim.starting()
  try {
    const engines = await import('@mec/engines')
    const { checkDrift } = await import('@mec/runtime')
    const { execFile } = await import('node:child_process')
    const env = { ...process.env, CLAUDE_CONFIG_DIR: slotDir }
    const run = (cmd: string, args: readonly string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        execFile(cmd, args, { env }, (error, stdout, stderr) => {
          resolve({ code: error ? 1 : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        })
      })
    const { capabilities } = await engines.probeClaude(run)
    const drift = checkDrift(capabilities, [
      ...engines.REQUIRED_FLAGS,
      '--restricted',
      '--permission-prompt-tool',
    ])
    const existing = store.slots.list().find((doc) => String(doc.id) === 'slot_claude_probe')
    const at = new Date().toISOString()
    store.atomic(() => {
      store.slots.save({
        ...(existing ?? {
          id: 'slot_claude_probe',
          label: 'startup probe',
          engine: 'claude',
          kind: 'claude-sub',
        }),
        engine_version: capabilities.engine_version,
        state: drift.degraded ? 'degraded' : 'healthy',
        ...(drift.degraded && { state_reason: 'engine_unsupported', drift_detail: drift.detail }),
        updatedAt: at,
      })
    })
    if (drift.degraded) {
      claim.error(`engine_unsupported: ${drift.detail}`)
    } else {
      claim.ready(capabilities.engine_version)
    }
  } catch (error) {
    claim.error(`probe failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Reconciles a previous process's in-flight attempts (§26 Restart mid-attempt): running →
 * stalled with a recovery note; the scheduler re-checks before any replacement starts.
 */
function reconcileRunningAttempts(store: SqliteStore): void {
  const at = new Date().toISOString()
  store.atomic(() => {
    for (const attempt of store.attempts.list({ state: 'running' })) {
      store.attempts.save({ ...attempt, state: 'stalled', updatedAt: at })
      const stream = `attempt:${String(attempt.id)}`
      const seq = (store.events.read(stream).at(-1)?.seq ?? 0) + 1
      store.events.append(stream, {
        stream,
        seq,
        at,
        type: 'attempt.reconciled',
        body: {
          note: 'host restarted: check the worktree, git history and outbox before repeating any outside action',
        },
      })
    }
  })
}

function registerEffectHandlers(
  store: SqliteStore,
  health: HealthBoardImpl,
  policyHash: string,
  metaAgent: () => MetaAgentService | undefined,
): void {
  for (const kind of EFFECT_KINDS) {
    const claim = health.claim(`effects:${kind}`)
    claim.ready()
    const run: EffectHandler =
      kind === 'launch'
        ? launchHandler(store, policyHash)
        : kind === 'relay'
          ? relayHandler(metaAgent)
          : unsupportedHandler(kind)
    store.effects.handle(
      kind,
      guard(claim, run),
      // The queue itself forces relay/note to run strictly one at a time, in order.
      { concurrency: 2 },
    )
  }
}

/** Moves the kind's health entry to error on a failed run and back to ready on the next. A deferral is no failure. */
function guard(claim: HealthClaim, run: EffectHandler): EffectHandler {
  return async (payload: Json) => {
    claim.ready()
    try {
      await run(payload)
    } catch (error) {
      if (!(error instanceof Later)) claim.error(error instanceof Error ? error.message : String(error))
      throw error
    }
  }
}

/** A wake with no meta agent to run it waits for a configured slot rather than being lost. */
function relayHandler(metaAgent: () => MetaAgentService | undefined): EffectHandler {
  return async (payload) => {
    const service = metaAgent()
    if (service === undefined) throw new Later('no meta agent is configured')
    await service.runRelay(payload)
  }
}

/** Nothing produces this kind yet, so a row of it is a bug, and it must not settle as success. */
function unsupportedHandler(kind: string): EffectHandler {
  return async () => {
    throw new Error(`unsupported effect: ${kind}`)
  }
}

function launchHandler(store: SqliteStore, policyHash: string): EffectHandler {
  return async (payload) => {
    // A failed attempt stays failed: the row keeps failing until the queue gives up on it, where
    // the gate below would drain it as refused.
    const failure = launchFailure(store, payload)
    if (failure !== undefined) throw new Error(`launch failed: ${failure}`)
    // The gate (§13, §20) comes first on every path. `Later` keeps a held launch's row; a drop
    // returns normally, so the row drains with its refusal on record.
    const at = new Date().toISOString()
    const authority = launchAuthority(store, payload, at, policyHash)
    if (authority.verdict === 'defer') throw new Later(authority.reason)
    if (authority.verdict === 'drop') {
      store.atomic(() => refuseLaunch(store, payload, authority.reason, at))
      return
    }
    // With the fake flag, the recorded fixture stands in for a Claude attempt.
    if (process.env.MEC_FAKE_ENGINE === '1') {
      await runFakeLaunch(store, payload)
      return
    }
    // No real runtime is wired at this milestone, and a launch that cannot run says so. Not
    // `Later`: a future runner would pick up stale work.
    store.atomic(() => failLaunch(store, payload, 'no_runner', at))
    throw new Error('launch failed: no_runner')
  }
}

/**
 * Replays the smoke fixture as if a Claude attempt had run (plan §17's launch handler):
 * every engine event lands on the attempt's `attempt:<id>` stream as a CoreForEngines-ish
 * fact and the attempt doc walks queued → running → terminal.
 */
async function runFakeLaunch(store: SqliteStore, payload: Json): Promise<void> {
  const record = (payload ?? {}) as { attempt_id?: unknown; attemptId?: unknown }
  const attemptId =
    typeof record.attempt_id === 'string' && record.attempt_id !== ''
      ? record.attempt_id
      : typeof record.attemptId === 'string' && record.attemptId !== ''
        ? record.attemptId
        : `att_${randomBytes(6).toString('hex')}`
  const generation = 0
  const engine = new FakeEngine(FIXTURE_SMOKE_DIR)
  // The scheduler (§11) builds real briefs; the fake path needs only the identity fields
  // the replay reads (attempt_id, generation).
  const handle = await engine.launch({
    brief: { attempt_id: attemptId, generation } as unknown as LaunchSpec['brief'],
    env: {},
    cwd: FIXTURE_SMOKE_DIR,
    bridge: DENY_BRIDGE,
  })

  const stream = `attempt:${attemptId}`
  let state:
    | 'queued'
    | 'running'
    | 'succeeded'
    | 'checks_failed'
    | 'quota_wait'
    | 'auth_required'
    | 'provider_down' = 'queued'
  let terminal: string | undefined
  let exitCode: number | undefined
  const saveAttempt = (): void => {
    store.atomic(() => {
      store.attempts.save({
        // The queued doc names the task and work a stop and a lift find this attempt by.
        ...store.attempts.get(attemptId),
        id: attemptId,
        state,
        generation,
        engine: 'claude',
        ...(terminal !== undefined && { terminal_reason: terminal }),
        ...(exitCode !== undefined && { exit_code: exitCode }),
        updatedAt: new Date().toISOString(),
      })
    })
  }
  saveAttempt()

  for await (const event of engine.events(handle)) {
    if (event.type === 'session_started') state = 'running' // queued --agent_started--> running (§10)
    const seq = (store.events.read(stream).at(-1)?.seq ?? 0) + 1 // gap-free across a relaunch
    store.events.append(stream, {
      stream,
      seq,
      at: event.at,
      type: event.type,
      body: { ...event, seq } as Json,
    })
    if (event.type === 'exit') {
      exitCode = event.code
      terminal = event.terminal_reason
      state = event.terminal_reason === 'completed' ? 'succeeded' : 'checks_failed'
    }
  }
  // §26 Quota park (composition half): a rejected rate limit or a quota/auth error class
  // parks the attempt with its workspace preserved — the state the scheduler re-checks
  // before replacing anything (parkFromEvents is the same classifier the real adapter feeds).
  const park = parkFromEvents(
    store.events.read(stream).map((e) => e.body as { type?: string } & Record<string, unknown> as never),
  )
  if (park.park) {
    state = park.state
    terminal = park.state
  }
  saveAttempt()
}
