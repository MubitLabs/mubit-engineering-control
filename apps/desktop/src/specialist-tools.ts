/**
 * What a specialist's token can do on the mec-tools server (spec §6, §13, §26 "Platform-tool
 * fencing"). The server has already verified the token, its role's tool list and its generation;
 * this is the scope behind that.
 *
 * - `report`, `read`, `ask_user`, `handback`, `request_confirmation` and `confirm` work.
 * - A `meta_agent` token is refused: the brain has its own server.
 * - `read` reaches only the token's own attempt, task, delivered messages and prompt revision.
 * - `confirm` is Claude's `--permission-prompt-tool`. It decides by rule. A confirm-by-default
 *   class waits on a card, or policy's pre-authorisation, and an always-confirm class stays denied
 *   (§13). A worker can open a card and never resolve one: no tool here settles anything, and only
 *   the owner's answer on the inbox route does. The sandbox is the boundary; these rules exist so
 *   a push is refused by name, and shell text is only a heuristic.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  AttemptRef,
  CoreForEngines,
  Generation,
  Json,
  Operation,
  PermissionBridge,
  Store,
  StoreDoc,
} from '@mec/contracts'
import { Question, Report } from '@mec/contracts'
import { ATTEMPT_TERMINAL, type AttemptState } from '@mec/domain'
import { BridgeImpl, type ToolCallHandler, type ToolName, type VerifiedToken } from '@mec/mec-tools'
import type { FollowUps } from '@mec/meta'
import {
  ALWAYS_CONFIRM,
  type ConfirmationClass,
  type ConfirmationRecord,
  type PolicyDoc,
  policyPreAuthorises,
  resolveConfirmation,
} from '@mec/policy'
import { redact } from '@mec/slots'
import { checkDocId, reportDocId } from './core-facts'

/** §6: a text page is 4,000 characters by default. */
const PAGE_CHARS = 4000

/**
 * §13 "Always confirm", as shell text: push, PRs, branch delete, force, and `gh` of any kind.
 * `update-ref` is a branch delete by another name, and no worker needs it: MEC does the commit.
 */
