/**
 * The release agent's GitHub leg (plan §14, R1.7): yield-to-duplicate first, then a pull
 * request through the user's own `gh` CLI with every outside action behind a confirmed
 * card. `pr_create` and `pr_merge` are always-confirm classes (§13) — `policyPreAuthorises`
 * refuses them outright — so opening a card stores the exact PR the user was shown and
 * nothing leaves the machine until the card settles approved. A merge additionally
 * requires GitHub, not the merge command's exit status, to report the PR `MERGED`
 * before the prflow machine advances (§14 "merged is confirmed by GitHub, never assumed
 * from an API call"). Target-branch movement re-running checks is a prflow row
 * (`ci_green --target_moved--> ci_pending`); whatever detects the movement fires it.
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import type { Effects, Json, Store, StoreDoc } from '@mec/contracts'
import { type PrEvent, type PrState, prTransition, yieldToDuplicate } from '@mec/integration'
import { type ConfirmationRecord, openConfirmation, resolveConfirmation } from '@mec/policy'

export type GhResult = { code: number; stdout: string; stderr: string }

/**
 * Every gh call is an argument array — never a shell string (§14 argv discipline). The
 * optional second parameter carries stdin only: the PR body travels by stdin
 * (`--body-file -`), never by argv, so a title or body can never become syntax. A plain
 * `(args) => Promise<GhResult>` satisfies this type; tests inject a recording fake.
 */
export type GhRun = (args: readonly string[], opts?: { stdin?: string }) => Promise<GhResult>

/** git through execFile, argv-only, for the one push this module makes (§13: push always confirms). */
export type GitExec = (args: readonly string[]) => Promise<GhResult>

const GH_TIMEOUT_MS = 30_000
const MAX_CAPTURE_CHARS = 4 * 1024 * 1024
/** How long a release card stays answerable; expiry is a policy resolution, never consent (§13). */
const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000
/** §14 yield pass: open PRs first (a human PR that already contains the change), then at most this many branch compares. */
const MAX_BRANCH_COMPARES = 10

const execResult = (
  error: (Error & { code?: number | string | null }) | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
): GhResult => ({
  // execFile reports a non-zero exit, a timeout kill and a spawn failure (ENOENT) all
  // through `error`; only a numeric code is an exit status — anything else is -1.
  code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1,
  stdout: String(stdout ?? ''),
  stderr: String(stderr ?? ''),
})

/** The user's `gh` (its auth is already local, §14); stdin is always closed so a `--body-file -` read cannot hang. */
export const defaultGhRun: GhRun = (args, opts) =>
  new Promise<GhResult>((resolve) => {
    const child = execFile(
      'gh',
      args,
      { timeout: GH_TIMEOUT_MS, maxBuffer: MAX_CAPTURE_CHARS },
      (error, stdout, stderr) => {
        resolve(execResult(error, stdout, stderr))
      },
    )
    if (child.stdin !== null) {
      child.stdin.on('error', () => {}) // EPIPE when gh exits before reading — not an error here.
      child.stdin.end(opts?.stdin ?? '')
    }
  })

const defaultGitExec: GitExec = (args) =>
  new Promise<GhResult>((resolve) => {
    execFile(
      'git',
      args,
      { timeout: GH_TIMEOUT_MS, maxBuffer: MAX_CAPTURE_CHARS },
      (error, stdout, stderr) => {
        resolve(execResult(error, stdout, stderr))
      },
    )
  })

/** JSON.parse that answers `undefined` instead of throwing on gh's output (gh text is data, §13 invariant 7). */
function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

/**
 * §14 yield-to-duplicate against GitHub, reusing the package's superset rule: only an open
 * PR (or a branch) that contains EVERY changed file yields — partial overlap is related
 * work, not a duplicate, and an empty change set must not match everything. Open PRs are
 * checked first (the common human-duplicate case), then up to ten remote branches via the
 * compare API. A gh call that fails is skipped, not fatal: no data is no duplicate.
 */
