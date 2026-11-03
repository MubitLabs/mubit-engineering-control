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
import type { LaunchSpec } from '@mec/contracts'
import { BridgeImpl, MecToolsServer } from '@mec/mec-tools'
import { fakeBrain, MetaAgentService, RealClaudeBrain } from '@mec/meta'
import { loadPolicy } from '@mec/policy'
import { parkFromEvents } from '@mec/runtime'
import type { EffectHandler, HealthClaim, Json } from '@mec/store'
import { DirLock, HealthBoardImpl, MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
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

export async function startServer(opts: { dataDir: string; policyText?: string }): Promise<RunningServer> {
  const lock = DirLock.acquire(opts.dataDir)
  mkdirSync(opts.dataDir, { recursive: true })
  const db = new Database(join(opts.dataDir, 'mec.db'))
  migrate(db, MIGRATIONS_v1)
  const store = new SqliteStore(db)
  const health = new HealthBoardImpl()
  health.claim('runtime').ready('composition root up')
  // Fail fast: a policy that cannot load never starts a server that would enforce it.
  loadPolicy(opts.policyText ?? DEFAULT_POLICY_TEXT)

  registerEffectHandlers(store, health)

  // §26 Pause: no launch, deliver, relay or outbound message runs while paused; jobs that
  // were mid-handler finish (the pass simply stops starting new ones). On resume, waiting
  // deadlines shift by the pause length so nothing fires late-but-eagerly.
  let paused = false
  let pausedAt: number | undefined
  const pauseControl = {
    pause(): void {
      paused = true
      pausedAt = Date.now()
    },
    resume(): void {
      if (!paused) return
      paused = false
      const shift = Date.now() - (pausedAt ?? Date.now())
      if (shift > 0) store.effects.shiftWaiting?.(shift)
    },
    isPaused(): boolean {
      return paused
    },
  }
  const queueTimer = setInterval(() => {
    if (paused) return
    void store.effects.run().catch(() => {})
  }, PASS_INTERVAL_MS)
  queueTimer.unref()
  void store.effects.run().catch(() => {})

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
    policyText: opts.policyText ?? DEFAULT_POLICY_TEXT,
    // §6 composed path: the meta-agent executor owns chat turns. MEC_FAKE_ENGINE=1 uses the
    // scripted fake; otherwise the REAL brain (R1.4): the meta agent on a dedicated Claude
    // slot (MEC_META_SLOT) through the platform tools.
    ...(process.env.MEC_FAKE_ENGINE === '1' && {
      metaAgent: new MetaAgentService({
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
    }),
    ...(process.env.MEC_FAKE_ENGINE !== '1' &&
      process.env.MEC_META_SLOT !== undefined && {
        metaAgent: new MetaAgentService({
          store,
          effects: store.effects,
          brain: new RealClaudeBrain({
            slotDir: process.env.MEC_META_SLOT,
            toolsSecret: randomBytes(24).toString('hex'),
          }).asBrain(),
        }),
      }),
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
    // The final snapshot answers `not running` (instances 0, not answering) so `mec status`
    // never reports a dead server as healthy.
    const final = buildHealthSnapshot(store, health)
    final.runtime = { state: 'paused', instances: 0, answering: false }
    writeFileSync(healthPath, `${JSON.stringify(final, null, 2)}\n`)
    await tools.stop()
    await app.close()
    await store.effects.drain().catch(() => {})
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

const EFFECT_KINDS = ['launch', 'deliver', 'relay', 'note', 'reply', 'external', 'probe'] as const

function registerEffectHandlers(store: SqliteStore, health: HealthBoardImpl): void {
  for (const kind of EFFECT_KINDS) {
    const claim = health.claim(`effects:${kind}`)
    claim.ready()
    const run: EffectHandler = kind === 'launch' ? launchHandler(store) : async () => {}
    store.effects.handle(
      kind,
      guard(claim, run),
      // The queue itself forces relay/note to run strictly one at a time, in order.
      { concurrency: 2 },
    )
  }
}

/** Moves the kind's health entry to error on a failed run and back to ready on the next. */
function guard(claim: HealthClaim, run: EffectHandler): EffectHandler {
  return async (payload: Json) => {
    claim.ready()
    try {
      await run(payload)
    } catch (error) {
      claim.error(error instanceof Error ? error.message : String(error))
      throw error
    }
  }
}

function launchHandler(store: SqliteStore): EffectHandler {
  return async (payload) => {
    // Without the fake flag a launch is acknowledged (no real runtime is wired at this
    // milestone); with it, the recorded fixture stands in for a Claude attempt.
    if (process.env.MEC_FAKE_ENGINE !== '1') return
    await runFakeLaunch(store, payload)
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
