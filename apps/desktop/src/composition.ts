/**
 * The composition root (plan §17/§21): one process owns the data directory (`DirLock`),
 * opens and migrates the SQLite store, registers the effect handlers, keeps the §21.2
 * health snapshot that `mec status` reads warm, starts the mec-tools MCP server and serves
 * the composition server. Every seam above is a landed package; this module only wires
 * them and owns their lifetimes.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HealthBoard, LaunchSpec, Store, StoreDoc } from '@mec/contracts'
import { Later } from '@mec/contracts'
import { ClaudeAdapter } from '@mec/engines'
import { headSha } from '@mec/git'
import { BridgeImpl, MecToolsServer } from '@mec/mec-tools'
import {
  FollowUps,
  failLaunch,
  fakeBrain,
  launchAuthority,
  launchFailure,
  MetaAgentService,
  type MetaBrain,
  processingOf,
  RealClaudeBrain,
  refuseLaunch,
  type SetupDecide,
  saveProcessing,
} from '@mec/meta'
import { loadPolicy } from '@mec/policy'
import { defaultsRoot } from '@mec/prompts'
import { ownedSpawn, parkFromEvents, processStart, redactEvent, Supervisor } from '@mec/runtime'
import type { ProbeRun } from '@mec/slots'
import type { EffectHandler, HealthClaim, Json } from '@mec/store'
import { DirLock, HealthBoardImpl, InspectionReads, MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import { FakeEngine } from '@mec/testkit'
import Database from 'better-sqlite3'
import { AttemptLauncher } from './attempt-launch'
import { backupStore } from './backup-cli'
import { type Cleaner, StoreFacts } from './core-facts'
import { Delivery } from './delivery'
import { plannerPlacement } from './planner-placement'
import { savedPolicyText } from './policy-store'
import {
  defaultProbeRun,
  dropResume,
  enqueueProbes,
  isRecheckRow,
  isResumeRow,
  markResumed,
  PLANNER_DOC,
  probeSlot,
  reconcileExternal,
  reconcilePlanner,
  reconcileProcesses,
  reconcileStalled,
  recordPark,
  replayJournals,
  resumeAuthority,
  resumeParked,
} from './recovery'
import { type CardOutcome, defaultGhRun, defaultGitExec } from './release'
import { buildHealthSnapshot, buildServer } from './server'
import { applyApprovedSwitches, autoFailover, requestSwitch, type SwitchDeps } from './slot-switch'
import { specialistBridge, specialistTools } from './specialist-tools'

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

/** The planner's stop, escalation included, and its close: long enough for SIGKILL to be confirmed. */
const BRAIN_CLOSE_GRACE_MS = 5000

/** §5.8: "every few minutes". Local, and free of quota. */
const PROBE_INTERVAL_MS = 3 * 60_000

/** A boot waits this long for the remote before serving; what it could not read waits for the next. */
const EXTERNAL_BOUND_MS = 30_000

/** §20 Pause: these kinds wait. Reports, notes and probes do not, or a finishing attempt strands. */
const PAUSE_DEFERS = ['deliver', 'launch', 'relay', 'reply'] as const

/**
 * The safe-side decider for what is not a specialist: the fake path and the tools server's own
 * surface. Composition point: once the confirmation inbox backs the bridge, this callback becomes
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

/** Where the planner's slot is: its home, and whether that home is the linked default. */
type MetaSlot = { dir: string; linked: boolean }

/**
 * The fake engine's setup turn: `propose <target> <json patch>` drafts a change and nothing else,
 * so a scratch server can walk a proposal to Apply without a model. Only under MEC_FAKE_ENGINE.
 */
const scriptedSetupDecide: SetupDecide = async ({ text }) => {
  const match = /^propose (\w+) (.+)$/s.exec(text.trim())
  if (match === null) return { calls: [], reply: 'The fake engine only understands: propose <target> <json>' }
  return {
    calls: [
      {
        tool: 'propose_change',
        args: { target: match[1], reason: 'proposed in setup chat', patch: JSON.parse(match[2] ?? '{}') },
      },
    ],
    reply: 'Drafted. Nothing changes until you apply it in Settings.',
  }
}

/** The wizard's persisted meta-slot choice → that slot's home dir. Best-effort: an absent
 *  or dangling choice means "not chosen yet" (undefined), never a crash on startup. A retired
 *  slot is refused by name on the health board: no probe brings one back (§5.5), where a
 *  degraded slot can recover, and this runs once per start. */
