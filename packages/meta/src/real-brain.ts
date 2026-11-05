/**
 * The REAL MetaBrain (plan R1.4, now the T5 driver): the meta agent as a real Claude Code
 * run with the platform tool set. `asBrain()` — the surface the composition root wires —
 * returns the NINE-TOOL PLANNER (`PlannerBrain`, review 2026-11-04 §5): per-turn §5.1
 * context, the executed tool set over the mec-tools MCP server, wakes, the 12-turn budget,
 * and the protocol read from T4's editable prompt parts. RealClaudeBrain contributes the
 * transport seams the planner reuses — the injectable engine adapter, the brain-owned
 * tmpdir with the read-only settings pair, the per-process tools server, the single-flight
 * gate — and `close()` now retires both.
 *
 * The v0 `decide()` (three executed tools: acknowledge, propose_plan, report_result)
 * REMAINS, unchanged, as the fixed canary surface its committed tests and the
 * `MEC_REAL_CLAUDE=1` real-engine gate pin; production turns go through `asBrain()`,
 * which is the planner.
 *
 * What the brain keeps deliberately minimal:
 * - **The tool side is per-brain-instance.** One MecToolsServer, started lazily on
 *   the first `decide()` and reused across turns; `close()` is the only thing that
 *   stops it. Tokens are minted per call (`meta_agent` on attempt `att_meta`); the
 *   HMAC is deterministic, so every turn sees the same bearer for the same secret.
 * - **The onCall state is in-memory per decide().** `acknowledge` records its text,
 *   `propose_plan` is validated with the SAME deterministic graph check the service
 *   applies (§10) so the model repairs against real issues, `report_result` records
 *   the final summary, everything else answers `{ok: true}`. Every call is mirrored
 *   into `calls` for tests and operator audits.
 * - **The engine run is read-only.** A read-only isolation profile with
 *   `permission_mode: 'none'` (argv: `--restricted --permission-prompts none`),
 *   sandbox required, the brain-owned tmpdir the only writable path, and a
 *   settings/mcp-config pair written exactly like a specialist attempt's (H1 pattern).
 * - **The instruction text is a compiled bundle** (plan §16): a static `role`
 *   component with the tool protocol and a per-turn `delivery` component with the
 *   user message and the live work list; the revision pins what the meta run saw.
 *
 * Cross-package imports are relative source paths on purpose: meta declares only
 * `@mec/contracts` and `@mec/domain`, pnpm links nothing else into it, and R1.4
 * adds no dependencies — declare the workspace deps when meta's wiring is next touched.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttemptHandle, EngineEvent, IsolationProfile, LaunchSpec } from '@mec/contracts'
import type { BasePolicy } from '@mec/domain'
import { BUILTIN_ROLE_NAMES, DEFAULT_CAPS, validateGraph } from '@mec/domain'
import { ClaudeAdapter } from '../../engines/src/claude/adapter'
import { MecToolsServer } from '../../mec-tools/src/server'
import { issueToken } from '../../mec-tools/src/tokens'
import type { ToolName } from '../../mec-tools/src/tools'
import { type CompiledBundle, compileBundle, componentHash } from '../../prompts/src/bundles'
import { buildAgentEnv } from '../../runtime/src/env'
import { buildAttemptSettings, serialiseAttemptSettings } from '../../runtime/src/isolation'
import { metaSlotEnv, PlannerBrain, turnCutShort } from './brain'
import type { MetaBrain, MetaDecision, MetaPlanTask } from './service'

/** The engine surface the brain uses; `ClaudeAdapter` satisfies it structurally. */
export type BrainEngine = {
  launch(spec: LaunchSpec): Promise<AttemptHandle>
  events(handle: AttemptHandle): AsyncIterable<EngineEvent>
  stop(handle: AttemptHandle): Promise<void>
}

/** One executed platform tool call, mirrored for tests and operator audits. */
export type RecordedToolCall = { tool: string; args: unknown; at: string; result: unknown }

export type RealClaudeBrainOptions = {
  /** The meta slot's engine home (a logged-in `claude` config dir) — `CLAUDE_CONFIG_DIR`. */
  slotDir: string
  /** A linked slot: the engine's default home, with the variable absent (`homes.ts`). */
  linked?: boolean
  /** User home for the read-deny defaults; defaults to `$HOME` (the H1 pattern). */
  homeDir?: string
  /** The HMAC secret mec-tools tokens are signed with. */
  toolsSecret: string
  now?: () => Date
  /** The engine adapter to launch through; defaults to the real `ClaudeAdapter`. */
  adapter?: BrainEngine
  /** §16.1: the user's prompt store; the default is `~/.mec/prompts`. */
  promptsRoot?: string
}

