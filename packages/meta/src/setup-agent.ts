/**
 * The setup agent (T7, review 2026-11-04 §7): a `setup_agent` role on the meta agent's
 * slot — "a form-filler with manners, not a planner". Its tool set is the Settings API's
 * read side plus a safe slot subset, and every write is a DRAFT the user applies: the
 * agent never writes settings, prompts, the model table or policy directly.
 *
 * Two code-level guards (§7), enforced here and not in prompt text:
 * 1. `apply_change` runs only after the user said yes IN THIS CONVERSATION — a recorded,
 *    per-draft approval; a model that calls apply_change unprompted is refused.
 * 2. A draft that pre-authorises a confirmation class or widens caps is forced to be a
 *    confirmation card of class `policy_change`, and policy drafts are NEVER applied by
 *    the agent at all (§13: agents never write the policy file) — the user applies them
 *    from the card.
 * Plus the tier guard: the setup agent runs on `fast` or `balanced` and nothing else
 * (`assertSetupTier`), recorded on every turn (`setupModelRequest`).
 */
import type { Store } from '@mec/contracts'
import type { ModelTier } from '@mec/domain'

/** The §7 targets a draft may touch. */
export type SetupChangeTarget = 'prompts' | 'models' | 'policy' | 'repository'

export type SetupDraftRecord = {
  id: string
  target: SetupChangeTarget
  patch: Record<string, unknown>
  reason: string
  diff: string
  /** Present exactly when the draft touches pre-authorisation or caps (§7 guard 1). */
  cls?: 'policy_change'
  status: 'pending' | 'applied' | 'denied'
  conversationId: string
  createdAt: string
  resolvedAt?: string
}

export type SetupLoginCard = { engine: string; label: string }
export type SetupKeyForm = { provider: string; label: string }

export type SetupAgentTurnResult = {
  reply: string
  /** The tools the turn executed, in order — the audit mirror. */
  calls: { tool: string; args: unknown; result: unknown }[]
  drafts: SetupDraftRecord[]
  applied: string[]
  /** The workbench opens these; the chat only ever sees the request (§7: no credentials). */
  openLoginCard?: SetupLoginCard
  openKeyForm?: SetupKeyForm
}

/** The Settings API + safe slot subset the agent reads through and drafts against (§7). */
export type SetupSettingsApi = {
  read(
    resource: 'settings' | 'slots' | 'repositories' | 'prompts' | 'models' | 'policy' | 'status' | 'doctor',
  ): Promise<unknown> | unknown
  /** Applies an approved draft. Policy drafts are refused here by the caller, not this seam. */
  applyDraft(draft: SetupDraftRecord): Promise<{ ok: true; detail?: string } | { ok: false; error: string }>
  openLoginCard(engine: string, label: string): void
  openKeyForm(provider: string, label: string): void
  registerRepository(input: {
    label: string
    urlOrPath: string
    bootstrap?: string[]
    checks?: string[]
    trust?: string
  }): Promise<{ ok: true; id: string } | { ok: false; error: string }>
  setMetaSlot(slotId: string): void
  runDoctor(): Promise<string>
}

/** The setup agent's tier: fast or balanced, never anything harder (§7 guard). */
export const SETUP_AGENT_TIERS: readonly ModelTier[] = ['fast', 'balanced']

/** Throws unless `tier` is one the setup agent may run on — the code-level tier guard. */
export function assertSetupTier(tier: ModelTier): void {
  if (!SETUP_AGENT_TIERS.includes(tier)) {
    throw new Error(
      `setup agent tier guard: '${tier}' is not allowed — the setup agent runs on fast or balanced (§7)`,
    )
  }
}

/** The model request every setup-agent launch carries; the guard is checked at launch. */
export function setupModelRequest(): { tier: ModelTier; effort: string; reason: string } {
  return {
    tier: 'balanced',
    effort: 'medium',
    reason: 'setup agent — a form-filler with manners, not a planner',
  }
}

const READ_RESOURCES = new Set([
  'settings',
  'slots',
  'repositories',
  'prompts',
  'models',
  'policy',
  'status',
  'doctor',
])

/** The one-word answers that count as the user's yes for a pending draft (§7). */
const YES_WORDS = new Set(['yes', 'y', 'apply', 'approve', 'confirm', 'do it', 'ok'])

const DRAFT_DOC_PREFIX = 'draft/'