const SEGMENT = '[^;&|\\n]*'
const ALWAYS_CONFIRM_SHELL: readonly { pattern: RegExp; what: string }[] = [
  { pattern: new RegExp(`\\bgit\\b${SEGMENT}\\bpush\\b`), what: 'git push' },
  { pattern: /(^|[\s;&|(/])gh(\s|$)/, what: 'the GitHub CLI' },
  {
    pattern: new RegExp(`\\bgit\\b${SEGMENT}\\bbranch\\b${SEGMENT}\\s(-d|-D|--delete)\\b`),
    what: 'branch delete',
  },
  { pattern: new RegExp(`\\bgit\\b${SEGMENT}\\bupdate-ref\\b`), what: 'a direct ref update' },
  { pattern: new RegExp(`\\bgit\\b${SEGMENT}\\s(--force\\b|--force-with-lease\\b)`), what: 'a forced git' },
]

/**
 * §13 "Confirm by default", as shell text: what a worker may do once someone agrees. Under the
 * sandbox these reach no network, so the card decides before an attempt spends a turn on a failure.
 */
const CONFIRM_BY_DEFAULT_SHELL: readonly { pattern: RegExp; cls: ConfirmationClass; what: string }[] = [
  {
    pattern: /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b|\bpip3?\s+install\b|\bcargo\s+add\b|\bgo\s+get\b/,
    cls: 'install',
    what: 'a dependency install',
  },
  {
    pattern: /\bprisma\s+migrate\b|\balembic\s+revision\b|\bdrizzle-kit\s+generate\b|\bmakemigrations\b/,
    cls: 'migration',
    what: 'generating a migration',
  },
]

/** How long a worker's `confirm` holds for an answer; expiry is never consent (§13). */
const CARD_WAIT_MS = 120_000

/** How often a waiting `confirm` looks at the card. */
const CARD_POLL_MS = 100

const EDIT_TOOLS: Readonly<Record<string, Operation['kind']>> = {
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
}

/** Where an attempt may write, from its stored doc. */
export type AttemptScope = { worktree: string; tempDir: string; sandboxRequired: boolean }

/** `card` names the class that can still say yes; with it, `allow` is the answer without one. */
export type Verdict = { allow: boolean; reason: string; card?: ConfirmationClass }

/** A chain this long is a loop, or not worth following: past it the path is denied. */
const MAX_LINKS = 32

/**
 * Walks up to what exists, then down again. `native` answers the name on disk, not the caller's
 * spelling. `existsSync` follows links, so a dangling one reads as absent: a write through it lands
 * at its target, and that target is the path to judge.
 */
function follow(path: string, links: { left: number }): string {
  if (existsSync(path)) return realpathSync.native(path)
  const parent = dirname(path)
  if (parent === path) return path
  const real = join(follow(parent, links), basename(path))
  if (lstatSync(real, { throwIfNoEntry: false })?.isSymbolicLink() !== true) return real
  links.left -= 1
  if (links.left < 0) throw new Error(`too many links at ${real}`)
  const target = readlinkSync(real)
  // Not `join`: it would fold a `..` past a link before the file system has followed that link.
  return follow(isAbsolute(target) ? target : `${dirname(real)}${sep}${target}`, links)
}

/** A path as the file system resolves it, for a file that may not exist yet. */
const resolved = (path: string): string => follow(path, { left: MAX_LINKS })

/** The default volume on a Mac matches names without case, so `.GIT` is `.git` there. */
const folded = (path: string): string => (process.platform === 'darwin' ? path.toLowerCase() : path)

const isWithin = (path: string, root: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

type LeafStat = NonNullable<ReturnType<typeof lstatLeaf>>

/** Bigint: an inode past 2^53 must not read as another file's. */
const lstatLeaf = (path: string) => lstatSync(path, { bigint: true, throwIfNoEntry: false })

const inodeOf = (stat: LeafStat): string => `${stat.dev}:${stat.ino}`

/** Everything under `.mec`, by inode. */
function addTree(path: string, inodes: Set<string>): void {
  const stat = lstatLeaf(path)
  if (stat === undefined) return
  inodes.add(inodeOf(stat))
  if (stat.isDirectory()) for (const name of readdirSync(path)) addTree(join(path, name), inodes)
}

/** A hard link names a control file with a path none of the checks above can see. */
function controlInodes(worktree: string): Set<string> {
  const inodes = new Set<string>()
  const pointer = lstatLeaf(join(worktree, '.git'))
  if (pointer !== undefined) inodes.add(inodeOf(pointer))
  addTree(join(worktree, '.mec'), inodes)
  return inodes
}

/** The rule behind `confirm`. Everything it does not name is denied, with a reason. */
export function judgeOperation(operation: Operation, scope: AttemptScope): Verdict {
  if (operation.kind === 'shell') {
    const command = (operation.command ?? []).join(' ')
    if (command.trim() === '') return { allow: false, reason: 'no command to check' }
    for (const { pattern, what } of ALWAYS_CONFIRM_SHELL) {
      if (pattern.test(command)) {
        return { allow: false, reason: `${what} needs the owner's confirmation; a worker cannot do it` }
      }
    }
    if (!scope.sandboxRequired) return { allow: false, reason: 'shell needs the required sandbox' }
    for (const { pattern, cls, what } of CONFIRM_BY_DEFAULT_SHELL) {
      if (pattern.test(command)) return { allow: false, reason: `${what} needs a confirmation`, card: cls }
    }
    return { allow: true, reason: 'shell under the required sandbox' }
  }
  if (operation.kind === 'edit' || operation.kind === 'write') {
    const paths = operation.paths ?? []
    if (paths.length === 0) return { allow: false, reason: 'no path to check' }
    try {
      const worktree = resolved(scope.worktree)
      const tempDir = resolved(scope.tempDir)
      for (const path of paths.map(resolved)) {
        const control = [join(worktree, '.mec'), join(worktree, '.git')].some((dir) =>
          isWithin(folded(path), folded(dir)),
        )
        if (control) return { allow: false, reason: `${path} belongs to MEC` }
        if (!isWithin(path, worktree) && !isWithin(path, tempDir)) {
          return { allow: false, reason: `${path} is outside this attempt's worktree` }
        }
        const leaf = lstatLeaf(path)
        if (leaf?.isFile() !== true) continue
        if (controlInodes(worktree).has(inodeOf(leaf))) {
          return { allow: false, reason: `${path} belongs to MEC` }
        }
        // A write lands on every name: the other one may be anywhere, and this rule cannot see it.
        if (leaf.nlink > 1n) return { allow: false, reason: `${path} is a hard link to another file` }
      }
    } catch (error) {
      return { allow: false, reason: `cannot resolve that path: ${(error as Error).message}` }
    }
    return { allow: true, reason: 'inside the worktree' }
  }
  return { allow: false, reason: `${operation.tool ?? operation.kind} is not allowed to a worker` }
}

/** Claude's permission request as a contract `Operation`. */
function operationOf(toolName: string, input: Record<string, unknown>, worktree: string): Operation {
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    return { kind: 'shell', summary: `Bash: ${command || '(empty)'}`.slice(0, 200), command: [command] }
  }
  const kind = EDIT_TOOLS[toolName]
  if (kind !== undefined) {
    const raw = input.file_path ?? input.notebook_path
    const paths = typeof raw === 'string' && raw !== '' ? [resolve(worktree, raw)] : []
    return { kind, summary: `${toolName}: ${paths[0] ?? '(no path)'}`, paths, tool: toolName }
  }
  return { kind: 'other', summary: toolName || '(unnamed tool)', tool: toolName || 'unnamed' }
}

function scopeOf(attempt: StoreDoc): AttemptScope | undefined {
  const { worktree, temp_dir: tempDir, sandbox } = attempt
  if (typeof worktree !== 'string' || typeof tempDir !== 'string') return undefined
  return { worktree, tempDir, sandboxRequired: sandbox === 'required' }
}

/** Cards from a worker: what `decide` needs beyond the rule. Absent, a card-class ask is denied. */
export type CardDeps = {
  followups: Pick<FollowUps, 'openCard' | 'handback'>
  policy: PolicyDoc
  waitMs?: number
  pollMs?: number
  /** Ends every wait: a closing server answers no more cards. */
  signal?: AbortSignal
  now?: () => Date
}

/**
 * The rule, then the wait. `confirm` and the in-process bridge both come here, so the two cannot
 * disagree. An expired card is denied and stays expired: there is no way from here to `approved`.
 */
export async function decideOperation(
  store: Store,
  cards: CardDeps | undefined,
  attempt: StoreDoc,
  operation: Operation,
): Promise<Verdict> {
  const scope = scopeOf(attempt)
  if (scope === undefined) return { allow: false, reason: 'this attempt has no worktree yet' }
  const verdict = judgeOperation(operation, scope)
  if (verdict.card === undefined || cards === undefined) return verdict
  const repoId = typeof attempt.repoId === 'string' ? attempt.repoId : workRepo(store, attempt)
  if (policyPreAuthorises(cards.policy, verdict.card, { ...(repoId !== undefined && { repoId }) })) {
    return { allow: true, reason: `${verdict.card} is pre-authorised by policy` }
  }
  const now = cards.now ?? (() => new Date())
  const waitMs = cards.waitMs ?? CARD_WAIT_MS
  const card = store.atomic(() =>
    cards.followups.openCard(
      attempt,
      {
        cls: verdict.card as string,
        operation: cleanFields({ summary: operation.summary, command: operation.command ?? [] }),
        evidence: cleanFields({ why: verdict.reason, attempt: String(attempt.id) }),
        expiresAt: new Date(now().getTime() + waitMs).toISOString(),
        notify: false,
      },
      now().toISOString(),
    ),
  )
  return awaitCard(store, cards, String(attempt.id), String(card.id), verdict)
}

function workRepo(store: Store, attempt: StoreDoc): string | undefined {
  const repoId = store.workItems.get(String(attempt.workItemId))?.repoId
  return typeof repoId === 'string' ? repoId : undefined
}

async function awaitCard(
  store: Store,
  cards: CardDeps,
  attemptId: string,
  cardId: string,
  verdict: Verdict,
): Promise<Verdict> {
  const now = cards.now ?? (() => new Date())
  for (;;) {
    const card = store.confirmations.get(cardId)
    if (card?.status === 'approved') return { allow: true, reason: 'the owner approved this' }
    if (card?.status !== 'pending') {
      return { allow: false, reason: `${verdict.reason}: the card is ${String(card?.status ?? 'gone')}` }
    }
    const state = String(store.attempts.get(attemptId)?.state)
    if (state !== 'running') return { allow: false, reason: `${verdict.reason}: the attempt is ${state}` }
    if (cards.signal?.aborted === true) return { allow: false, reason: `${verdict.reason}: MEC is closing` }
    if (now().toISOString() > String(card.expiresAt)) {
      expireCard(store, cardId, now().toISOString())
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, cards.pollMs ?? CARD_POLL_MS))
  }
}

