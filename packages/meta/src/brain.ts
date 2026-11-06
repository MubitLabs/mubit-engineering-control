/**
 * The T5 planner driver (review 2026-11-04 §5.3): per turn it compiles the §5.1 context,
 * builds the meta agent's bundle from a protocol text plus the compiled context and the
 * nine tool schemas, launches the engine with the mec-tools MCP server in front of the
 * EXECUTED tool set, streams the events, and derives the decision from the tool journal —
 * the event stream, not the prose, is the source of truth. The turn budget caps the run;
 * a turn that completed without the protocol (ack, then plan/report/question) gets exactly
 * one corrective retry, the v0 discipline kept.
 *
 * The protocol text is READ FROM DISK, not a seam: `readMetaProtocol` loads T4's
 * `roles/meta_agent/protocol.md` (+ `planning.md`, §5.3's editable planning rules) — the
 * user's prompt store first (`~/.mec/prompts/`), the shipped defaults second
 * (`packages/prompts/defaults/`). A build that shipped no defaults throws rather than plan on
 * less than the shipped prompt; the built-in nine-tool text remains only for a caller that names
 * its own roots and they hold neither part. `readProtocol` stays
 * injectable so tests pin the protocol text without touching the filesystem. The bundle is
 * compiled with the same revisioned component machinery RealClaudeBrain uses, so the turn
 * still pins a revision.
 *
 * WAKES (§6/§1's gap): specialist reports and question answers re-invoke the planner with
 * the report/answer in context — `decide` accepts a wake descriptor and the context
 * compiler renders it as the turn's opening line, so a `blocked` report or a user's
 * answer is planned on instead of dropped.
 *
 * The transport seams are RealClaudeBrain's: an injectable engine adapter, the brain-owned
 * tmpdir with the read-only settings pair, the per-process tools server with an
 * attempt-scoped token, and the single-flight gate around decides.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AttemptHandle, EngineEvent, IsolationProfile, LaunchSpec } from '@mec/contracts'
import { Later } from '@mec/contracts'
import { ClaudeAdapter } from '../../engines/src/claude/adapter'
import { MecToolsServer } from '../../mec-tools/src/server'
import { issueToken } from '../../mec-tools/src/tokens'
import { META_AGENT_TOOLS, TOOL_SPECS } from '../../mec-tools/src/tools'
import { type CompiledBundle, compileBundle, componentHash } from '../../prompts/src/bundles'
import { buildAgentEnv } from '../../runtime/src/env'
import { buildAttemptSettings, serialiseAttemptSettings } from '../../runtime/src/isolation'
import { compilePlannerContext, type PlannerContextInput } from './context'
import type { BrainEngine } from './real-brain'
import type { MetaBrain } from './service'
import type {
  PlannerConfirmationDraft,
  PlannerPlanTask,
  PlannerQuestionRecord,
  PlannerTools,
  PlannerTurnJournal,
} from './tools'

/** One planner turn's wake: why the meta agent runs now, and what it should read first. */
export type PlannerWake = {
  reason: string
  detail?: string
}

/** What the driver needs per turn: the message, the work item, the wake, and the executed tools. */
export type PlannerTurnInput = {
  messageId: string
  messageText: string
  workItemId?: string
  wake?: PlannerWake
  /** The executed tool set for this turn; the driver never builds effects itself. */
  tools: PlannerTools
  /** The compiled §5.1 snapshot; when absent the driver compiles nothing and says so. */
  snapshot?: PlannerContextInput
}

/** The decision derived from the tool journal — the service's write set. */
export type PlannerDecision = {
  ack: string
  plan?: { tasks: PlannerPlanTask[] }
  questions: PlannerQuestionRecord[]
  confirmations: PlannerConfirmationDraft[]
  routes: PlannerTurnJournal['routes']
  spawns: PlannerTurnJournal['spawns']
  reports: PlannerTurnJournal['reports']
  stops: PlannerTurnJournal['stops']
  cancels: PlannerTurnJournal['cancels']
  escalated: boolean
  /** The prompt revision the turn ran under — the pin §5.1 asks for. */
  bundleRevision?: string
  /** True when the engine turn ended without completing the protocol even after the retry. */
  protocolIncomplete?: boolean
}

/**
 * The meta slot's layer. A linked slot sets nothing: naming `~/.claude` explicitly selects a
 * different macOS Keychain item than leaving the variable unset (`homes.ts`, issue #92252).
 */