export async function yieldCheck(
  run: GhRun,
  repo: string,
  changedFiles: string[],
): Promise<{ yieldTo: string | null }> {
  if (changedFiles.length === 0) return { yieldTo: null }

  const listed = await run(['pr', 'list', '-R', repo, '--json', 'number,headRefName', '--state', 'open'])
  if (listed.code === 0) {
    for (const pr of parseJson<Array<{ number: number; headRefName: string }>>(listed.stdout) ?? []) {
      const viewed = await run(['pr', 'view', String(pr.number), '-R', repo, '--json', 'files'])
      if (viewed.code !== 0) continue
      const files = (parseJson<{ files: Array<{ filename: string }> }>(viewed.stdout)?.files ?? []).map(
        (file) => file.filename,
      )
      const decision = yieldToDuplicate({
        changedFiles,
        existingBranches: [{ name: pr.headRefName, files }],
      })
      if (decision.yield) return { yieldTo: decision.branch ?? pr.headRefName }
    }
  }

  const branches = await run(['api', `repos/${repo}/branches`, '--jq', '.[].name'])
  if (branches.code === 0) {
    // The compare base is `main`; comparing main with itself is a guaranteed no-files result.
    const names = lines(branches.stdout)
      .filter((name) => name !== 'main')
      .slice(0, MAX_BRANCH_COMPARES)
    for (const branch of names) {
      const compared = await run([
        'api',
        `repos/${repo}/compare/main...${branch}`,
        '--jq',
        '.files[].filename',
      ])
      if (compared.code !== 0) continue
      const decision = yieldToDuplicate({
        changedFiles,
        existingBranches: [{ name: branch, files: lines(compared.stdout) }],
      })
      if (decision.yield) return { yieldTo: branch }
    }
  }
  return { yieldTo: null }
}

export type PrBodyInput = {
  request: string
  tasks: Array<{ id: string; role: string; acceptedSha?: string }>
  integrationSha: string
  checks: Array<{ name: string; status: string }>
  findings: string[]
  decisions: string[]
}

/**
 * The §14 PR body: the request verbatim, the tasks that cover it with their accepted
 * SHAs, the checks as they ran on the exact integration SHA, findings and decisions —
 * the evidence a reviewer needs, with nothing about rounds or run ids (those stay in the
 * attempt record).
 */
export function buildPrBody(input: PrBodyInput): string {
  const out: string[] = []
  out.push('## Request', '', input.request, '')
  out.push('## Tasks', '', '| Task | Role | Accepted SHA |', '| --- | --- | --- |')
  for (const task of input.tasks) out.push(`| ${task.id} | ${task.role} | ${task.acceptedSha ?? '—'} |`)
  if (input.tasks.length === 0) out.push('| — | — | — |')
  out.push('')
  out.push('## Integration', '', `Integration SHA: \`${input.integrationSha}\``, '')
  out.push('| Check | Status |', '| --- | --- |')
  for (const check of input.checks) out.push(`| ${check.name} | ${check.status} |`)
  if (input.checks.length === 0) out.push('| — | — |')
  out.push('')
  out.push('## Findings')
  if (input.findings.length === 0) out.push('- None.')
  for (const finding of input.findings) out.push(`- ${finding}`)
  out.push('')
  out.push('## Decisions')
  if (input.decisions.length === 0) out.push('- None.')
  for (const decision of input.decisions) out.push(`- ${decision}`)
  out.push('', '---', 'Opened by MEC (Mubit Engineering Control); every action behind a confirmed card.', '')
  return out.join('\n')
}

/**
 * §13 always-confirm `git push` of the integration branch, through the bare cache with
 * argv only. The remote is the https URL `gh repo view` reports, so the user's gh
 * credential helper covers auth — MEC stores no credential and adds none. This helper is
 * the mechanical half; the push confirmation card itself is the guardrail.
 */