/** Expiry through the same compare-and-set an answer goes through; the first one wins. */
function expireCard(store: Store, cardId: string, at: string): void {
  store.atomic(() => {
    const doc = store.confirmations.get(cardId) as unknown as ConfirmationRecord | undefined
    if (doc?.status !== 'pending') return
    const { outcome } = resolveConfirmation(doc, {
      now: at,
      answer: 'deny',
      expectedOperationHash: doc.operationHash,
      ...(doc.inputSha !== undefined && { expectedInputSha: doc.inputSha }),
    })
    store.confirmations.save(outcome as unknown as StoreDoc)
  })
}

function cleanFields(fields: Record<string, unknown>): Record<string, Json> {
  return JSON.parse(redact(JSON.stringify(fields), [], [])) as Record<string, Json>
}

/** The same rule for an adapter that calls the bridge in-process; a missing doc denies. */
export function specialistBridge(store: Store, cards?: CardDeps): PermissionBridge {
  return new BridgeImpl(async (attempt, operation) => {
    const doc = store.attempts.get(attempt.attempt_id)
    if (doc === undefined) return 'deny'
    return (await decideOperation(store, cards, doc, operation)).allow ? 'allow' : 'deny'
  })
}

export type SpecialistToolsDeps = {
  store: Store
  facts: Pick<CoreForEngines, 'permissionRequested'> & {
    reportReceived(attempt: AttemptRef, generation: Generation, report: Report, observed?: string): number
    questionAsked?(
      attempt: AttemptRef,
      question: Question,
    ): { questionId: string; reused: boolean; answer?: string }
  }
  /** The worktree's real head, which a report's claim is recorded against (§10). */
  headOf: (worktree: string) => Promise<string>
  /** Cards and handbacks; absent, those tools answer an error, never a success. */
  cards?: CardDeps
}