export const metaSlotEnv = (slot: { slotDir: string; linked?: boolean }): Record<string, string> =>
  slot.linked === true ? {} : { CLAUDE_CONFIG_DIR: slot.slotDir }

export type PlannerBrainOptions = {
  /** Hears the tmpdir this brain makes: it holds a bearer token, so a boot must find it. */
  onTempDir?: (dir: string) => void
  /** The meta slot's engine home — `CLAUDE_CONFIG_DIR`, unless the slot is linked. */
  slotDir: string
  /** A linked slot: the engine's default home, with the variable absent (`homes.ts`). */
  linked?: boolean
  /** User home for the read-deny defaults; defaults to `$HOME`. */
  homeDir?: string
  /** The HMAC secret mec-tools tokens are signed with. */
  toolsSecret: string
  now?: () => Date
  /** The engine adapter to launch through; defaults to the real `ClaudeAdapter`. */
  adapter?: BrainEngine
  /** §5.3: the turn's ceiling — ack, reads, one or two proposals, a report, a question. */
  budgetTurns?: number
  /**
   * §5.3: the protocol text source. The default reads T4's editable parts from disk
   * (`readMetaProtocol`); tests inject their own text.
   */
  readProtocol?: () => string
  /** §16.1: the user's prompt store; the default is `~/.mec/prompts`. */
  promptsRoot?: string
}

/** Read-only, sandboxed, prompt-free: the meta agent plans, it never writes. */
const META_ISOLATION: IsolationProfile = {
  sandbox: 'required',
  read_only: true,
  allow_write: [],
  deny_read: [],
  allowed_domains: [],
  blocked_commands: [],
  background_cap_ms: 30 * 60_000,
  permission_mode: 'none',
  repo_trusted: false,
}

/** The registry domains the engine itself needs (H1's read-only allowance). */
const META_ALLOWED_DOMAINS: readonly string[] = ['claude.ai', 'api.claude.com']

const META_ATTEMPT_ID = 'att_meta_planner'
const MCP_TOOL_PREFIX = 'mcp__mec__'
const DEFAULT_ACK = 'On it.'
const DEFAULT_BUDGET_TURNS = 12
const WALL_CLOCK_MS = 5 * 60_000
const MAX_ACK_CHARS = 240

/**
 * §20 Shutdown: a turn the close cut short. It rejects with `Later`, because it is no failure:
 * the service keeps no receipt and its queue row stays for the next start.
 */
export const turnCutShort = (): Later => new Later('the server is closing')

/** The bridge is never asked under `permission_mode: 'none'`; this only satisfies launch. */
const PERMIT_ALL_BRIDGE = { request: async () => 'allow' as const }

/** The nine tools as the model sees them — appended to the delivery layer (§5.2). */
function toolSchemasText(): string {
  const lines = ['platform tools (the only write channel; engine names arrive prefixed mcp__mec__):']
  for (const name of META_AGENT_TOOLS) {
    const spec = TOOL_SPECS[name]
    lines.push(`- ${name}: ${spec.description}`)
    lines.push(`  schema: ${JSON.stringify(spec.inputSchema)}`)
  }
  return lines.join('\n')
}

/** The first sentence of `text`, capped; empty in, empty out. */
function firstSentence(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  const match = /^[\s\S]*?[.!?](?=\s|$)/.exec(trimmed)
  const sentence = (match === null ? trimmed : match[0]).trim()
  if (sentence.length <= MAX_ACK_CHARS) return sentence
  return `${sentence.slice(0, MAX_ACK_CHARS - 1)}…`
}

/** True when no executed effect landed in the journal at all (nothing ran, nothing duped). */
function journalIsEmpty(journal: ReturnType<PlannerTools['journal']>): boolean {
  return (
    journal.acks.length === 0 &&
    journal.routes.length === 0 &&
    journal.plan === undefined &&
    journal.spawns.length === 0 &&
    journal.questions.length === 0 &&
    journal.confirmations.length === 0 &&
    journal.reports.length === 0 &&
    journal.stops.length === 0 &&
    journal.cancels.length === 0
  )
}

