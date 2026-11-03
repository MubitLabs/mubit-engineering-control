/**
 * The fixture-replaying `EngineAdapter` double (CONTRACTS §4 and §9): it yields a recorded
 * engine stream as enveloped `EngineEvent`s without spawning a process.
 *
 * A fixture directory holds `meta.json`, `raw.jsonl` (unused here — adapter-to-engine parsing is
 * the conformance suite's job) and `events.jsonl`, whose bodies carry no envelope: the replay
 * assigns `seq` 1..n in file order, the fixed `at` from the constructor options, and the
 * `attempt_id`/`generation` of the handle it was launched with.
 *
 * Interrupts and stops are public flags; a flag set before the next yield ends iteration early,
 * so a flag set before iterating yields nothing. Inputs are recorded, never queued — fixtures are
 * one-shot.
 */
import { createReadStream, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  AttemptHandle,
  AuthHealth,
  Capabilities,
  EngineAdapter,
  EngineEvent,
  EngineEventBody,
  ErrorClass,
  EventEnvelope,
  FixtureMeta,
  Input,
  LaunchSpec,
  Report,
  SlotRef,
} from '@mec/contracts'

const META_FILE = 'meta.json'
const EVENTS_FILE = 'events.jsonl'
const DEFAULT_AT = '2026-11-03T00:00:00.000Z'

export class FakeEngine implements EngineAdapter {
  readonly meta: FixtureMeta
  /** Every `launch` call, in order. */
  readonly launches: LaunchSpec[] = []
  /** Every `send` call, in order; nothing is ever queued for the fixture to consume. */
  readonly sent: Input[] = []
  /** Set by `interrupt`; ends the event iteration before its next yield. */
  interrupted = false
  /** Set by `stop`; ends the event iteration before its next yield. */
  stopped = false

  readonly #dir: string
  readonly #at: string
  #bodies: EngineEventBody[] | null = null

  constructor(fixtureDir: string, opts: { at?: string } = {}) {
    this.#dir = fixtureDir
    this.#at = opts.at ?? DEFAULT_AT
    this.meta = JSON.parse(readFileSync(join(fixtureDir, META_FILE), 'utf8')) as FixtureMeta
  }

  async probe(_slot: SlotRef): Promise<{ capabilities: Capabilities; auth: AuthHealth }> {
    const bodies = this.#bodiesCache()
    const hasUsage = bodies.some((body) => body.type === 'usage')
    const hasRateLimit = bodies.some((body) => body.type === 'rate_limit')
    return {
      capabilities: {
        engine_version: this.meta.engine_version,
        flags_verified: [],
        structured_stream: true,
        questions: false,
        tool_approval: false,
        interrupt: false,
        resume: false,
        usage: hasUsage,
        rate_limit_events: hasRateLimit,
        sandbox: false,
        restricted_mode: false,
        mcp_http: false,
        usage_mode: hasUsage ? 'cumulative' : 'none',
      },
      auth: { logged_in: true },
    }
  }

  async launch(spec: LaunchSpec): Promise<AttemptHandle> {
    this.launches.push(spec)
    const started = this.#bodiesCache().find((body) => body.type === 'session_started')
    return {
      attempt_id: spec.brief.attempt_id,
      generation: spec.brief.generation,
      session_id:
        started !== undefined && started.type === 'session_started' ? started.session_id : undefined,
    }
  }

  async send(_h: AttemptHandle, input: Input): Promise<void> {
    this.sent.push(structuredClone(input))
  }

  async interrupt(_h: AttemptHandle): Promise<void> {
    this.interrupted = true
  }

  async stop(_h: AttemptHandle): Promise<void> {
    this.stopped = true
  }

  events(h: AttemptHandle): AsyncIterable<EngineEvent> {
    return this.#replay(h)
  }

  classify(error: unknown): ErrorClass {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
    const text = message.toLowerCase()
    if (text.includes('auth')) return 'auth'
    if (text.includes('quota') || text.includes('rate')) return 'quota'
    if (text.includes('provider')) return 'provider_down'
    return 'unknown'
  }

  mapReport(_final: unknown): Report {
    const report: Report = { kind: 'ready', summary: 'fixture replay complete' }
    // The v0 `FixtureMeta` schema carries no head_sha/checks_run; read them leniently so a
    // recording that grows them is still echoed.
    const expected = this.meta.expected as { head_sha?: string; checks_run?: string[] }
    if (expected.head_sha !== undefined) report.head_sha = expected.head_sha
    if (expected.checks_run !== undefined) report.checks_run = expected.checks_run
    return report
  }

  /** Lazily reads `events.jsonl` line by line; a stop flag set before a yield ends the replay. */
  async *#replay(h: AttemptHandle): AsyncGenerator<EngineEvent> {
    const lines = createInterface({
      input: createReadStream(join(this.#dir, EVENTS_FILE)),
      crlfDelay: Infinity,
    })
    let seq = 0
    try {
      for await (const line of lines) {
        if (this.stopped || this.interrupted) return
        const text = line.trim()
        if (text === '') continue
        const body = JSON.parse(text) as EngineEventBody
        seq += 1
        const envelope: EventEnvelope = {
          seq,
          at: this.#at,
          attempt_id: h.attempt_id,
          generation: h.generation,
        }
        yield { ...body, ...envelope }
      }
    } finally {
      lines.close()
    }
  }

  #bodiesCache(): EngineEventBody[] {
    if (this.#bodies === null) {
      const text = readFileSync(join(this.#dir, EVENTS_FILE), 'utf8')
      this.#bodies = text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as EngineEventBody)
    }
    return this.#bodies
  }
}