export function specialistTools(deps: SpecialistToolsDeps): ToolCallHandler {
  const { store } = deps
  return async (ctx, tool, args) => {
    if (ctx.role !== 'specialist') {
      throw new Error('mec-tools: a meta agent token is not served here; the brain has its own server')
    }
    const attempt = store.attempts.get(ctx.attemptId)
    if (attempt === undefined) throw new Error(`mec-tools: unknown attempt ${ctx.attemptId}`)
    if (attempt.generation !== ctx.generation) throw new Error('stale generation')
    const input = (args ?? {}) as Record<string, unknown>
    switch (tool) {
      case 'report':
        return report(deps, ctx, attempt, input)
      case 'read':
        return read(store, attempt, input)
      case 'confirm':
        return confirm(deps, ctx, attempt, input)
      case 'ask_user':
        return askUser(deps, ctx, attempt, input)
      case 'handback':
        return handback(deps, attempt, input)
      case 'request_confirmation':
        return requestConfirmation(deps, attempt, input)
      default:
        throw new Error(`mec-tools: ${tool satisfies ToolName} is not a specialist tool`)
    }
  }
}

async function report(
  deps: SpecialistToolsDeps,
  ctx: VerifiedToken,
  attempt: StoreDoc,
  input: Record<string, unknown>,
): Promise<unknown> {
  assertLive(attempt)
  const parsed = Report.safeParse(input)
  if (!parsed.success) throw new Error(`mec-tools: invalid report: ${parsed.error.message}`)
  const worktree = attempt.worktree
  const observed =
    typeof worktree === 'string' ? await deps.headOf(worktree).catch(() => undefined) : undefined
  const ref = { attempt_id: ctx.attemptId, generation: ctx.generation }
  const n = deps.store.atomic(() => deps.facts.reportReceived(ref, ctx.generation, parsed.data, observed))
  return { ok: true, report: n }
}