export async function pushIntegrationBranch(
  run: GhRun,
  repo: string,
  gitDir: string,
  integrationBranch: string,
  execGit: GitExec = defaultGitExec,
): Promise<{ pushed: true } | { pushed: false; error: string }> {
  // gh repo view takes the repository as a POSITIONAL argument (-R is not a repo-view flag).
  const viewed = await run(['repo', 'view', repo, '--json', 'url', '--jq', '.url'])
  const repoUrl = viewed.code === 0 ? viewed.stdout.trim() : ''
  if (repoUrl === '') {
    return { pushed: false, error: `gh repo view failed for ${repo}: ${viewed.stderr.trim()}` }
  }
  const pushed = await execGit(['-C', gitDir, 'push', repoUrl, integrationBranch])
  if (pushed.code !== 0) {
    return { pushed: false, error: pushed.stderr.trim() || `git push exited ${pushed.code}` }
  }
  return { pushed: true }
}

/** Everything the release routes need; tests inject a recording GhRun and a MemoryRepositories store. */
export type ReleaseDeps = {
  run: GhRun
  store: Store
  /** Present for the effects-queue wiring (§17); card resolution itself is inline below. */
  effects: Effects
  now: () => Date
}

/** The delivery's prflow projection (packages/integration prflow.ts), kept in the engines repo beside the settings docs. */
type PrFlowDoc = {
  id: string
  repo: string
  branch: string
  state: PrState
  prNumber?: number
  prUrl?: string
  updatedAt: string
}

const prFlowId = (repo: string, branch: string): string => `prflow:${repo}:${branch}`

function prFlowOf(store: Store, repo: string, branch: string, at: string): PrFlowDoc {
  const id = prFlowId(repo, branch)
  const doc = store.engines.get(id) as PrFlowDoc | undefined
  return doc === undefined ? { id, repo, branch, state: 'idle', updatedAt: at } : doc
}

function savePrFlow(store: Store, flow: PrFlowDoc): void {
  store.engines.save({
    id: flow.id,
    repo: flow.repo,
    branch: flow.branch,
    state: flow.state,
    ...(flow.prNumber !== undefined && { prNumber: flow.prNumber }),
    ...(flow.prUrl !== undefined && { prUrl: flow.prUrl }),
    updatedAt: flow.updatedAt,
  })
}

/**
 * Fire `event` on the delivery's prflow machine, but only along a listed row: a re-probe
 * of an unchanged state (checks read twice, a merge retried) must not throw for being
 * idempotent — the table in prflow.ts stays the single source of truth.
 */
function advance(flow: PrFlowDoc, event: PrEvent, at: string): PrFlowDoc {
  let to: PrState
  try {
    to = prTransition(flow.state, event)
  } catch {
    return flow
  }
  return { ...flow, state: to, updatedAt: at }
}

function appendEvent(
  store: Store,
  stream: string,
  type: string,
  body: Record<string, Json>,
  at: string,
): void {
  const seq = (store.events.read(stream).at(-1)?.seq ?? 0) + 1
  store.events.append(stream, { stream, seq, at, type, body: body as Json })
}

let idCounter = 0

/** A `conf_…` id (clock + counter + random, url-safe), the shape openConfirmation validates. */
function freshConfirmationId(): string {
  idCounter += 1
  return `conf_${Date.now().toString(36)}${idCounter.toString(36)}${randomBytes(4).toString('hex')}`
}

const expiresAt = (now: () => Date): string => new Date(now().getTime() + CONFIRMATION_TTL_MS).toISOString()

/** The pr_create card payload: exactly the PR the user was shown when they answered. */
export type PrCreatePayload = { repo: string; branch: string; title: string; body: string }

/** The pr_merge card payload: the PR the merge would land. */
export type PrMergePayload = { repo: string; prNumber: number }

const codedError = (code: string, detail: string): Error => new Error(`${code}: ${detail}`)