function metaSlotFromStore(store: Store, health: HealthBoard): MetaSlot | undefined {
  const setting = store.engines.get('settings/meta-slot')
  const slotId = setting !== undefined && typeof setting.slotId === 'string' ? setting.slotId : undefined
  if (slotId === undefined) return undefined
  const slot = store.slots.get(slotId)
  if (slot === undefined || typeof slot.home !== 'string' || slot.home === '') return undefined
  if (slot.state === 'retired') {
    const why = `slot ${slotId} is retired, so it cannot run the meta agent: choose another slot`
    health.claim(`slot:${slotId}`).error(why)
    return undefined
  }
  return { dir: slot.home, linked: slot.linkedDefault === true }
}

/** A path given directly is a dedicated home; only a linked slot doc runs with the variable unset. */
const metaSlotAt = (dir: string | undefined): MetaSlot | undefined =>
  dir === undefined ? undefined : { dir, linked: false }

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
  /** A test seam: the probe's command runner. Given one, slots are probed with no runner flag too. */
  probeRun?: ProbeRun
}): Promise<RunningServer> {
  // Fail fast: a build without its prompts never starts, before it takes the lock (§16).
  defaultsRoot()
  const lock = DirLock.acquire(opts.dataDir)
  mkdirSync(opts.dataDir, { recursive: true })
  const db = new Database(join(opts.dataDir, 'mec.db'))
  migrate(db, MIGRATIONS_v1)
  const store = new SqliteStore(db)
  const health = new HealthBoardImpl()
  const metaSlot =
    metaSlotAt(opts.metaSlotDir) ?? metaSlotFromStore(store, health) ?? metaSlotAt(process.env.MEC_META_SLOT)
  health.claim('runtime').ready('composition root up')
  // Fail fast: a policy that cannot load never starts a server that would enforce it.
  // A policy saved from Settings wins (M3.3): it is read here, once, so an edit needs a restart.
  const policyText = savedPolicyText(store) ?? opts.policyText ?? DEFAULT_POLICY_TEXT
  const policy = loadPolicy(policyText)

  // The relay handler reads this late: rows can wait for a meta agent, and one may never come.
  let metaAgent: MetaAgentService | undefined
  // The launch handler reads this late too: the launcher needs the tools server, which is up
  // before the first queue pass. It stays undefined with the runner flag off.
  let launcher: AttemptLauncher | undefined
  const followups = new FollowUps({ store, effects: store.effects, runtime: () => launcher })
  const iso = (): string => new Date().toISOString()
  const stored = processingOf(store)
  let paused = stored.paused
  let pausedAt = stored.pausedAt
  // Probing needs the vendor CLI, so it follows the runner, or a test's own command runner.
  const probeRun = opts.probeRun ?? defaultProbeRun
  const probing = (): boolean => opts.probeRun !== undefined || launcher !== undefined
  registerEffectHandlers(
    store,
    health,
    policy.versionHash,
    () => metaAgent,
    () => launcher,
    followups,
    () => paused,
    (slotId) => probeSlot(store, slotId, probeRun, iso),
  )

  // §11: never while paused, and a failed pass is the next pass's to retry.
  const schedulerPass = (): void => {
    if (paused) return
    try {
      metaAgent?.runPass()
    } catch (error) {
      console.error(`[scheduler] pass failed: ${String(error)}`)
    }
  }
  const clean: Cleaner = <T>(attemptId: string, value: T): T =>
    redactEvent(value as never, launcher?.fingerprints() ?? [], launcher?.exactsFor(attemptId) ?? []) as T
  const facts = new StoreFacts(store, clean, undefined, {
    followups,
    changed: () => setImmediate(schedulerPass),
    parked: (doc, state, reason, resetsAt, at) => {
      recordPark(store, store.effects, doc, {
        state,
        reason,
        ...(resetsAt !== undefined && { resetsAt }),
        at,
      })
    },
  })

  // §20, O9: the boot order. Nothing runs and nothing is dispatched until all of this is done.
  const processDeps = { store, effects: store.effects, dataDir: opts.dataDir, now: iso }
  const boot: string[] = []
  replayJournals(facts, store, opts.dataDir)
  boot.push('journal')
  await reconcilePlanner(store)
  await reconcileProcesses(processDeps)
  boot.push('processes')
  const reconciled: { card: StoreDoc; outcome: CardOutcome }[] = []
  await within(
    EXTERNAL_BOUND_MS,
    reconcileExternal({
      store,
      effects: store.effects,
      run: defaultGhRun,
      git: defaultGitExec,
      now: () => new Date(),
    }).then((settled) => reconciled.push(...settled)),
  )
  boot.push('external')
  // Plan §17: rows a previous process left running resume here, once, before the first pass.
  // A later pass must not touch them: the running ones are then this process's own jobs.
  store.effects.resumeRunning()
  boot.push('effects')
  // §26 Capability drift: probe the configured engine slot at startup; a binary that lost a
  // required flag degrades the slot to engine_unsupported BEFORE any attempt starts.
  if (process.env.MEC_PROBE_SLOT !== undefined && process.env.MEC_PROBE_SLOT !== '') {
    await probeSlotAtStartup(store, health, process.env.MEC_PROBE_SLOT)
  }

  // §26 Pause: no launch, deliver, relay or outbound message runs while paused, each kind by its
  // own `Later`; jobs that were mid-handler finish, and probes and notes go on. On resume, waiting
  // deadlines shift by the pause length so nothing fires late-but-eagerly. Decision #21: the
  // pause is stored, so it outlives a restart and the shift still counts from its first moment.
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
        store.effects.wakeDeferred(PAUSE_DEFERS)
      })
      // After the shift, so a message the pause held back runs on the next pass (#27).
      metaAgent?.enqueueResumes()
      schedulerPass()
    },
    isPaused(): boolean {
      return paused
    },
  }

  const planner = composePlanner(store, { ...opts, policyText }, metaSlot, followups)
  // The first of the planner's tmpdirs may be written before this; the doc is what a boot reads.
  metaAgent = planner?.service
  // §20 App crash: a turn the crash cut short resumes through the queue, never inline. While
  // paused, resume does this instead, and it comes after the deadline shift.
  if (!paused) metaAgent?.enqueueResumes()

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

  // mec-tools (A3) on an ephemeral port with a per-process secret; the launcher mints an
  // attempt-scoped token per launch (plan §6). `MEC_REAL_RUNNER=1` grants no authority: mandate,
  // hold and repo checks run on every launch, with or without it.
  const toolsSecret = randomBytes(32).toString('hex')
  const closing = new AbortController()
  const cards = { followups, policy, clean, signal: closing.signal }
  const tools = new MecToolsServer({
    secret: toolsSecret,
    bridge: DENY_BRIDGE,
    onCall: specialistTools({ store, facts, headOf: headSha, cards }),
  })
  const { url: toolsUrl } = await tools.start()
  const realRunner = process.env.MEC_REAL_RUNNER === '1'
  if (realRunner && process.env.MEC_FAKE_ENGINE !== '1') {
    launcher = new AttemptLauncher({
      store,
      dataDir: opts.dataDir,
      policyText,
      facts,
      tools: {
        url: toolsUrl,
        secret: toolsSecret,
        bumpGeneration: (attemptId) => tools.bumpGeneration(attemptId),
      },
      bridge: specialistBridge(store, cards),
      gate: (payload) =>
        (isResumeRow(payload) ? resumeAuthority : launchAuthority)(store, payload, iso(), policy.versionHash),
      drop: (payload, { reason }) => {
        const refuse = isResumeRow(payload) ? dropResume : refuseLaunch
        store.atomic(() => refuse(store, payload, reason as never, iso()))
      },
      resumed: (payload) => store.atomic(() => markResumed(store, payload, iso())),
      resumeEnded: (payload, reason) => store.atomic(() => dropResume(store, payload, reason, iso())),
      stalled: (attemptId) => {
        reconcileStalled(processDeps, attemptId).catch((error: unknown) => {
          console.error(`[recovery] ${attemptId}: ${String(error)}`)
        })
      },
    })
  }

  // M2.3 follows the runner: with the flag off nothing is accepted, so nothing could deliver.
  const delivery =
    launcher === undefined
      ? undefined
      : new Delivery({
          store,
          effects: store.effects,
          dataDir: opts.dataDir,
          policyText: opts.policyText ?? DEFAULT_POLICY_TEXT,
        })

  // What a boot learned of a card reaches delivery the way an answer would.
  for (const { card, outcome } of reconciled) delivery?.hooks.onCardSettled(card, outcome)

  const switchDeps: SwitchDeps = {
    store,
    effects: store.effects,
    policy,
    now: iso,
    probe: (slotId) =>
      probing()
        ? probeSlot(store, slotId, probeRun, iso)
        : Promise.resolve(store.slots.get(slotId)?.state === 'healthy'),
    clean,
  }
  const parkDeps = { store, effects: store.effects, policyHash: policy.versionHash, now: iso }
  // §5.10: switches first, so an attempt that moved does not also resume.
  let ticking = false
  const parkPass = (): void => {
    if (paused || ticking || closing.signal.aborted) return
    ticking = true
    void autoFailover(switchDeps)
      .then(() => applyApprovedSwitches(switchDeps))
      .then(() => resumeParked(parkDeps))
      .catch((error: unknown) => console.error(`[recovery] park pass failed: ${String(error)}`))
      .finally(() => {
        ticking = false
      })
  }

  // The first pass waits for the tools server: a launch needs its URL. Rows a previous process
  // left running went back to pending above, before this.
  // §11: due effects first, then the scheduler. The queue's pass waits for its jobs, so the
  // scheduler runs on the timer itself and a slow launch never holds the next one back.
  const effectsPass = (): void => {
    void store.effects.run().catch(() => {})
  }
  const queueTimer = setInterval(() => {
    effectsPass()
    parkPass()
    schedulerPass()
    if (!paused) delivery?.kick()
  }, PASS_INTERVAL_MS)
  queueTimer.unref()
  const probeTimer = setInterval(() => {
    if (probing()) enqueueProbes(store, store.effects)
  }, PROBE_INTERVAL_MS)
  probeTimer.unref()
  if (probing()) enqueueProbes(store, store.effects)
  boot.push('dispatch')
  store.engines.save({ id: 'recovery/last-boot', order: boot, updatedAt: iso() })
  effectsPass()
  schedulerPass()

  const app = buildServer({
    store,
    effects: store.effects,
    health,
    inspection: new InspectionReads(db),
    policyText,
    pauseControl,
    // The data dir is the keystore root (§5.4), so a scratch server never reads real state.
    keystoreRoot: opts.dataDir,
    ...(metaAgent !== undefined && { metaAgent }),
    // §20: an on-demand backup of the live store.
    backups: { take: () => backupStore(db, opts.dataDir, join(opts.dataDir, 'backups')) },
    ...(process.env.MEC_FAKE_ENGINE === '1' && { setupDecide: scriptedSetupDecide }),
    ...(delivery !== undefined && { delivery: delivery.hooks }),
    parked: {
      switchSlot: (input) => requestSwitch(switchDeps, input),
      resumeNow: (workItemId) => resumeParked(parkDeps, { workItemId, explicit: true }),
    },
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
    closing.abort()
    clearInterval(queueTimer)
    clearInterval(probeTimer)
    clearInterval(healthTimer)
    planner?.quiesce()
    launcher?.quiesce()
    // The final snapshot answers `not running` (instances 0, not answering) so `mec status`
    // never reports a dead server as healthy.
    const final = buildHealthSnapshot(store, health)
    final.runtime = { state: 'paused', instances: 0, answering: false }
    writeFileSync(healthPath, `${JSON.stringify(final, null, 2)}\n`)
    // Before the tools go: an engine that loses its tools mid-turn fails instead of stopping.
    if (launcher !== undefined) await within(opts.closeBoundMs ?? CLOSE_BOUND_MS, launcher.close())
    if (delivery !== undefined) await within(opts.closeBoundMs ?? CLOSE_BOUND_MS, delivery.close())
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
      // The kill is what an engine ignoring SIGTERM gets, and it is what lets the turn end, so the
      // brain removes its token dir. Whatever is left stays on the doc for the next boot.
      await within(
        BRAIN_CLOSE_GRACE_MS,
        planner
          .abort()
          .then(() => planner.kill())
          .then(() => planner.close()),
      )
      const { process: _ended, ...doc } = store.engines.get(PLANNER_DOC) ?? {}
      const dirs = doc.tempDirs
      const left = (Array.isArray(dirs) ? dirs.map(String) : []).filter((dir) => existsSync(dir))
      store.engines.save({ ...doc, id: PLANNER_DOC, tempDirs: left, updatedAt: iso() })
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
type PlannerLifetime = {
  quiesce: () => void
  abort: () => Promise<void>
  /** Past a polite stop: SIGKILL, confirmed. */
  kill: () => Promise<void>
  close: () => Promise<void>
}

const NO_ENGINE: PlannerLifetime = {
  quiesce: () => {},
  abort: async () => {},
  kill: async () => {},
  close: async () => {},
}

/**
 * The planner's engine as an owned group (§8.1): `BrainEngine` can only ask it to stop, so one
 * ignoring SIGTERM would outlive the server with a bearer token on disk. Its identity and its
 * tmpdirs go on one doc, so a boot after a crash can end both.
 */
function plannerEngine(store: SqliteStore): {
  adapter: ClaudeAdapter
  onTempDir: (dir: string) => void
  kill: () => Promise<void>
} {
  const supervisor = new Supervisor()
  const save = (fields: StoreDoc): void => {
    const doc = store.engines.get(PLANNER_DOC) ?? {}
    store.engines.save({ ...doc, ...fields, id: PLANNER_DOC, updatedAt: new Date().toISOString() })
  }
  let turns = 0
  const adapter = new ClaudeAdapter({
    spawnFn: (argv, spawnOpts) => {
      turns += 1
      const owner = { attemptId: 'att_planner', generation: turns }
      const spawn = ownedSpawn(supervisor, owner, {
        onStderr: (chunk) => {
          const line = chunk.trim()
          if (line !== '') console.error(`[engine:stderr] ${line}`)
        },
        onStart: (pid) => {
          const started = processStart(pid)
          if (started !== undefined) save({ process: { pid, started } })
        },
      })
      return spawn(argv, spawnOpts)
    },
  })
  return {
    adapter,
    onTempDir: (dir) => {
      const known = store.engines.get(PLANNER_DOC)?.tempDirs
      save({ tempDirs: [...(Array.isArray(known) ? known.map(String) : []), dir] })
    },
    kill: async () => {
      const stops = Array.from({ length: turns }, (_, index) => index + 1)
        .filter((generation) => supervisor.owns('att_planner', generation))
        .map((generation) => supervisor.stop('att_planner', generation, { graceMs: 200 }))
      await Promise.allSettled(stops)
    },
  }
}

/**
 * §6 composed path: the meta-agent executor owns chat turns. MEC_FAKE_ENGINE=1 uses the scripted
 * fake; otherwise the REAL brain (R1.4), the meta agent on a dedicated Claude slot
 * (MEC_META_SLOT) through the platform tools. With neither, there is no meta agent.
 */
function composePlanner(
  store: SqliteStore,
  opts: { dataDir: string; brain?: MetaBrain; policyText: string },
  metaSlot: MetaSlot | undefined,
  followups: FollowUps,
): ({ service: MetaAgentService } & PlannerLifetime) | undefined {
  const launchRowState = (key: string): string | undefined => store.effects.snapshot('launch', key)?.state
  const placement = { ...plannerPlacement(store, opts.dataDir), followups, launchRowState }
  if (opts.brain !== undefined) {
    return {
      service: new MetaAgentService({
        store,
        effects: store.effects,
        brain: opts.brain,
        policyText: opts.policyText,
        ...placement,
      }),
      ...NO_ENGINE,
    }
  }
  if (process.env.MEC_FAKE_ENGINE === '1') {
    return {
      service: new MetaAgentService({
        store,
        effects: store.effects,
        policyText: opts.policyText,
        followups,
        launchRowState,
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
  if (metaSlot === undefined) return undefined
  // Held so `close` can reach it; its close waits for a turn in flight, so `close` bounds that.
  const engine = plannerEngine(store)
  const brain = new RealClaudeBrain({
    adapter: engine.adapter,
    onTempDir: engine.onTempDir,
    slotDir: metaSlot.dir,
    linked: metaSlot.linked,
    toolsSecret: randomBytes(24).toString('hex'),
    // §5.4: the data dir is the root, so a scratch server never reads the real prompts.
    promptsRoot: join(opts.dataDir, 'prompts'),
  })
  return {
    service: new MetaAgentService({
      store,
      effects: store.effects,
      policyText: opts.policyText,
      ...placement,
      brain: brain.asBrain(),
    }),
    quiesce: () => brain.quiesce(),
    abort: () => brain.abort(),
    kill: engine.kill,
    close: () => brain.close(),
  }
}

/** A pass starts kinds in this order, so a delivery goes before a launch that is also due (§11). */
const EFFECT_KINDS = ['deliver', 'launch', 'relay', 'note', 'reply', 'external', 'probe'] as const

/**
 * §26 Capability drift: a startup probe degrades the slot before any attempt starts. The
 * probe is the vendor's own --version/--help/auth status (§5.8); MEC_PROBE_SLOT is a
 * dedicated CLAUDE_CONFIG_DIR home. The doc records the probe and names no home, so nothing
 * launches on it.
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

function registerEffectHandlers(
  store: SqliteStore,
  health: HealthBoardImpl,
  policyHash: string,
  metaAgent: () => MetaAgentService | undefined,
  launcher: () => AttemptLauncher | undefined,
  followups: FollowUps,
  isPaused: () => boolean,
  probe: (slotId: string) => Promise<boolean>,
): void {
  for (const kind of EFFECT_KINDS) {
    const claim = health.claim(`effects:${kind}`)
    claim.ready()
    const run: EffectHandler =
      kind === 'launch'
        ? launchHandler(store, policyHash, launcher)
        : kind === 'relay'
          ? relayHandler(metaAgent)
          : kind === 'deliver'
            ? (payload) => followups.runDeliver(payload)
            : kind === 'note'
              ? (payload) => followups.runNote(payload)
              : kind === 'probe'
                ? probeHandler(probe)
                : unsupportedHandler(kind)
    const pauses = (PAUSE_DEFERS as readonly string[]).includes(kind)
    const gated: EffectHandler = async (payload) => {
      if (pauses && isPaused()) throw new Later('processing is paused')
      await run(payload)
    }
    store.effects.handle(
      kind,
      guard(claim, gated),
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

/** §5.8: one slot's local status. Health is the slot doc's; a failed probe is a degraded slot. */
function probeHandler(probe: (slotId: string) => Promise<boolean>): EffectHandler {
  return async (payload) => {
    const { slot_id: slotId } = (payload ?? {}) as { slot_id?: unknown }
    if (typeof slotId === 'string') await probe(slotId)
  }
}

/** Nothing produces this kind yet, so a row of it is a bug, and it must not settle as success. */
function unsupportedHandler(kind: string): EffectHandler {
  return async () => {
    throw new Error(`unsupported effect: ${kind}`)
  }
}

function launchHandler(
  store: SqliteStore,
  policyHash: string,
  launcher: () => AttemptLauncher | undefined,
): EffectHandler {
  return async (payload) => {
    if (isResumeRow(payload)) return resumeRow(store, policyHash, launcher, payload)
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
    // Returns once the engine runs: a monitor owns the attempt, so this job does not hold one
    // of the kind's two places, and `settle` does not wait out an attempt.
    const real = launcher()
    if (real !== undefined) {
      await real.launch(payload)
      return
    }
    // The flag is off, and a launch that cannot run says so. Not `Later`: a runner turned on
    // later would pick up stale work.
    store.atomic(() => failLaunch(store, payload, 'no_runner', at))
    throw new Error('launch failed: no_runner')
  }
}

/** A new generation, or a second look at a head: its own gate, then the same runner. */
async function resumeRow(
  store: SqliteStore,
  policyHash: string,
  launcher: () => AttemptLauncher | undefined,
  payload: Json,
): Promise<void> {
  const at = new Date().toISOString()
  const authority = resumeAuthority(store, payload, at, policyHash)
  if (authority.verdict === 'defer') throw new Later(authority.reason)
  if (authority.verdict === 'drop') {
    store.atomic(() => dropResume(store, payload, authority.reason, at))
    return
  }
  if (process.env.MEC_FAKE_ENGINE === '1') {
    if (isRecheckRow(payload)) return
    store.atomic(() => markResumed(store, payload, at))
    await runFakeLaunch(store, payload)
    return
  }
  const real = launcher()
  if (real !== undefined) {
    await (isRecheckRow(payload) ? real.recheck(payload) : real.launch(payload))
    return
  }
  store.atomic(() => {
    dropResume(store, payload, 'no_runner', at)
    failLaunch(store, payload, 'no_runner', at)
  })
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