export class PlannerBrain {
  readonly #opts: PlannerBrainOptions
  readonly #engine: BrainEngine
  readonly #root: string
  readonly #readProtocol: () => string
  #tools: MecToolsServer | null = null
  #url: string | undefined
  #generation = 0
  /** The turn currently bound to the shared tools server (decides are single-flight). */
  #currentExecutor: PlannerTools | null = null
  #gate: Promise<unknown> = Promise.resolve()
  /** §20: set once the server is closing; from then on no engine starts. */
  #closing = false
  /** The engine run in flight, so a close past its bound can stop it. */
  #running: AttemptHandle | null = null

  constructor(opts: PlannerBrainOptions) {
    this.#opts = opts
    this.#engine = opts.adapter ?? new ClaudeAdapter()
    this.#readProtocol =
      opts.readProtocol ??
      (() =>
        readMetaProtocol(opts.promptsRoot === undefined ? {} : { promptsRoot: opts.promptsRoot }) ||
        DEFAULT_PLANNER_PROTOCOL)
    this.#root = mkdtempSync(join(tmpdir(), 'mec-planner-'))
    opts.onTempDir?.(this.#root)
  }

  /** The running tools server's URL, once a turn started it. */
  get toolsUrl(): string | undefined {
    return this.#url
  }

  /**
   * The driver as `MetaAgentService` accepts it: the service builds the executed tools and
   * the §5.1 snapshot per turn (single-source validation) and the driver runs them.
   */
  asBrain(): MetaBrain {
    return (context) => {
      if (context.tools === undefined) {
        return Promise.reject(
          new Error('PlannerBrain.asBrain: the service context carries no executed tool set (§5.2)'),
        )
      }
      return this.decide({
        messageId: context.messageId ?? 'msg_turn',
        messageText: context.messageText,
        ...(context.workItemId !== undefined && { workItemId: context.workItemId }),
        ...(context.wake !== undefined && { wake: context.wake }),
        tools: context.tools,
        ...(context.snapshot !== undefined && { snapshot: context.snapshot }),
      })
    }
  }

  async decide(turn: PlannerTurnInput): Promise<PlannerDecision> {
    const run = this.#gate.then(
      () => this.#decideOnce(turn),
      () => this.#decideOnce(turn),
    )
    this.#gate = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** §20's first step: the run in flight may finish, but no engine starts after this. */
  quiesce(): void {
    this.#closing = true
  }

  /** §20, past the bound: stops the run in flight too, so it holds nothing open. */
  async abort(): Promise<void> {
    this.quiesce()
    if (this.#running !== null) await this.#stopEngine(this.#running)
  }

  /** Stops the tools server and removes the brain-owned tmpdir; decides must be done. */
  async close(): Promise<void> {
    await this.#gate
    const server = this.#tools
    this.#tools = null
    this.#url = undefined
    this.#currentExecutor = null
    await server?.stop()
    rmSync(this.#root, { recursive: true, force: true })
  }

  // ── One turn ──────────────────────────────────────────────────────────────────────────────

  async #decideOnce(turn: PlannerTurnInput): Promise<PlannerDecision> {
    try {
      const first = await this.#runEngine(turn, this.#assembleBundle(turn))
      if (first.protocolIncomplete !== true) return first
      // One corrective retry (the v0 discipline): same tools, a reminder in the delivery.
      const retried = await this.#runEngine(turn, this.#assembleBundle(turn, true))
      if (retried.protocolIncomplete === true && this.#closing) throw turnCutShort()
      return retried
    } catch (error) {
      if (this.#closing) throw turnCutShort()
      throw error
    }
  }

  async #stopEngine(handle: AttemptHandle): Promise<void> {
    try {
      await this.#engine.stop(handle)
    } catch {
      // A finished one-shot is already gone; stopping is best-effort cleanup.
    }
  }

  #assembleBundle(turn: PlannerTurnInput, reminder = false): CompiledBundle {
    const snapshot = turn.snapshot
    const wakeLine =
      turn.wake !== undefined
        ? `woken by ${turn.wake.reason}${turn.wake.detail !== undefined ? `: ${turn.wake.detail}` : ''}`
        : 'woken by a user message'
    const contextText =
      snapshot !== undefined
        ? compilePlannerContext({
            ...snapshot,
            turn: { wake: wakeLine, messageId: turn.messageId, messageText: turn.messageText },
          })
        : '<state>\n(state snapshot unavailable — this turn plans on the message alone)\n</state>'
    const delivery = [
      ...(reminder
        ? [
            'CORRECTION: your previous turn did not complete the protocol. A valid turn calls mcp__mec__acknowledge first, then propose_plan, ask_user or report_result — plain-text answers do not count.',
            '',
          ]
        : []),
      'The user message for this turn:',
      `<message id="${turn.messageId}">\n${turn.messageText}\n</message>`,
      '',
      contextText,
      '',
      toolSchemasText(),
    ].join('\n')
    const protocol = this.#readProtocol()
    return compileBundle([
      {
        layer: 'role',
        name: 'meta_agent',
        text: protocol,
        hash: componentHash(protocol),
        origin: 'default',
      },
      {
        layer: 'delivery',
        name: 'turn',
        text: delivery,
        hash: componentHash(delivery),
        origin: 'delivery_specific',
      },
    ])
  }

  async #runEngine(turn: PlannerTurnInput, bundle: CompiledBundle): Promise<PlannerDecision> {
    const { url, token } = await this.#ensureTools(turn)
    const settings = this.#writeEngineConfig(url, token)
    const budgetTurns = this.#opts.budgetTurns ?? DEFAULT_BUDGET_TURNS
    // The one place an engine starts: a first run, a corrective retry or a turn behind the gate.
    if (this.#closing) throw turnCutShort()
    const handle = await this.#engine.launch({
      brief: {
        attempt_id: META_ATTEMPT_ID,
        generation: this.#generation,
        task_id: 'task_meta',
        work_item_id: turn.workItemId ?? 'wi_meta',
        role: { name: 'meta_agent', revision: bundle.revision },
        engine: 'claude',
        slot_id: 'slot_meta',
        worktree: this.#root,
        base_sha: '0'.repeat(40),
        branch: 'mec/meta',
        origin: {
          messages: [{ id: turn.messageId, text: turn.messageText.trim() || '(empty message)' }],
        },
        objective: bundle.text,
        owned_paths: [],
        acceptance_checks: [],
        budget: { turns: budgetTurns, wall_clock_ms: WALL_CLOCK_MS },
        bundle_revision: bundle.revision,
        tools: { url: 'http://127.0.0.1:1', token: 't' },
        env: {
          MEC_SETTINGS_PATH: settings.settingsPath,
          MEC_MCP_CONFIG_PATH: settings.mcpPath,
          MEC_ALLOWED_TOOLS: 'mcp__mec__*',
        },
        isolation: META_ISOLATION,
      },
      env: buildAgentEnv({
        inherited: process.env as Record<string, string | undefined>,
        home: this.#opts.homeDir ?? process.env.HOME ?? '/tmp',
        slot: metaSlotEnv(this.#opts),
        attempt: {
          MEC_ATTEMPT_ID: META_ATTEMPT_ID,
          MEC_WORKTREE: this.#root,
          MEC_TOOLS_URL: url,
          MEC_TOOLS_TOKEN: token,
          MEC_SETTINGS_PATH: settings.settingsPath,
          MEC_MCP_CONFIG_PATH: settings.mcpPath,
          GIT_TERMINAL_PROMPT: '0',
        },
      }),
      cwd: this.#root,
      bridge: PERMIT_ALL_BRIDGE,
    } satisfies LaunchSpec)
    this.#running = handle
    // An abort that landed during the launch found nothing to stop.
    if (this.#closing) await this.#stopEngine(handle)

    const events: EngineEvent[] = []
    for await (const event of this.#engine.events(handle)) events.push(event)
    this.#running = null
    await this.#stopEngine(handle)
    this.#currentExecutor = null

    let exitReason: string | undefined
    const assistant: string[] = []
    const toolEvents: { tool: string; args: unknown }[] = []
    for (const event of events) {
      if (event.type === 'exit') exitReason = event.terminal_reason
      else if (event.type === 'message' && event.role === 'assistant') assistant.push(event.text)
      else if (event.type === 'tool_call' && event.tool.startsWith(MCP_TOOL_PREFIX)) {
        toolEvents.push({ tool: event.tool.slice(MCP_TOOL_PREFIX.length), args: event.input })
      }
    }
    if (exitReason === undefined) throw new Error('planner engine stream ended without an exit event')
    if (exitReason !== 'completed') throw new Error(`planner engine ended '${exitReason}'`)

    // A real engine executes the tools through the MCP server as it runs; a stream that
    // reached the exit with an EMPTY journal is re-derived through the executor — the
    // event stream, not the prose, is the decision's source of truth. The executor's own
    // idempotence (acks per message id, deduped questions, last-plan-wins) makes the
    // replay safe even if a call did land twice.
    if (journalIsEmpty(turn.tools.journal())) {
      for (const call of toolEvents) turn.tools.execute(call.tool as never, call.args)
    }

    return this.#decisionFrom(turn, bundle.revision, assistant)
  }

  #decisionFrom(turn: PlannerTurnInput, revision: string, assistant: readonly string[]): PlannerDecision {
    const journal = turn.tools.journal()
    const ackFromTool = journal.acks[0]?.text
    const sentence =
      ackFromTool ??
      assistant.map((text) => firstSentence(text)).find((found) => found !== '') ??
      firstSentence(journal.reports[0]?.summary ?? '')
    const ack = sentence !== '' ? sentence : DEFAULT_ACK
    const completed =
      journal.acks.length > 0 &&
      (journal.plan !== undefined || journal.reports.length > 0 || journal.questions.length > 0)
    return {
      ack,
      ...(journal.plan !== undefined && { plan: { tasks: journal.plan.tasks } }),
      questions: journal.questions,
      confirmations: journal.confirmations,
      routes: journal.routes,
      spawns: journal.spawns,
      reports: journal.reports,
      stops: journal.stops,
      cancels: journal.cancels,
      escalated: journal.escalated,
      bundleRevision: revision,
      ...(completed ? {} : { protocolIncomplete: true }),
    }
  }

  // ── The tools side (RealClaudeBrain's seams, kept) ─────────────────────────────────────────

  async #ensureTools(turn: PlannerTurnInput): Promise<{ url: string; token: string }> {
    let url = this.#url
    if (url === undefined) {
      const server = new MecToolsServer({
        secret: this.#opts.toolsSecret,
        bridge: PERMIT_ALL_BRIDGE,
        onCall: (_ctx, tool, args) => {
          const executor = this.#currentExecutor
          if (executor === null) {
            throw new Error('planner tools: no turn is bound to this tools server')
          }
          return Promise.resolve(executor.execute(tool, args))
        },
      })
      const started = await server.start()
      this.#tools = server
      url = started.url
      this.#url = url
    }
    this.#generation += 1
    this.#currentExecutor = turn.tools
    const token = issueToken({
      attemptId: META_ATTEMPT_ID,
      generation: this.#generation,
      role: 'meta_agent',
      secret: this.#opts.toolsSecret,
    })
    return { url, token }
  }

  #writeEngineConfig(url: string, token: string): { settingsPath: string; mcpPath: string } {
    const mecDir = join(this.#root, '.mec')
    mkdirSync(mecDir, { recursive: true })
    const home = this.#opts.homeDir ?? process.env.HOME ?? '/tmp'
    const settings = buildAttemptSettings(META_ISOLATION, {
      worktree: this.#root,
      tempDir: this.#root,
      allowedDomains: META_ALLOWED_DOMAINS,
      homeDir: home,
    })
    const settingsPath = join(mecDir, 'claude-settings.json')
    writeFileSync(settingsPath, serialiseAttemptSettings(settings))
    const mcpPath = join(mecDir, 'mcp.json')
    writeFileSync(
      mcpPath,
      `${JSON.stringify(
        {
          mcpServers: {
            mec: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } },
          },
        },
        null,
        2,
      )}\n`,
    )
    return { settingsPath, mcpPath }
  }
}

/**
 * The standalone default protocol — RealClaudeBrain's v0 text with the nine-tool turn
 * shape added (§5.2). It stands in ONLY when neither prompt root carries T4's
 * `roles/meta_agent/protocol.md` (an honest fallback — the launcher says which text ran by
 * its bundle revision, never by inventing a table).
 */
export const DEFAULT_PLANNER_PROTOCOL = [
  "You are MEC's meta agent: the planner behind the conversation. You admit work, decompose it, route messages, monitor specialists and report. You are read-only — you never edit files; every effect goes through the platform MCP tools, whose names all start with mcp__mec__. You never wait: end the turn when nothing remains.",
  '',
  'Protocol for every turn, in order:',
  '1. Call mcp__mec__acknowledge with {message_id, text}: one sentence saying what you understood and will do.',
  '2. Only if the message asks for work: call mcp__mec__propose_plan with {work_item, tasks}. Each task is {id, objective, depends_on, role, model_request?, owned_paths?, acceptance_checks?, budget?, subagent_policy?, slot_hint?}; ids are short keys local to the work item (task_1, task_2, ...), and a replan reusing a key means the same task, keeping its history and status, so a task whose meaning changes takes a new key; dependencies name tasks in the SAME plan and never cycle. model_request is {tier | model, reason} — choose the cheapest tier the risk allows and say why. The tool answers {ok: true, tasks} or {ok: false, issues} — on issues, repair and call propose_plan again. Plan the fewest tasks that cover the request.',
  '3. If a decision only the user can make is blocking: call mcp__mec__ask_user with {question, for_message_id?, options?} — one concrete question. Use mcp__mec__request_confirmation with {operation, evidence} (operation.class e.g. frontier_model) when a guarded operation needs their approval.',
  '4. Call mcp__mec__report_result with {work_item, summary}: one short line on the plan you proposed, the question you asked, or why none was needed.',
  'Then stop: no more tool calls; reply with one short closing line.',
  '',
  'If the message is a question or context only, skip step 2. Attach a follow-up to the work it names (mcp__mec__route with decision "attach") instead of planning it again; live work in the turn context is context, never a thing to re-plan on your own.',
  'Call no tools other than the mcp__mec__ ones. A turn with no platform tool call is not a valid turn — plain-text answers do not count.',
  'Never ask for secrets: a key or token never enters chat, and no task ever needs one.',
].join('\n')

// ── The T4 protocol read (review 2026-11-04 §5.3/§6.1) ─────────────────────────────────────

/** The meta agent's editable parts, under `<prompts root>/roles/meta_agent/`. */
const META_PROTOCOL_PARTS = {
  protocol: 'roles/meta_agent/protocol.md',
  planning: 'roles/meta_agent/planning.md',
} as const

/**
 * Where the shipped defaults can be, in the order `@mec/prompts`' loader looks: beside the bundle
 * (`dist/prompts-defaults/` in the tarball), in the source tree, and from `apps/desktop/dist`.
 * This package does not depend on `@mec/prompts`, so it keeps its own copy of the list.
 */
const DEFAULTS_CANDIDATES: readonly string[] = [
  new URL('./prompts-defaults', import.meta.url),
  new URL('../../prompts/defaults', import.meta.url),
  new URL('../../../packages/prompts/defaults', import.meta.url),
].map((url) => fileURLToPath(url))

/** The first candidate holding the protocol. None is a broken build, and it says so. */
function shippedDefaultsRoot(): string {
  const root = DEFAULTS_CANDIDATES.find((dir) => existsSync(join(dir, META_PROTOCOL_PARTS.protocol)))
  if (root === undefined) {
    throw new Error(`the shipped prompt defaults are missing: looked in ${DEFAULTS_CANDIDATES.join(', ')}`)
  }
  return root
}

/** The user's prompt store — §16.1's `~/.mec/prompts/`, under `MEC_DATA_DIR` when that is set. */
const userPromptsRoot = (): string => join(process.env.MEC_DATA_DIR ?? join(homedir(), '.mec'), 'prompts')

function readPart(root: string, part: string): string | undefined {
  const file = join(root, part)
  if (!existsSync(file)) return undefined
  try {
    const text = readFileSync(file, 'utf8').trim()
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

/**
 * Reads the meta agent's protocol from T4's prompt parts, for real: the user's store first
 * (`~/.mec/prompts/roles/meta_agent/protocol.md` — the editable, revisioned copy), the
 * shipped defaults second (`packages/prompts/defaults/roles/meta_agent/…`). The first root
 * that carries `protocol.md` wins, and its `planning.md` (§5.3's tier-choice rules) is
 * appended when present. With no user part and no shipped tree it throws. Returns '' only when
 * the caller named a `defaultsRoot` without the part — that caller falls back to
 * `DEFAULT_PLANNER_PROTOCOL` and the bundle revision records exactly what ran.
 */
export function readMetaProtocol(opts: { promptsRoot?: string; defaultsRoot?: string } = {}): string {
  const fromRoot = (root: string): string | undefined => {
    const protocol = readPart(root, META_PROTOCOL_PARTS.protocol)
    if (protocol === undefined) return undefined
    const planning = readPart(root, META_PROTOCOL_PARTS.planning)
    return planning === undefined ? protocol : `${protocol}\n\n${planning}`
  }
  return (
    fromRoot(opts.promptsRoot ?? userPromptsRoot()) ??
    fromRoot(opts.defaultsRoot ?? shippedDefaultsRoot()) ??
    ''
  )
}