/** Loads a card the resolve routes accept; a missing, settled or wrong-class id never reaches gh. */
function cardFor(
  store: Store,
  confirmationId: string,
  cls: 'pr_create' | 'pr_merge',
): ConfirmationRecord & { payload?: Json } {
  const doc = store.confirmations.get(confirmationId) as (ConfirmationRecord & { payload?: Json }) | undefined
  if (doc === undefined) throw codedError('not_found', `confirmation ${confirmationId} not found`)
  if (doc.cls !== cls)
    throw codedError('class_mismatch', `confirmation ${confirmationId} is class '${doc.cls}'`)
  if (doc.status !== 'pending')
    throw codedError('already_handled', `confirmation ${confirmationId} is ${doc.status}`)
  return doc
}

const payloadOf = <T>(doc: { payload?: Json }, confirmationId: string): T => {
  if (doc.payload === undefined || typeof doc.payload !== 'object')
    throw codedError('bad_payload', `confirmation ${confirmationId} carries no payload`)
  return doc.payload as T
}

/**
 * §14/§13: open the `pr_create` card and return at once — nothing leaves the machine
 * unresolved. The record binds sha256(title+body+branch) so a changed PR is a different
 * question, and the delivery's prflow moves idle→ready_for_pr: integration completed,
 * the release agent is ready once the user says so.
 */
export async function createPrBehindCard(
  deps: ReleaseDeps,
  input: PrCreatePayload,
): Promise<{ confirmationId: string; prNumber?: number; prUrl?: string }> {
  const at = deps.now().toISOString()
  const record = openConfirmation({
    id: freshConfirmationId(),
    cls: 'pr_create',
    operationHash: createHash('sha256')
      .update(input.title + input.body + input.branch)
      .digest('hex'),
    expiresAt: expiresAt(deps.now),
  })
  const payload: Record<string, Json> = { ...input }

  deps.store.atomic(() => {
    deps.store.confirmations.save({ ...(record as unknown as StoreDoc), payload })
    savePrFlow(
      deps.store,
      advance(prFlowOf(deps.store, input.repo, input.branch, at), 'integration_complete', at),
    )
    appendEvent(
      deps.store,
      `release:${input.repo}:${input.branch}`,
      'pr_card_opened',
      { confirmationId: record.id, repo: input.repo, branch: input.branch, at },
      at,
    )
  })
  return { confirmationId: record.id }
}

/**
 * Settle the `pr_create` card (§13 CAS: first answer wins). Approve resolves FIRST — a
 * settled approval is the only thing that may leave the machine (invariant 1) — then
 * makes exactly one `gh pr create`, the body by stdin, and the prflow machine moves
 * pr_open with the PR number and url recorded. Deny resolves and calls gh not at all.
 */