/** §12.6: one concrete question, kept in the specialist's words. */
function askUser(
  deps: SpecialistToolsDeps,
  ctx: VerifiedToken,
  attempt: StoreDoc,
  input: Record<string, unknown>,
): unknown {
  assertLive(attempt)
  const { facts, store } = deps
  if (facts.questionAsked === undefined) throw new Error('mec-tools: ask_user is not available here')
  const parsed = Question.safeParse({
    text: input.question,
    ...(input.options !== undefined && { options: input.options }),
    ...(input.for_message_id !== undefined && { for_message_id: input.for_message_id }),
    ...(input.evidence_ref !== undefined && { evidence_ref: input.evidence_ref }),
  })
  if (!parsed.success) throw new Error(`mec-tools: invalid question: ${parsed.error.message}`)
  const ref = { attempt_id: ctx.attemptId, generation: ctx.generation }
  const asked = store.atomic(() =>
    (facts.questionAsked as NonNullable<typeof facts.questionAsked>)(ref, parsed.data),
  )
  const { questionId, reused, answer } = asked
  return { ok: true, question_id: questionId, reused, ...(answer !== undefined && { answer }) }
}

/** §12.3: once, with a reason, and only for what this attempt owns. */
function handback(deps: SpecialistToolsDeps, attempt: StoreDoc, input: Record<string, unknown>): unknown {
  assertLive(attempt)
  const { cards, store } = deps
  if (cards === undefined) throw new Error('mec-tools: handback is not available here')
  const messageId = typeof input.message_id === 'string' ? input.message_id : ''
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (messageId === '' || reason === '') throw new Error('mec-tools: handback needs a message and a reason')
  const at = new Date().toISOString()
  const given = store.atomic(() => cards.followups.handback(attempt, messageId, redact(reason, [], []), at))
  if (!given.ok) throw new Error(`mec-tools: handback refused: ${given.reason}`)
  return { ok: true }
}

/**
 * §6, §13: a card for a person, which this tool never settles. An always-confirm class stays out
 * of a worker's reach, a card with no evidence states nothing to approve, and the answer reaches
 * the attempt as an input.
 */
function requestConfirmation(
  deps: SpecialistToolsDeps,
  attempt: StoreDoc,
  input: Record<string, unknown>,
): unknown {
  assertLive(attempt)
  const { cards, store } = deps
  if (cards === undefined) throw new Error('mec-tools: request_confirmation is not available here')
  const operation = input.operation as Record<string, unknown> | undefined
  const evidence = input.evidence as Record<string, unknown> | undefined
  const cls = typeof operation?.class === 'string' ? operation.class : ''
  if (cls === '') throw new Error('mec-tools: request_confirmation needs operation.class')
  if ((ALWAYS_CONFIRM as readonly string[]).includes(cls)) {
    throw new Error(`mec-tools: ${cls} needs the owner's confirmation; a worker cannot request it`)
  }
  if (typeof evidence !== 'object' || evidence === null || Object.keys(evidence).length === 0) {
    throw new Error('mec-tools: request_confirmation needs evidence')
  }
  const repoId = workRepo(store, attempt)
  if (
    policyPreAuthorises(cards.policy, cls as ConfirmationClass, { ...(repoId !== undefined && { repoId }) })
  ) {
    return { ok: true, status: 'approved', pre_authorised: true }
  }
  const now = cards.now ?? (() => new Date())
  const card = store.atomic(() =>
    cards.followups.openCard(
      attempt,
      {
        cls: redact(cls, [], []),
        operation: cleanFields(operation as Record<string, unknown>),
        evidence: cleanFields(evidence),
        expiresAt: new Date(now().getTime() + (cards.waitMs ?? CARD_WAIT_MS)).toISOString(),
        notify: true,
      },
      now().toISOString(),
    ),
  )
  return { ok: true, confirmation_id: String(card.id), status: String(card.status) }
}