/** The v0 pseudo-check every proposed task carries (see service.ts's module doc). */
const MANUAL_REVIEW_CHECK = 'manual-review'

/** The meta attempt identity: one stable id, one generation, the meta role. */
const META_ATTEMPT_ID = 'att_meta'

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

/** The meta turn's ceiling: ack, one or two proposals, a report, a closing line. */
const META_BUDGET_TURNS = 6

/** How the normalised stream names platform tools (Claude Code's MCP naming). */
const MCP_TOOL_PREFIX = 'mcp__mec__'

const DEFAULT_ACK = 'On it.'
const DEFAULT_OBJECTIVE = 'Implement the request.'
const DEFAULT_ROLE = 'implementer'
const MAX_ACK_CHARS = 240

/** The bridge is never asked under `permission_mode: 'none'`; this only satisfies launch. */
const PERMIT_ALL_BRIDGE = { request: async () => 'allow' as const }

const META_PROTOCOL_TEXT = [
  "You are MEC's meta agent: the planner behind one user message. You are read-only — you never edit files; every effect goes through the platform MCP tools, whose names all start with mcp__mec__.",
  '',
  'Protocol for every turn, in order:',
  '1. Call mcp__mec__acknowledge with {message_id: "msg_turn", text}: one sentence saying what you understood and will do.',
  '2. Only if the message asks for work: call mcp__mec__propose_plan with {work_item: "wi_turn", tasks}. Each task is {id, objective, depends_on}; ids are short keys local to the work item (task_1, task_2, ...), and a replan reusing a key means the same task, keeping its history and status, so a task whose meaning changes takes a new key; every depends_on entry must name another task in the SAME plan, and dependencies must never cycle. The tool answers {ok: true, tasks} or {ok: false, issues} — on issues, repair the plan and call propose_plan again. Plan the fewest tasks that cover the request; one task is often enough.',
  '3. Call mcp__mec__report_result with {work_item: "wi_turn", summary}: one short line on the plan you proposed, or why none was needed.',
  'Then stop: no more tool calls; reply with one short closing line.',
  '',
  'If the message is a question or context only, skip step 2. Call no tools other than the mcp__mec__ ones.',
].join('\n')

/** A mapped plan task — the service's MetaDecision shape. */
type PlanTask = {
  taskId: string
  objective: string
  dependsOn: string[]
  role: string
  basePolicy?: BasePolicy
  modelRequest?: MetaPlanTask['modelRequest']
  slotHint?: MetaPlanTask['slotHint']
}

/** The per-decide in-memory state the platform tools execute against. */
type TurnState = { acks: string[]; reports: string[]; proposals: number }

/**
 * The real meta brain. `asBrain()` is the production surface — the nine-tool planner
 * driver (T5) — while `decide()` keeps the v0 three-tool turn its committed tests and
 * the real-engine canary pin (a class cannot `implements` a call signature, so the
 * brains adapt through `asBrain()`); `MetaAgentService` consumes their decisions
 * unchanged.
 */
export class RealClaudeBrain {
  /** Every executed platform tool call, in order — the test and audit mirror. */
  readonly calls: RecordedToolCall[] = []

  readonly #slotDir: string
  readonly #linked: boolean
  readonly #home: string
  readonly #secret: string
  readonly #now: () => Date
  readonly #engine: BrainEngine
  readonly #promptsRoot: string | undefined
  /** The brain-owned tmpdir: cwd, only writable path, and home of the engine config. */
  readonly #root: string
  #retriesUsed = 0
  lastEvents: EngineEvent[] = []
  #tools: MecToolsServer | null = null
  #url: string | undefined
  #turn: TurnState | null = null
  /** The nine-tool planner this brain drives once asBrain() is wired (T5). */
  #planner: PlannerBrain | null = null
  /** Decides are serialised: the shared tools server routes to one turn at a time. */
  #gate: Promise<unknown> = Promise.resolve()
  /** §20: set once the server is closing; from then on no engine starts. */
  #closing = false
  /** The v0 run in flight, so a close past its bound can stop it. */
  #running: AttemptHandle | null = null