export async function resolvePrCreate(
  deps: ReleaseDeps,
  input: { confirmationId: string; answer: 'approve' | 'deny' },
): Promise<{ status: string; prNumber?: number; prUrl?: string; error?: string }> {
  const at = deps.now().toISOString()
  const pending = cardFor(deps.store, input.confirmationId, 'pr_create')
  const payload = payloadOf<PrCreatePayload>({ payload: pending.payload }, input.confirmationId)
  const { outcome } = resolveConfirmation(pending, {
    now: at,
    answer: input.answer,
    expectedOperationHash: pending.operationHash,
  })
  deps.store.atomic(() => {
    deps.store.confirmations.save(outcome as unknown as StoreDoc)
  })

  if (outcome.status !== 'approved') {
    // Deny — or a policy resolution (expired/stale), which is never consent (§13): no gh.
    deps.store.atomic(() => {
      appendEvent(
        deps.store,
        `release:${payload.repo}:${payload.branch}`,
        'pr_denied',
        { confirmationId: input.confirmationId, status: outcome.status, at },
        at,
      )
    })
    return { status: outcome.status }
  }

  const created = await deps.run(
    [
      'pr',
      'create',
      '-R',
      payload.repo,
      '--head',
      payload.branch,
      '--title',
      payload.title,
      '--body-file',
      '-',
    ],
    { stdin: payload.body },
  )
  if (created.code !== 0) {
    // The approval is spent and reported honestly; a retry is a NEW card, never a replay.
    deps.store.atomic(() => {
      appendEvent(
        deps.store,
        `release:${payload.repo}:${payload.branch}`,
        'pr_create_failed',
        { confirmationId: input.confirmationId, stderr: created.stderr.slice(-2000), at },
        at,
      )
    })
    return { status: 'approved', error: created.stderr.trim() || `gh pr create exited ${created.code}` }
  }

  // gh prints the new PR's url on stdout; the number is its last path segment.
  const prUrl = lines(created.stdout).findLast((line) => /^https?:\/\//.test(line)) ?? ''
  const prNumber = Number.parseInt(prUrl.split('/').at(-1) ?? '', 10)
  deps.store.atomic(() => {
    const flow = advance(prFlowOf(deps.store, payload.repo, payload.branch, at), 'pr_created', at)
    savePrFlow(deps.store, {
      ...flow,
      ...(prUrl !== '' && Number.isFinite(prNumber) && { prNumber, prUrl }),
    })
    appendEvent(
      deps.store,
      `release:${payload.repo}:${payload.branch}`,
      'pr_created',
      { confirmationId: input.confirmationId, ...(prUrl !== '' && { prUrl }), at },
      at,
    )
  })
  return {
    status: 'approved',
    ...(prUrl !== '' && Number.isFinite(prNumber) && { prNumber, prUrl }),
  }
}

/**
 * Open the `pr_merge` card (§13: merge always confirms; policy can never pre-authorise
 * the class). The card binds the repo and PR number so a later answer can never merge a
 * different PR than the one the user saw.
 */
export async function openMergeCard(
  deps: ReleaseDeps,
  input: { repo: string; prNumber: number; originConfirmationId?: string },
): Promise<{ confirmationId: string }> {
  const at = deps.now().toISOString()
  const record = openConfirmation({
    id: freshConfirmationId(),
    cls: 'pr_merge',
    operationHash: createHash('sha256').update(`pr_merge:${input.repo}:${input.prNumber}`).digest('hex'),
    expiresAt: expiresAt(deps.now),
  })
  const payload: Record<string, Json> = {
    repo: input.repo,
    prNumber: input.prNumber,
    ...(input.originConfirmationId !== undefined && { originConfirmationId: input.originConfirmationId }),
  }
  deps.store.atomic(() => {
    deps.store.confirmations.save({ ...(record as unknown as StoreDoc), payload })
    appendEvent(
      deps.store,
      `release:${input.repo}:pr-${input.prNumber}`,
      'merge_card_opened',
      { confirmationId: record.id, repo: input.repo, prNumber: input.prNumber, at },
      at,
    )
  })
  return { confirmationId: record.id }
}

type CheckRow = { name: string; state: string }

/**
 * §14 merge: CI is read from GitHub BEFORE the card is touched — a pending or failing
 * check leaves the confirmation pending (the user's answer is not spent on a merge that
 * cannot run). With every check success: the card settles, `gh pr merge --merge` runs,
 * and MERGED is confirmed by a separate `gh pr view` — state `MERGED` alone moves the
 * prflow machine to merged; anything else reports `merge unconfirmed by GitHub` and the
 * delivery stays where the table says (ci_green — only GitHub confirms).
 */
export async function mergeBehindCard(
  deps: ReleaseDeps,
  input: { confirmationId: string; repo: string; prNumber: number; answer: 'approve' | 'deny' },
): Promise<{ merged: boolean; reason?: string }> {
  const at = deps.now().toISOString()
  const stream = `release:${input.repo}:pr-${input.prNumber}`

  const checked = await deps.run([
    'pr',
    'checks',
    '-R',
    input.repo,
    '--json',
    'name,state',
    String(input.prNumber),
  ])
  if (checked.code !== 0) return { merged: false, reason: 'ci_unreadable' }
  const checks = parseJson<CheckRow[]>(checked.stdout) ?? []
  // gh reports check states UPPERCASE ("SUCCESS"/"PENDING"/"FAILURE") in this version;
  // accept either case (the fake-gh unit tests used lowercase — keep both honest).
  const normalise = (state: string): string => state.toUpperCase()
  const ciGreen = checks.length > 0 && checks.every((check) => normalise(check.state) === 'SUCCESS')
  if (!ciGreen) {
    const reason = checks.some(
      (check) => normalise(check.state) !== 'PENDING' && normalise(check.state) !== 'SUCCESS',
    )
      ? 'ci_failed'
      : 'ci_pending'
    deps.store.atomic(() => {
      const flow = findFlowByPr(deps.store, input.repo, input.prNumber)
      if (flow !== undefined) savePrFlow(deps.store, advance(flow, 'ci_failed', at))
      appendEvent(
        deps.store,
        stream,
        'ci_observed',
        { repo: input.repo, prNumber: input.prNumber, checks, at },
        at,
      )
    })
    return { merged: false, reason }
  }

  const pending = cardFor(deps.store, input.confirmationId, 'pr_merge')
  const payload = payloadOf<PrMergePayload>({ payload: pending.payload }, input.confirmationId)
  // The card was answered for ONE PR (invariant 1): the caller's repo/number must be the
  // pair the user saw, or the approval does not cover the merge being attempted.
  if (payload.repo !== input.repo || payload.prNumber !== input.prNumber) {
    throw codedError(
      'payload_mismatch',
      `confirmation ${input.confirmationId} covers ${payload.repo}#${payload.prNumber}, not ${input.repo}#${input.prNumber}`,
    )
  }
  const { outcome } = resolveConfirmation(pending, {
    now: at,
    answer: input.answer,
    expectedOperationHash: pending.operationHash,
  })
  deps.store.atomic(() => {
    deps.store.confirmations.save(outcome as unknown as StoreDoc)
    const flow = findFlowByPr(deps.store, input.repo, input.prNumber)
    if (flow !== undefined) savePrFlow(deps.store, advance(flow, 'ci_passed', at))
  })

  if (outcome.status !== 'approved') {
    deps.store.atomic(() => {
      appendEvent(
        deps.store,
        stream,
        'merge_denied',
        { confirmationId: input.confirmationId, status: outcome.status, at },
        at,
      )
    })
    return { merged: false, reason: 'denied' }
  }

  const merged = await deps.run(['pr', 'merge', '-R', input.repo, '--merge', String(input.prNumber)])
  if (merged.code !== 0) {
    deps.store.atomic(() => {
      appendEvent(
        deps.store,
        stream,
        'merge_failed',
        { confirmationId: input.confirmationId, stderr: merged.stderr.slice(-2000), at },
        at,
      )
    })
    return { merged: false, reason: 'gh_merge_failed' }
  }

  // §14: the merge command's exit 0 is a claim; only GitHub's own state is the fact.
  const viewed = await deps.run(['pr', 'view', String(input.prNumber), '-R', input.repo, '--json', 'state'])
  const state = viewed.code === 0 ? parseJson<{ state: string }>(viewed.stdout)?.state : undefined
  if (state !== 'MERGED') {
    deps.store.atomic(() => {
      appendEvent(
        deps.store,
        stream,
        'merge_unconfirmed',
        { confirmationId: input.confirmationId, githubState: state ?? 'unknown', at },
        at,
      )
    })
    return { merged: false, reason: 'merge unconfirmed by GitHub' }
  }

  deps.store.atomic(() => {
    const flow = findFlowByPr(deps.store, input.repo, input.prNumber)
    if (flow !== undefined) savePrFlow(deps.store, advance(flow, 'merged_on_github', at))
    appendEvent(deps.store, stream, 'merged_on_github', { confirmationId: input.confirmationId, at }, at)
  })
  return { merged: true }
}

function findFlowByPr(store: Store, repo: string, prNumber: number): PrFlowDoc | undefined {
  return store.engines
    .list()
    .find(
      (doc) =>
        typeof doc.id === 'string' &&
        doc.id.startsWith('prflow:') &&
        doc.repo === repo &&
        doc.prNumber === prNumber,
    ) as PrFlowDoc | undefined
}