/** A diff honest enough to show: the target, the reason, and the patch, verbatim. */
function diffOf(target: SetupChangeTarget, patch: Record<string, unknown>, reason: string): string {
  const lines = [`target: ${target}`, `reason: ${reason}`, 'patch:']
  for (const [key, value] of Object.entries(patch)) {
    lines.push(`  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
  }
  return lines.join('\n')
}

/** Keys whose presence makes a draft a policy change (§7's guard, structural). */
function touchesPolicyGuard(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).some(
    (key) => key === 'preAuthorised' || key === 'capsOverride' || key === 'policy',
  )
}

/**
 * The model seam: returns the tool calls to execute for one message (the engine-backed
 * brain in production; a script in tests, like the planner's fakeBrain). The calls run
 * through the guarded tool set either way — the model proposes, deterministic code
 * validates and executes.
 */
export type SetupDecide = (input: {
  text: string
  pendingDrafts: SetupDraftRecord[]
}) => Promise<
  | { calls: { tool: string; args: Record<string, unknown> }[]; reply?: string }
  | { calls: { tool: string; args: Record<string, unknown> }[]; reply?: string }
>

export class SetupAgent {
  readonly #store: Store
  readonly #api: SetupSettingsApi
  readonly #now: () => Date
  readonly #nextId: () => string
  readonly #decide?: SetupDecide
  /** Card requests this turn — surfaced on the result for the workbench to open. */
  #turnLoginCard: SetupLoginCard | undefined
  #turnKeyForm: SetupKeyForm | undefined
  /** Drafts the user said yes to in this conversation — the apply gate (§7). */
  readonly #approved = new Set<string>()

  constructor(deps: {
    store: Store
    api: SetupSettingsApi
    now?: () => Date
    idFactory?: () => string
    /** The model seam; without it the agent answers from real reads (honest default). */
    decide?: SetupDecide
  }) {
    this.#store = deps.store
    this.#api = deps.api
    this.#now = deps.now ?? (() => new Date())
    this.#nextId = deps.idFactory ?? (() => Math.random().toString(36).slice(2, 10))
    this.#decide = deps.decide
  }

  // ── The turn: one message in, one honest result out ────────────────────────────────────────

  /**
   * Handles one setup-mode message. The model seam (constructor `decide`, or the
   * per-call override) returns tool calls this agent then EXECUTES through the guarded
   * tool set — the model proposes, deterministic code validates and runs. The default
   * (no engine wired) is the honest opener: real doctor/status reads, no invented
   * dialogue.
   */
  async handleMessage(
    input: { messageId: string; text: string; conversationId?: string },
    decideOverride?: SetupDecide,
  ): Promise<SetupAgentTurnResult> {
    const conversationId = input.conversationId ?? 'setup'
    const pending = this.pendingDrafts(conversationId)
    const firstPending = pending[0]

    // The user's yes approves the pending draft — recorded BEFORE any tool runs, so a
    // later apply_change in the same conversation passes the gate the honest way.
    const said = input.text.trim().toLowerCase()
    if (firstPending !== undefined && YES_WORDS.has(said)) {
      this.#approved.add(firstPending.id)
    }

    const calls: { tool: string; args: unknown; result: unknown }[] = []
    this.#turnLoginCard = undefined
    this.#turnKeyForm = undefined
    const run = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
      const result = await this.execute(tool, args, conversationId)
      calls.push({ tool, args, result })
      return result
    }

    const decide = decideOverride ?? this.#decide
    if (decide !== undefined) {
      const decision = await decide({ text: input.text, pendingDrafts: pending })
      for (const call of decision.calls) await run(call.tool, call.args)
      const waiting = this.pendingDrafts(conversationId)[0]
      const reply =
        decision.reply ??
        (waiting !== undefined
          ? `Draft ${waiting.id} is waiting: ${waiting.reason} — say yes to apply it.`
          : 'Done.')
      return {
        reply,
        calls,
        drafts: this.pendingDrafts(conversationId),
        applied: this.#appliedThisTurn(calls),
        ...(this.#turnLoginCard !== undefined && { openLoginCard: this.#turnLoginCard }),
        ...(this.#turnKeyForm !== undefined && { openKeyForm: this.#turnKeyForm }),
      }
    }

    // The honest default: real reads, no invented dialogue (the engine-backed decide seam
    // carries the §7 conversation; without it we still serve the truth).
    const doctor = await run('read', { resource: 'doctor' })
    const status = await run('read', { resource: 'status' })
    const doctorText =
      typeof doctor === 'string'
        ? (doctor as string).split('\n').slice(0, 4).join('\n')
        : '(doctor unavailable)'
    const slots = await run('read', { resource: 'slots' })
    const slotCount = Array.isArray(slots) ? slots.length : 0
    const reply = [
      'Setup mode ready — I configure MEC with you: slots, prompts, the model table, repositories.',
      `Right now: ${slotCount} slot(s) registered; status says ${JSON.stringify(status).slice(0, 160)}.`,
      `Doctor (first lines):\n${doctorText}`,
      firstPending !== undefined
        ? `A draft is waiting (${firstPending.reason}) — say yes to apply it.`
        : 'Ask me to check something, propose a change, or open a login card.',
      '(Setup mode talks to the Settings API only; credentials never pass through this chat.)',
    ].join('\n')
    return {
      reply,
      calls,
      drafts: this.pendingDrafts(conversationId),
      applied: [],
      ...(this.#turnLoginCard !== undefined && { openLoginCard: this.#turnLoginCard }),
      ...(this.#turnKeyForm !== undefined && { openKeyForm: this.#turnKeyForm }),
    }
  }

  #appliedThisTurn(calls: { tool: string; result: unknown }[]): string[] {
    const applied: string[] = []
    for (const call of calls) {
      if (call.tool !== 'apply_change') continue
      const result = call.result as { ok?: boolean; draft?: { id?: string } }
      if (result?.ok === true && typeof result.draft?.id === 'string') applied.push(result.draft.id)
    }
    return applied
  }

  // ── The tool set (§7), executed with the guards ────────────────────────────────────────────

  async execute(tool: string, rawArgs: Record<string, unknown>, conversationId: string): Promise<unknown> {
    switch (tool) {
      case 'read':
        return this.#read(rawArgs)
      case 'propose_change':
        return this.#proposeChange(rawArgs, conversationId)
      case 'apply_change':
        return this.#applyChange(rawArgs, conversationId)
      case 'open_login_card':
        return this.#openLoginCard(rawArgs)
      case 'open_key_form':
        return this.#openKeyForm(rawArgs)
      case 'register_repository':
        return this.#registerRepository(rawArgs)
      case 'set_meta_slot':
        return this.#setMetaSlot(rawArgs)
      case 'run_doctor':
        return { ok: true, report: await this.#api.runDoctor() }
      default:
        return { ok: false, error: `tool '${tool}' is not a setup-agent tool` }
    }
  }

  async #read(args: Record<string, unknown>): Promise<unknown> {
    const resource = typeof args.resource === 'string' ? args.resource : ''
    if (!READ_RESOURCES.has(resource)) {
      return {
        ok: false,
        error: `read resource must be one of ${[...READ_RESOURCES].join(', ')}`,
      }
    }
    return this.#api.read(resource as Parameters<SetupSettingsApi['read']>[0])
  }

  async #proposeChange(args: Record<string, unknown>, conversationId: string): Promise<unknown> {
    const target = args.target
    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
    const issues: string[] = []
    if (target !== 'prompts' && target !== 'models' && target !== 'policy' && target !== 'repository') {
      return { ok: false, error: 'propose_change target must be prompts, models, policy or repository' }
    }
    if (reason === '') issues.push('propose_change requires a reason the user will read on the card')
    if (typeof args.patch !== 'object' || args.patch === null || Array.isArray(args.patch))
      issues.push('propose_change requires a patch object')
    if (issues.length > 0) return { ok: false, error: issues.join('; ') }

    const patch = args.patch as Record<string, unknown>
    const draft: SetupDraftRecord = {
      id: `draft_${this.#nextId()}`,
      target,
      patch,
      reason,
      diff: diffOf(target, patch, reason),
      // §7 guard: pre-authorisation or cap widening is ALWAYS a policy-change card.
      ...(touchesPolicyGuard(patch) && { cls: 'policy_change' }),
      status: 'pending',
      conversationId,
      createdAt: this.#now().toISOString(),
    }
    if (draft.target === 'policy' && draft.cls === undefined) draft.cls = 'policy_change'
    this.#saveDraft(draft)
    return {
      ok: true,
      draft: { id: draft.id, target, cls: draft.cls ?? null, diff: draft.diff },
      note:
        draft.cls === 'policy_change'
          ? 'shown as a policy_change card — you apply it; the agent never applies policy itself'
          : 'waiting for your yes in this conversation',
    }
  }

  async #applyChange(args: Record<string, unknown>, conversationId: string): Promise<unknown> {
    const id = typeof args.draft_id === 'string' ? args.draft_id : ''
    if (id === '') return { ok: false, error: 'apply_change requires draft_id' }
    const doc = this.#store.engines.get(`${DRAFT_DOC_PREFIX}${id}`)
    if (doc === undefined) return { ok: false, error: `no draft '${id}'` }
    const draft = this.#draftOf(doc)
    if (draft.status !== 'pending') return { ok: false, error: `draft '${id}' is already ${draft.status}` }
    // §7 guard 1: only after the user's yes, recorded in THIS conversation.
    if (!this.#approved.has(id) || draft.conversationId !== conversationId) {
      return {
        ok: false,
        error: `draft '${id}' is not approved in this conversation — the user must say yes first (§7)`,
      }
    }
    // §13 hard invariant 2, restated as §7's card rule: the agent never applies policy.
    if (draft.target === 'policy' || draft.cls === 'policy_change') {
      return {
        ok: false,
        error:
          'policy drafts apply by the user from the policy_change card — the agent has no policy write path (§13)',
      }
    }
    const outcome = await this.#api.applyDraft(draft)
    if (!outcome.ok) return { ok: false, error: outcome.error }
    const applied: SetupDraftRecord = { ...draft, status: 'applied', resolvedAt: this.#now().toISOString() }
    this.#saveDraft(applied)
    return {
      ok: true,
      draft: { id: applied.id, target: applied.target },
      detail: 'detail' in outcome ? outcome.detail : undefined,
    }
  }

  #openLoginCard(args: Record<string, unknown>): unknown {
    const engine = typeof args.engine === 'string' ? args.engine : ''
    const label = typeof args.label === 'string' ? args.label : ''
    if (engine === '' || label === '')
      return { ok: false, error: 'open_login_card requires engine and label' }
    // Never a credential near the agent (§7): the workbench opens the card; this chat
    // only ever sees the request.
    this.#api.openLoginCard(engine, label)
    this.#turnLoginCard = { engine, label }
    return { ok: true, engine, label }
  }

  #openKeyForm(args: Record<string, unknown>): unknown {
    const provider = typeof args.provider === 'string' ? args.provider : ''
    const label = typeof args.label === 'string' ? args.label : ''
    if (provider === '' || label === '')
      return { ok: false, error: 'open_key_form requires provider and label' }
    this.#api.openKeyForm(provider, label)
    this.#turnKeyForm = { provider, label }
    return { ok: true, provider, label }
  }

  async #registerRepository(args: Record<string, unknown>): Promise<unknown> {
    const label = typeof args.label === 'string' ? args.label.trim() : ''
    const urlOrPath = typeof args.url_or_path === 'string' ? args.url_or_path.trim() : ''
    if (label === '' || urlOrPath === '') {
      return { ok: false, error: 'register_repository requires label and url_or_path' }
    }
    const bootstrap = Array.isArray(args.bootstrap)
      ? args.bootstrap.filter((entry): entry is string => typeof entry === 'string')
      : undefined
    const checks = Array.isArray(args.checks)
      ? args.checks.filter((entry): entry is string => typeof entry === 'string')
      : undefined
    const outcome = await this.#api.registerRepository({
      label,
      urlOrPath,
      ...(bootstrap !== undefined && { bootstrap }),
      ...(checks !== undefined && { checks }),
      ...(typeof args.trust === 'string' && { trust: args.trust }),
    })
    return outcome
  }

  #setMetaSlot(args: Record<string, unknown>): unknown {
    const slotId = typeof args.slot_id === 'string' ? args.slot_id.trim() : ''
    if (slotId === '') return { ok: false, error: 'set_meta_slot requires slot_id' }
    this.#api.setMetaSlot(slotId)
    return { ok: true, slot_id: slotId }
  }

  // ── Draft persistence (the engines repo doubles as the settings-doc home) ─────────────────

  /** Draft docs live under `draft/<id>`; the record's own id rides along as `draftId`. */
  #saveDraft(draft: SetupDraftRecord): void {
    this.#store.atomic(() => {
      this.#store.engines.save({
        ...draft,
        draftId: draft.id,
        id: `${DRAFT_DOC_PREFIX}${draft.id}`,
      } as unknown as Parameters<Store['engines']['save']>[0])
    })
  }

  #draftOf(doc: { id?: unknown; draftId?: unknown }): SetupDraftRecord {
    const record = doc as unknown as SetupDraftRecord
    return { ...record, id: String(doc.draftId ?? String(doc.id ?? '').slice(DRAFT_DOC_PREFIX.length)) }
  }

  pendingDrafts(conversationId?: string): SetupDraftRecord[] {
    const docs = this.#store.engines.list()
    return docs
      .filter((doc) => String(doc.id).startsWith(DRAFT_DOC_PREFIX))
      .map((doc) => this.#draftOf(doc))
      .filter((draft) => draft.status === 'pending')
      .filter((draft) => conversationId === undefined || draft.conversationId === conversationId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  }
}