  constructor(opts: RealClaudeBrainOptions) {
    this.#slotDir = opts.slotDir
    this.#linked = opts.linked === true
    this.#home = opts.homeDir ?? process.env.HOME ?? '/tmp'
    this.#secret = opts.toolsSecret
    this.#now = opts.now ?? (() => new Date())
    this.#engine = opts.adapter ?? new ClaudeAdapter()
    this.#promptsRoot = opts.promptsRoot
    this.#root = mkdtempSync(join(tmpdir(), 'mec-meta-brain-'))
  }

  /** The running tools server's URL (ends in `/mcp`), once a decide has started it. */
  get toolsUrl(): string | undefined {
    return this.#url
  }

  /**
   * The brain as `MetaAgentService` accepts it — THE DRIVER (T5): the nine-tool planner on
   * this brain's seams (slot home, tools secret, adapter, clock), reading T4's editable
   * protocol from disk by default. The service supplies the executed tool set and the §5.1
   * snapshot per turn; a context without them is refused (the planner never runs unvalidated).
   */
  asBrain(): MetaBrain {
    return (context) =>
      this.#closing ? Promise.reject(turnCutShort()) : this.#plannerBrain().asBrain()(context)
  }

  /** The nine-tool planner over this brain's seams, built once and reused across turns. */
  #plannerBrain(): PlannerBrain {
    this.#planner ??= new PlannerBrain({
      slotDir: this.#slotDir,
      linked: this.#linked,
      homeDir: this.#home,
      toolsSecret: this.#secret,
      now: this.#now,
      adapter: this.#engine,
      ...(this.#promptsRoot !== undefined && { promptsRoot: this.#promptsRoot }),
    })
    return this.#planner
  }

  async decide(context: {
    messageText: string
    liveWork: { workItemId: string; stage: string }[]
  }): Promise<MetaDecision> {
    const run = this.#gate.then(
      () => this.#decideOnce(context),
      () => this.#decideOnce(context),
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
    this.#planner?.quiesce()
  }

  /** §20, past the bound: stops the run in flight too, so it holds nothing open. */
  async abort(): Promise<void> {
    this.quiesce()
    await this.#planner?.abort()
    if (this.#running !== null) await this.#stopEngine(this.#running)
  }

  /** Stops both tool servers and removes the brain-owned tmpdirs; decides must be done. */
  async close(): Promise<void> {
    await this.#gate
    const server = this.#tools
    this.#tools = null
    this.#url = undefined
    this.#turn = null
    const planner = this.#planner
    this.#planner = null
    await server?.stop()
    await planner?.close()
    rmSync(this.#root, { recursive: true, force: true })
  }

  // ── One turn ──────────────────────────────────────────────────────────────────────────────

  async #decideOnce(context: {
    messageText: string
    liveWork: { workItemId: string; stage: string }[]
  }): Promise<MetaDecision> {
    const turn: TurnState = { acks: [], reports: [], proposals: 0 }
    this.#turn = turn
    const { url, token } = await this.#ensureTools()
    const bundle = buildTurnBundle(context)
    const { settingsPath, mcpPath } = this.#writeEngineConfig(url, token)

    if (this.#closing) throw turnCutShort()
    const handle = await this.#engine.launch({
      brief: {
        attempt_id: META_ATTEMPT_ID,
        generation: 1,
        task_id: 'task_meta',
        work_item_id: 'wi_meta',
        role: { name: 'meta_agent', revision: bundle.revision },
        engine: 'claude',
        slot_id: 'slot_meta',
        worktree: this.#root,
        base_sha: '0'.repeat(40),
        branch: 'mec/meta',
        origin: {
          messages: [{ id: 'msg_meta_turn', text: context.messageText.trim() || '(empty message)' }],
        },
        objective: bundle.text,
        owned_paths: [],
        acceptance_checks: [],
        budget: { turns: META_BUDGET_TURNS, wall_clock_ms: 180_000 },
        bundle_revision: bundle.revision,
        // The real endpoint travels in mcp.json and the process env (§5.12: no tokens
        // in briefs); these fields stay context-shaped only, as in the H1 run.
        tools: { url: 'http://127.0.0.1:1', token: 't' },
        env: {
          MEC_SETTINGS_PATH: settingsPath,
          MEC_MCP_CONFIG_PATH: mcpPath,
          MEC_ALLOWED_TOOLS: 'mcp__mec__*',
        },
        isolation: META_ISOLATION,
      },
      env: buildAgentEnv({
        inherited: process.env as Record<string, string | undefined>,
        home: this.#home,
        slot: metaSlotEnv({ slotDir: this.#slotDir, linked: this.#linked }),
        attempt: {
          MEC_ATTEMPT_ID: META_ATTEMPT_ID,
          MEC_WORKTREE: this.#root,
          MEC_TOOLS_URL: url,
          MEC_TOOLS_TOKEN: token,
          MEC_SETTINGS_PATH: settingsPath,
          MEC_MCP_CONFIG_PATH: mcpPath,
          GIT_TERMINAL_PROMPT: '0',
        },
      }),
      cwd: this.#root,
      bridge: PERMIT_ALL_BRIDGE,
    })
    this.#running = handle

    const events: EngineEvent[] = []
    for await (const event of this.#engine.events(handle)) events.push(event)
    this.#running = null
    await this.#stopEngine(handle)
    if (this.#closing) throw turnCutShort()
    this.lastEvents = events
    const decision = decisionFromEvents(events)
    // §6 bounded repair: the protocol REQUIRES at least acknowledge. A model that answers
    // in plain text without any mcp__mec__ call gets exactly one corrective retry — the
    // same discipline as an invalid plan proposal (four consecutive failures escalate
    // at the service layer, which counts each decide).
    const anyToolCall = events.some((e) => e.type === 'tool_call' && e.tool.startsWith(MCP_TOOL_PREFIX))
    if (!anyToolCall && this.#retriesUsed < 1) {
      this.#retriesUsed += 1
      const reminded = buildTurnBundle(context, true)
      const retryHandle = await this.#engine.launch({
        brief: {
          attempt_id: META_ATTEMPT_ID,
          generation: 2,
          task_id: 'task_meta',
          work_item_id: 'wi_meta',
          role: { name: 'meta_agent', revision: 'retry' },
          engine: 'claude',
          slot_id: 'slot_meta',
          worktree: this.#root,
          base_sha: '0'.repeat(40),
          branch: 'mec/meta',
          origin: { messages: [{ id: 'msg_meta_turn', text: context.messageText }] },
          objective: reminded.text,
          owned_paths: [],
          acceptance_checks: [],
          budget: { turns: META_BUDGET_TURNS, wall_clock_ms: 180_000 },
          bundle_revision: reminded.revision,
          tools: { url: 'http://127.0.0.1:1', token: 't' },
          env: {
            MEC_SETTINGS_PATH: settingsPath,
            MEC_MCP_CONFIG_PATH: mcpPath,
            MEC_ALLOWED_TOOLS: 'mcp__mec__*',
          },
          isolation: META_ISOLATION,
        },
        env: buildAgentEnv({
          inherited: process.env as Record<string, string | undefined>,
          home: this.#home,
          slot: metaSlotEnv({ slotDir: this.#slotDir, linked: this.#linked }),
          attempt: {
            MEC_ATTEMPT_ID: META_ATTEMPT_ID,
            MEC_WORKTREE: this.#root,
            MEC_TOOLS_URL: url,
            MEC_TOOLS_TOKEN: token,
            MEC_SETTINGS_PATH: settingsPath,
            MEC_MCP_CONFIG_PATH: mcpPath,
            GIT_TERMINAL_PROMPT: '0',
          },
        }),
        cwd: this.#root,
        bridge: PERMIT_ALL_BRIDGE,
      })
      const retryEvents: EngineEvent[] = []
      for await (const event of this.#engine.events(retryHandle)) retryEvents.push(event)
      try {
        await this.#engine.stop(retryHandle)
      } catch {
        // already gone
      }
      const retried = decisionFromEvents(retryEvents)
      const retriedCalled = retryEvents.some(
        (e) => e.type === 'tool_call' && e.tool.startsWith(MCP_TOOL_PREFIX),
      )
      return retriedCalled || !anyToolCall ? retried : decision
    }
    return decision
  }

  async #stopEngine(handle: AttemptHandle): Promise<void> {
    try {
      await this.#engine.stop(handle)
    } catch {
      // A finished one-shot is already gone; stopping is best-effort cleanup.
    }
  }

  // ── The platform tool side ────────────────────────────────────────────────────────────────

  /** Starts (once) and returns the tools endpoint plus a freshly minted meta token. */
  async #ensureTools(): Promise<{ url: string; token: string }> {
    let url = this.#url
    if (url === undefined) {
      const server = new MecToolsServer({
        secret: this.#secret,
        bridge: PERMIT_ALL_BRIDGE,
        onCall: (_ctx, tool, args) => Promise.resolve(this.#executeTool(tool, args)),
      })
      const started = await server.start()
      this.#tools = server
      url = started.url
      this.#url = url
    }
    const token = issueToken({
      attemptId: META_ATTEMPT_ID,
      generation: 1,
      role: 'meta_agent',
      secret: this.#secret,
    })
    return { url, token }
  }

  /** Executes one platform tool against the turn state; every call lands in `calls`. */
  #executeTool(tool: ToolName, args: unknown): unknown {
    const decoded = decodeArgs(args)
    let result: unknown
    switch (tool) {
      case 'acknowledge': {
        const text = typeof decoded.text === 'string' ? decoded.text.trim() : ''
        if (text === '') {
          result = { ok: false, issues: ['acknowledge requires a non-empty text'] }
        } else {
          this.#turn?.acks.push(text)
          result = { ok: true, text }
        }
        break
      }
      case 'propose_plan': {
        const plan = planFromToolArgs(decoded)
        if (plan.ok && this.#turn !== null) this.#turn.proposals++
        result = plan
        break
      }
      case 'report_result': {
        const summary = typeof decoded.summary === 'string' ? decoded.summary.trim() : ''
        if (summary === '') {
          result = { ok: false, issues: ['report_result requires a non-empty summary'] }
        } else {
          this.#turn?.reports.push(summary)
          result = { ok: true, summary }
        }
        break
      }
      default:
        result = { ok: true }
    }
    this.calls.push({ tool, args: decoded, at: this.#now().toISOString(), result })
    return result
  }

  /** Writes the read-only settings pair (H1's writeEngineConfig, meta-shaped). */
  #writeEngineConfig(url: string, token: string): { settingsPath: string; mcpPath: string } {
    const mecDir = join(this.#root, '.mec')
    mkdirSync(mecDir, { recursive: true })
    const settings = buildAttemptSettings(META_ISOLATION, {
      worktree: this.#root,
      tempDir: this.#root, // the brain-owned tmpdir is the one writable path
      allowedDomains: META_ALLOWED_DOMAINS,
      homeDir: this.#home,
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

// ── The turn's instruction text (plan §16: one role component, one delivery component) ─────

function buildTurnBundle(
  context: {
    messageText: string
    liveWork: { workItemId: string; stage: string }[]
  },
  reminder = false,
): CompiledBundle {
  const live =
    context.liveWork.length === 0
      ? 'Live work in flight: none — this is a fresh request.'
      : `Live work in flight (context only, never re-plan it): ${context.liveWork
          .map((work) => `${work.workItemId} (${work.stage})`)
          .join(', ')}`
  const delivery = [
    ...(reminder
      ? [
          'CORRECTION: your previous turn made NO mcp__mec__ tool calls. The protocol is mandatory:',
          'begin with mcp__mec__acknowledge before anything else. Plain-text answers are not valid turns.',
          '',
        ]
      : []),
    'The user message for this turn:',
    `<message>\n${context.messageText}\n</message>`,
    '',
    live,
  ].join('\n')
  return compileBundle([
    {
      layer: 'role',
      name: 'meta_agent',
      text: META_PROTOCOL_TEXT,
      hash: componentHash(META_PROTOCOL_TEXT),
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

// ── The decision, derived from the normalised event stream ─────────────────────────────────

/** The model and slot a propose_plan task asked for, in the stored shape. */
function placementRequest(task: Record<string, unknown>): Pick<PlanTask, 'modelRequest' | 'slotHint'> {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined
  const model = task.model_request as Record<string, unknown> | undefined
  const hint = task.slot_hint as Record<string, unknown> | undefined
  const slotClass = text(hint?.slot_class)
  const slotId = text(hint?.slot_id)
  const fields = ['tier', 'model', 'effort', 'variant'].map((key) => [key, text(model?.[key])])
  const modelRequest =
    model === undefined ? undefined : Object.fromEntries(fields.filter(([, value]) => value))
  return {
    ...(modelRequest !== undefined && {
      modelRequest: { ...modelRequest, reason: text(model?.reason) ?? 'no reason given' },
    }),
    ...((slotClass !== undefined || slotId !== undefined) && {
      slotHint: { ...(slotClass !== undefined && { slotClass }), ...(slotId !== undefined && { slotId }) },
    }),
  }
}

/** Maps propose_plan args onto plan tasks and validates them exactly as the service will. */
function planFromToolArgs(
  args: Record<string, unknown>,
): { ok: true; tasks: PlanTask[] } | { ok: false; issues: string[] } {
  const raw = args.tasks
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, issues: ['propose_plan requires a non-empty tasks array'] }
  }
  const tasks: PlanTask[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, issues: ['each task must be an object with id, objective and depends_on'] }
    }
    const task = entry as Record<string, unknown>
    const taskId = typeof task.id === 'string' ? task.id.trim() : ''
    if (taskId === '') {
      return { ok: false, issues: ['each task needs a non-empty string id'] }
    }
    tasks.push({
      taskId,
      objective:
        typeof task.objective === 'string' && task.objective.trim() !== ''
          ? task.objective.trim()
          : DEFAULT_OBJECTIVE,
      dependsOn: Array.isArray(task.depends_on)
        ? task.depends_on.filter((dep): dep is string => typeof dep === 'string')
        : [],
      role: typeof task.role === 'string' && task.role.trim() !== '' ? task.role.trim() : DEFAULT_ROLE,
      ...(task.base_policy === 'contract' && { basePolicy: 'contract' as const }),
      // §11: what the planner asked of placement; deterministic code grants it or defers.
      ...placementRequest(task),
    })
  }
  const issues = validateGraph(
    tasks.map((task) => ({
      id: task.taskId,
      dependsOn: task.dependsOn,
      ownedPaths: [],
      acceptanceChecks: [MANUAL_REVIEW_CHECK],
      maxAttempts: DEFAULT_CAPS.repairAttemptsPerTask + 1,
      basePolicy: task.basePolicy ?? 'integration',
      role: task.role,
    })),
    { knownChecks: [MANUAL_REVIEW_CHECK], knownRoles: BUILTIN_ROLE_NAMES },
  )
  if (issues.length > 0) {
    return { ok: false, issues: issues.map((issue) => `${issue.kind}: ${issue.detail}`) }
  }
  return { ok: true, tasks }
}

/**
 * The decision from the stream: ack from the first `mcp__mec__acknowledge` text, else
 * the first assistant sentence; the plan from the LAST propose_plan that validates.
 * Anything but a completed exit is a brain failure — the service stops the turn safely.
 */
function decisionFromEvents(events: readonly EngineEvent[]): MetaDecision {
  let ackFromTool: string | undefined
  let lastValidPlan: PlanTask[] | undefined
  let firstReport: string | undefined
  let exitReason: string | undefined
  const assistant: string[] = []
  for (const event of events) {
    if (event.type === 'tool_call' && event.tool.startsWith(MCP_TOOL_PREFIX)) {
      const name = event.tool.slice(MCP_TOOL_PREFIX.length)
      const args = decodeArgs(event.input)
      if (name === 'acknowledge' && ackFromTool === undefined && typeof args.text === 'string') {
        const text = args.text.trim()
        if (text !== '') ackFromTool = text
      }
      if (name === 'propose_plan') {
        const plan = planFromToolArgs(args)
        if (plan.ok) lastValidPlan = plan.tasks
      }
      if (name === 'report_result' && firstReport === undefined && typeof args.summary === 'string') {
        firstReport = args.summary
      }
    } else if (event.type === 'message' && event.role === 'assistant') {
      assistant.push(event.text)
    } else if (event.type === 'exit') {
      exitReason = event.terminal_reason
    }
  }
  if (exitReason === undefined) {
    throw new Error('meta engine stream ended without an exit event')
  }
  if (exitReason !== 'completed') {
    throw new Error(`meta engine ended '${exitReason}'`)
  }
  const sentence =
    ackFromTool ??
    assistant.map((text) => firstSentence(text)).find((found) => found !== '') ??
    firstSentence(firstReport ?? '')
  const ack = sentence !== '' ? sentence : DEFAULT_ACK
  return lastValidPlan === undefined ? { ack } : { ack, plan: { tasks: lastValidPlan } }
}

// ── Small pure helpers ─────────────────────────────────────────────────────────────────────

/** Tool args arrive as the MCP `arguments` object; a string body is parsed defensively. */
function decodeArgs(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input)
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
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