async function confirm(
  deps: SpecialistToolsDeps,
  ctx: VerifiedToken,
  attempt: StoreDoc,
  input: Record<string, unknown>,
): Promise<unknown> {
  assertLive(attempt)
  const scope = scopeOf(attempt)
  if (scope === undefined) throw new Error('mec-tools: this attempt has no worktree yet')
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : ''
  // Claude sends `input`; the tool's schema says `tool_input`. Either way, a request with nothing
  // to judge is denied below, because an empty command is not a harmless one.
  const toolInput = (input.input ?? input.tool_input ?? {}) as Record<string, unknown>
  const operation = operationOf(toolName, toolInput, scope.worktree)
  const requestId =
    typeof input.tool_use_id === 'string' && input.tool_use_id !== ''
      ? input.tool_use_id
      : createHash('sha256')
          .update(JSON.stringify([toolName, toolInput]))
          .digest('hex')
          .slice(0, 16)
  const ref = { attempt_id: ctx.attemptId, generation: ctx.generation }
  deps.store.atomic(() => deps.facts.permissionRequested(ref, requestId, operation))
  const verdict = await decideOperation(deps.store, deps.cards, attempt, operation)
  return verdict.allow
    ? { behavior: 'allow', updatedInput: toolInput }
    : { behavior: 'deny', message: verdict.reason }
}

function assertLive(attempt: StoreDoc): void {
  if (ATTEMPT_TERMINAL.includes(String(attempt.state) as AttemptState)) {
    throw new Error(`mec-tools: attempt ${String(attempt.id)} has ended`)
  }
}

/** §6: a specialist reads only its own task and attempt, what reached it, and its prompt. */
function inScope(store: Store, attempt: StoreDoc, kind: string | undefined, id: string | undefined): boolean {
  if (id === undefined) return false
  if (kind === 'attempt') return id === attempt.id
  if (kind === 'task') return id === attempt.taskId
  if (kind === 'message') {
    return id === attempt.origin_message_id || store.messages.get(id)?.ownerAttemptId === attempt.id
  }
  if (kind === 'prompts') return id === attempt.bundle_revision
  return false
}

/** One bounded page; the cursor is the offset of the next one. */
function page(text: string, cursor: unknown): Json {
  const start = typeof cursor === 'string' ? Number(cursor) : 0
  if (!Number.isInteger(start) || start < 0) throw new Error('mec-tools: invalid cursor')
  const next = start + PAGE_CHARS
  return { text: text.slice(start, next), ...(next < text.length && { next: String(next) }) }
}

const REPORT_FIELDS = [
  'id',
  'taskId',
  'workItemId',
  'state',
  'generation',
  'engine',
  'branch',
  'base_sha',
  'head_sha',
  'worktree',
  'bundle_revision',
  'resolved_model',
  'checks_note',
] as const

function read(store: Store, attempt: StoreDoc, input: Record<string, unknown>): Json {
  const resource = typeof input.resource === 'string' ? input.resource : ''
  const [kind, id, part, ...rest] = resource.split('/')
  if (!inScope(store, attempt, kind, id) || rest.length > 0) {
    throw new Error(`mec-tools: ${resource || 'that'} is not readable by this attempt`)
  }
  return page(JSON.stringify(resourceBody(store, attempt, kind as string, id as string, part)), input.cursor)
}

function resourceBody(
  store: Store,
  attempt: StoreDoc,
  kind: string,
  id: string,
  part: string | undefined,
): unknown {
  const attemptId = String(attempt.id)
  if (kind === 'attempt' && part === undefined) {
    return Object.fromEntries(REPORT_FIELDS.map((field) => [field, attempt[field]]))
  }
  if (kind === 'attempt' && part === 'report') {
    const count = typeof attempt.reports === 'number' ? attempt.reports : 0
    return Array.from({ length: count }, (_, index) => store.engines.get(reportDocId(attemptId, index + 1)))
  }
  if (kind === 'attempt' && part === 'checks') {
    const names = Array.isArray(attempt.checks) ? attempt.checks : []
    return names.map((name) => store.engines.get(checkDocId(attemptId, String(name))))
  }
  if (part !== undefined) throw new Error(`mec-tools: ${kind}/${id}/${part} is not a resource`)
  if (kind === 'task') {
    const task = store.tasks.get(id)
    return {
      id,
      objective: task?.objective,
      role: task?.role,
      status: task?.status,
      acceptanceChecks: task?.acceptanceChecks,
      ownedPaths: task?.ownedPaths,
    }
  }
  if (kind === 'message') return { id, text: store.messages.get(id)?.text }
  return { revision: id, text: store.engines.get(`prompts/${id}`)?.text }
}
