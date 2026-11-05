/**
 * What a specialist's token can do on the mec-tools server (spec §6, §13, §26 "Platform-tool
 * fencing"). The server has already verified the token, its role's tool list and its generation;
 * this is the scope behind that.
 *
 * - `report`, `read` and `confirm` work. `ask_user`, `handback` and `request_confirmation` answer
 *   a named error until M2.2, never a success an agent could mistake for delivery.
 * - A `meta_agent` token is refused: the brain has its own server.
 * - `read` reaches only the token's own attempt, task, delivered messages and prompt revision.
 * - `confirm` is Claude's `--permission-prompt-tool`. It decides by rule and asks nobody: cards
 *   from specialists are M2.2, so §9's card path is narrowed to deny here. The sandbox is the
 *   boundary; these rules exist so a push is refused by name, and shell text is only a heuristic.
 */
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
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
import { Report } from '@mec/contracts'
import { ATTEMPT_TERMINAL, type AttemptState } from '@mec/domain'
import { BridgeImpl, type ToolCallHandler, type ToolName, type VerifiedToken } from '@mec/mec-tools'
import { checkDocId, reportDocId } from './core-facts'

/** §6: a text page is 4,000 characters by default. */
const PAGE_CHARS = 4000

/** §13 "Always confirm", as shell text: push, PRs, branch delete, force, and `gh` of any kind. */
const SEGMENT = '[^;&|\\n]*'
const ALWAYS_CONFIRM_SHELL: readonly { pattern: RegExp; what: string }[] = [
  { pattern: new RegExp(`\\bgit\\b${SEGMENT}\\bpush\\b`), what: 'git push' },
  { pattern: /(^|[\s;&|(/])gh(\s|$)/, what: 'the GitHub CLI' },
  {
    pattern: new RegExp(`\\bgit\\b${SEGMENT}\\bbranch\\b${SEGMENT}\\s(-d|-D|--delete)\\b`),
    what: 'branch delete',
  },
  { pattern: new RegExp(`\\bgit\\b${SEGMENT}\\s(--force\\b|--force-with-lease\\b)`), what: 'a forced git' },
]

const EDIT_TOOLS: Readonly<Record<string, Operation['kind']>> = {
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
}

/** Where an attempt may write, from its stored doc. */
export type AttemptScope = { worktree: string; tempDir: string; sandboxRequired: boolean }

export type Verdict = { allow: boolean; reason: string }

/** A path as the file system resolves it, for a file that may not exist yet. */
function resolved(path: string): string {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  return parent === path ? path : join(resolved(parent), basename(path))
}

const isWithin = (path: string, root: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
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
    return { allow: true, reason: 'shell under the required sandbox' }
  }
  if (operation.kind === 'edit' || operation.kind === 'write') {
    const paths = operation.paths ?? []
    if (paths.length === 0) return { allow: false, reason: 'no path to check' }
    const worktree = resolved(scope.worktree)
    const tempDir = resolved(scope.tempDir)
    for (const path of paths.map(resolved)) {
      const control = [join(worktree, '.mec'), join(worktree, '.git')].some((dir) => isWithin(path, dir))
      if (control) return { allow: false, reason: `${path} belongs to MEC` }
      if (!isWithin(path, worktree) && !isWithin(path, tempDir)) {
        return { allow: false, reason: `${path} is outside this attempt's worktree` }
      }
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

/** The same rule for an adapter that calls the bridge in-process; a missing doc denies. */
export function specialistBridge(store: Store): PermissionBridge {
  return new BridgeImpl(async (attempt, operation) => {
    const doc = store.attempts.get(attempt.attempt_id)
    const scope = doc === undefined ? undefined : scopeOf(doc)
    return scope !== undefined && judgeOperation(operation, scope).allow ? 'allow' : 'deny'
  })
}

export type SpecialistToolsDeps = {
  store: Store
  facts: Pick<CoreForEngines, 'permissionRequested'> & {
    reportReceived(attempt: AttemptRef, generation: Generation, report: Report, observed?: string): number
  }
  /** The worktree's real head, which a report's claim is recorded against (§10). */
  headOf: (worktree: string) => Promise<string>
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
      case 'handback':
      case 'request_confirmation':
        throw new Error(`mec-tools: ${tool} is not wired until M2.2`)
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
  const verdict = judgeOperation(operation, scope)
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
function inScope(attempt: StoreDoc, kind: string | undefined, id: string | undefined): boolean {
  if (id === undefined) return false
  if (kind === 'attempt') return id === attempt.id
  if (kind === 'task') return id === attempt.taskId
  if (kind === 'message') return id === attempt.origin_message_id
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
  if (!inScope(attempt, kind, id) || rest.length > 0) {
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
