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
import { isAbsolute } from 'node:path'
import type { Effects, Json, Store, StoreDoc } from '@mec/contracts'
import { type PrEvent, type PrState, prTransition, yieldToDuplicate } from '@mec/integration'
import { type ConfirmationRecord, openConfirmation, resolveConfirmation } from '@mec/policy'
import { redact } from '@mec/slots'

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

export const defaultGitExec: GitExec = (args) =>
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
 * §13 always-confirm `git push` of one exact commit, through the registered repository with
 * argv only. The remote is the https URL `gh repo view` reports, so the user's gh credential
 * helper covers auth — MEC stores no credential and adds none. The refspec names the bound
 * SHA, never a moving ref, and carries no `+`: a remote that diverged rejects the push, and
 * nothing here can force it. A failed exit may still have landed (a timeout kill), so the
 * remote is read before reporting failure (§20 "reconcile by idempotency marker").
 */
export async function pushIntegrationBranch(
  run: GhRun,
  repo: string,
  gitDir: string,
  target: { branch: string; headSha: string },
  execGit: GitExec = defaultGitExec,
): Promise<{ pushed: true } | { pushed: false; error: string }> {
  // gh repo view takes the repository as a POSITIONAL argument (-R is not a repo-view flag).
  const viewed = await run(['repo', 'view', repo, '--json', 'url', '--jq', '.url'])
  const repoUrl = viewed.code === 0 ? viewed.stdout.trim() : ''
  if (repoUrl === '') {
    return { pushed: false, error: `gh repo view failed for ${repo}: ${viewed.stderr.trim()}` }
  }
  const ref = `refs/heads/${target.branch}`
  const pushed = await execGit(['-C', gitDir, 'push', repoUrl, `${target.headSha}:${ref}`])
  if (pushed.code === 0) return { pushed: true }
  const remote = await execGit(['-C', gitDir, 'ls-remote', repoUrl, ref])
  if (remote.code === 0 && remote.stdout.split(/\s/)[0] === target.headSha) return { pushed: true }
  return { pushed: false, error: pushed.stderr.trim() || `git push exited ${pushed.code}` }
}

/** Everything the release routes need; tests inject a recording GhRun and a MemoryRepositories store. */
export type ReleaseDeps = {
  run: GhRun
  store: Store
  /** Present for the effects-queue wiring (§17); card resolution itself is inline below. */
  effects: Effects
  now: () => Date
  /** The push leg's git; tests may inject one, production uses the argv-only default. */
  git?: GitExec
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

/** Release stream names are per delivery; the workbench subscribes this one fixed stream to refresh its tray. */
const INBOX_STREAM = 'inbox'

function appendEvent(
  store: Store,
  stream: string,
  type: string,
  body: Record<string, Json>,
  at: string,
): void {
  for (const name of [stream, INBOX_STREAM]) {
    const seq = (store.events.read(name).at(-1)?.seq ?? 0) + 1
    store.events.append(name, { stream: name, seq, at, type, body: body as Json })
  }
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
export type PrMergePayload = { repo: string; prNumber: number; title?: string; branch?: string }

/** The push card payload: where it pushes, by registration, never a caller's path. */
export type PushPayload = { repoId: string; repo: string; branch: string }

/** The classes this module acts on; anything else in the inbox settles without touching GitHub. */
const RELEASE_CLASSES = ['push', 'pr_create', 'pr_merge'] as const
type ReleaseClass = (typeof RELEASE_CLASSES)[number]

const codedError = (code: string, detail: string): Error => new Error(`${code}: ${detail}`)

/** A refusal to open or answer a card, as `{status, error, detail}`; nothing was settled. Anything else is a bug. */
const REFUSALS = new Set([
  'unknown_repo',
  'repo_not_local',
  'remote_unreadable',
  'default_branch',
  'head_unreadable',
  'stale_head',
  'invalid_ref',
  'pr_unreadable',
  'pr_not_open',
])

export function refusalOf(error: unknown): { status: number; error: string; detail: string } | undefined {
  if (!(error instanceof Error)) return undefined
  const [code = '', ...rest] = error.message.split(': ')
  if (!REFUSALS.has(code)) return undefined
  return { status: code === 'unknown_repo' ? 404 : 422, error: code, detail: rest.join(': ') }
}

/** `-R` and the ref API path take these verbatim; one plain name each, or the card never opens. */
const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

function assertRepo(repo: string): void {
  if (!REPO_SLUG.test(repo)) throw codedError('invalid_ref', `'${repo}' is not owner/name`)
}

function assertBranch(branch: string): void {
  if (!BRANCH_NAME.test(branch) || branch.includes('..'))
    throw codedError('invalid_ref', `'${branch}' is not a plain branch name`)
}

const shaOf = (text: string): string | undefined => {
  const sha = text.trim()
  return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined
}

/** Loads a card the resolve routes accept; a missing, settled or wrong-class id never reaches gh. */
function cardFor(
  store: Store,
  confirmationId: string,
  cls: ReleaseClass,
): ConfirmationRecord & { payload?: Json } {
  const doc = store.confirmations.get(confirmationId) as (ConfirmationRecord & { payload?: Json }) | undefined
  if (doc === undefined) throw codedError('not_found', `confirmation ${confirmationId} not found`)
  if (doc.cls !== cls)
    throw codedError('class_mismatch', `confirmation ${confirmationId} is class '${doc.cls}'`)
  if (doc.status !== 'pending')
    throw codedError('already_handled', `confirmation ${confirmationId} is ${doc.status}`)
  return doc
}

/**
 * §13 compare-and-set. The card is re-read here, with no await before the save, because
 * every pre-flight awaits gh: two answers can both pass it, and only this read picks the
 * winner. `currentHead` is what the head is now; a card bound to another head goes stale.
 */
function settleCard(
  deps: ReleaseDeps,
  confirmationId: string,
  cls: ReleaseClass,
  answer: 'approve' | 'deny',
  at: string,
  currentHead?: string,
): ConfirmationRecord {
  const fresh = cardFor(deps.store, confirmationId, cls)
  const { outcome } = resolveConfirmation(fresh, {
    now: at,
    answer,
    expectedOperationHash: fresh.operationHash,
    ...((currentHead ?? fresh.inputSha) !== undefined && { expectedInputSha: currentHead ?? fresh.inputSha }),
  })
  deps.store.atomic(() => {
    deps.store.confirmations.save(outcome as unknown as StoreDoc)
  })
  return outcome
}

/** Only an unexpired approve looks at the world; a deny or an expiry settles on what is stored. */
const needsPreflight = (answer: 'approve' | 'deny', card: ConfirmationRecord, at: string): boolean =>
  answer === 'approve' && at <= card.expiresAt

/** A branch's head on GitHub; undefined when it cannot be read, which never counts as a match. */
async function remoteHead(run: GhRun, repo: string, branch: string): Promise<string | undefined> {
  const read = await run(['api', `repos/${repo}/git/ref/heads/${branch}`, '--jq', '.object.sha'])
  return read.code === 0 ? shaOf(read.stdout) : undefined
}

/** Tool stderr as it may be kept: redacted before durability, tail only. */
const evidence = (stderr: string): string => redact(stderr.trim(), [], []).slice(-2000)

const payloadOf = <T>(doc: { payload?: Json }, confirmationId: string): T => {
  if (doc.payload === undefined || typeof doc.payload !== 'object')
    throw codedError('bad_payload', `confirmation ${confirmationId} carries no payload`)
  return doc.payload as T
}

/**
 * §14/§13: open the `pr_create` card and return at once — nothing leaves the machine
 * unresolved. The record binds sha256(title+body+branch+head) and the head as its input SHA,
 * so a changed PR or a moved branch is a different question (§13); a branch GitHub cannot
 * show has no head to bind, so no card opens. The delivery's prflow moves idle→ready_for_pr:
 * integration completed, the release agent is ready once the user says so.
 */
export async function createPrBehindCard(
  deps: ReleaseDeps,
  input: PrCreatePayload & { headSha?: string },
): Promise<{ confirmationId: string; prNumber?: number; prUrl?: string }> {
  const at = deps.now().toISOString()
  assertRepo(input.repo)
  assertBranch(input.branch)
  const head = await remoteHead(deps.run, input.repo, input.branch)
  if (head === undefined) throw codedError('head_unreadable', `${input.repo} ${input.branch}`)
  if (input.headSha !== undefined && input.headSha !== head)
    throw codedError('stale_head', `${input.branch} is at ${head}, not ${input.headSha}`)
  // Secrets never become durable: what is shown, hashed, stored and sent is the redacted text.
  const title = redact(input.title, [], [])
  const body = redact(input.body, [], [])
  const record = openConfirmation({
    id: freshConfirmationId(),
    cls: 'pr_create',
    operationHash: createHash('sha256')
      .update(title + body + input.branch + head)
      .digest('hex'),
    inputSha: head,
    expiresAt: expiresAt(deps.now),
  })
  const payload: Record<string, Json> = { repo: input.repo, branch: input.branch, title, body }

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
      { confirmationId: record.id, repo: input.repo, branch: input.branch, headSha: head, at },
      at,
    )
  })
  return { confirmationId: record.id }
}

/**
 * Settle the `pr_create` card (§13 CAS: first answer wins). Approve reads the branch head
 * first: a head that moved stales the card, an unreadable one leaves it pending. The card
 * then resolves — a settled approval is the only thing that may leave the machine
 * (invariant 1) — and makes exactly one `gh pr create`, the body by stdin, and the prflow
 * machine moves pr_open with the PR number and url recorded. Deny resolves and calls gh not
 * at all.
 */
export async function resolvePrCreate(
  deps: ReleaseDeps,
  input: { confirmationId: string; answer: 'approve' | 'deny' },
): Promise<{ status: string; prNumber?: number; prUrl?: string; error?: string; reason?: string }> {
  const at = deps.now().toISOString()
  const pending = cardFor(deps.store, input.confirmationId, 'pr_create')
  const payload = payloadOf<PrCreatePayload>({ payload: pending.payload }, input.confirmationId)
  let head: string | undefined
  if (needsPreflight(input.answer, pending, at)) {
    if (pending.inputSha === undefined) return { status: 'pending', reason: 'card_unbound' }
    head = await remoteHead(deps.run, payload.repo, payload.branch)
    if (head === undefined) return { status: 'pending', reason: 'head_unreadable' }
  }
  const outcome = settleCard(deps, input.confirmationId, 'pr_create', input.answer, at, head)

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
    return { status: outcome.status, ...(outcome.status === 'stale' && { reason: 'stale_head' }) }
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
        { confirmationId: input.confirmationId, stderr: evidence(created.stderr), at },
        at,
      )
    })
    return { status: 'approved', error: evidence(created.stderr) || `gh pr create exited ${created.code}` }
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

/** The PR facts the merge gate decides on, from one `gh pr view`. */
type PrFacts = {
  state: string
  title: string
  headRefName: string
  headRefOid: string
  mergeStateStatus: string
}

async function readPr(run: GhRun, repo: string, prNumber: number): Promise<PrFacts | undefined> {
  const viewed = await run([
    'pr',
    'view',
    String(prNumber),
    '-R',
    repo,
    '--json',
    'state,title,headRefName,headRefOid,mergeStateStatus',
  ])
  const facts = viewed.code === 0 ? parseJson<PrFacts>(viewed.stdout) : undefined
  return facts !== undefined && shaOf(String(facts.headRefOid)) !== undefined ? facts : undefined
}

/**
 * Open the `pr_merge` card (§13: merge always confirms; policy can never pre-authorise the
 * class). The card binds the repo, the PR number and the head GitHub reports now, so a later
 * answer can never merge a different PR, or a different commit, than the one the user saw.
 */
export async function openMergeCard(
  deps: ReleaseDeps,
  input: { repo: string; prNumber: number; originConfirmationId?: string },
): Promise<{ confirmationId: string }> {
  const at = deps.now().toISOString()
  assertRepo(input.repo)
  const pr = await readPr(deps.run, input.repo, input.prNumber)
  if (pr === undefined) throw codedError('pr_unreadable', `${input.repo}#${input.prNumber}`)
  if (pr.state !== 'OPEN') throw codedError('pr_not_open', `${input.repo}#${input.prNumber} is ${pr.state}`)
  const record = openConfirmation({
    id: freshConfirmationId(),
    cls: 'pr_merge',
    operationHash: createHash('sha256')
      .update(`pr_merge:${input.repo}:${input.prNumber}:${pr.headRefOid}`)
      .digest('hex'),
    inputSha: pr.headRefOid,
    expiresAt: expiresAt(deps.now),
  })
  const payload: Record<string, Json> = {
    repo: input.repo,
    prNumber: input.prNumber,
    title: redact(pr.title, [], []),
    branch: pr.headRefName,
    ...(input.originConfirmationId !== undefined && { originConfirmationId: input.originConfirmationId }),
  }
  deps.store.atomic(() => {
    deps.store.confirmations.save({ ...(record as unknown as StoreDoc), payload })
    appendEvent(
      deps.store,
      `release:${input.repo}:pr-${input.prNumber}`,
      'merge_card_opened',
      { confirmationId: record.id, repo: input.repo, prNumber: input.prNumber, headSha: pr.headRefOid, at },
      at,
    )
  })
  return { confirmationId: record.id }
}

type CheckRow = { name: string; state: string }

/** GitHub counts these as passing a required check; gh reports them UPPERCASE, the fakes lowercase. */
const CHECK_PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const CHECK_WAITING = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED'])

/** Why a green-checked PR may not merge yet. Unlisted states fail closed as unknown; none of these spends the card. */
const MERGE_STATE_READY = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE'])
const MERGE_STATE_HOLD: Record<string, string> = {
  BEHIND: 'behind',
  BLOCKED: 'blocked',
  DIRTY: 'dirty',
  DRAFT: 'draft',
}

/**
 * The required checks on the PR's head. A check nobody requires cannot hold a merge GitHub
 * would allow; pending and failing required ones must. Fail-closed: gh exits 8 beside rows
 * while checks are pending, but any other failed exit makes the rows unusable as green, an
 * unknown state is a failure, and no rows at all is not green.
 */
async function readRequiredChecks(
  run: GhRun,
  repo: string,
  prNumber: number,
): Promise<{ verdict: string; checks: CheckRow[] }> {
  const read = await run(['pr', 'checks', '-R', repo, '--required', '--json', 'name,state', String(prNumber)])
  const rows = parseJson<CheckRow[]>(read.stdout)
  if (!Array.isArray(rows)) {
    const none = /no required checks/i.test(read.stderr)
    return { verdict: none ? 'no_required_checks' : 'ci_unreadable', checks: [] }
  }
  const states = rows.map((row) => String(row.state).toUpperCase())
  if (states.some((state) => !CHECK_PASSED.has(state) && !CHECK_WAITING.has(state)))
    return { verdict: 'ci_failed', checks: rows }
  if (rows.length === 0 || states.some((state) => CHECK_WAITING.has(state)))
    return { verdict: 'ci_pending', checks: rows }
  return { verdict: read.code === 0 ? 'green' : 'ci_unreadable', checks: rows }
}

/**
 * §14 merge. The answer comes first: deny, or an expired card, settles on what is stored and
 * reads nothing. An approve looks at GitHub BEFORE touching the card, and a PR that cannot
 * merge yet leaves the confirmation pending (the user's answer is not spent on a merge that
 * cannot run): unreadable, not open, required checks pending or failing, behind its base or
 * otherwise held by GitHub. A head that moved stales the card (§13), and a new one is needed.
 * Otherwise the card settles, `gh pr merge --squash --match-head-commit <head>` runs, and
 * MERGED is confirmed by a separate `gh pr view` — state `MERGED` alone moves the prflow
 * machine to merged; anything else reports `merge unconfirmed by GitHub` and the delivery
 * stays where the table says (ci_green — only GitHub confirms).
 */
export async function mergeBehindCard(
  deps: ReleaseDeps,
  input: { confirmationId: string; repo: string; prNumber: number; answer: 'approve' | 'deny' },
): Promise<{ merged: boolean; reason?: string }> {
  const at = deps.now().toISOString()
  const stream = `release:${input.repo}:pr-${input.prNumber}`

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

  const settleWithout = (head?: string): { merged: false; reason: string } => {
    const outcome = settleCard(deps, input.confirmationId, 'pr_merge', input.answer, at, head)
    deps.store.atomic(() => {
      appendEvent(
        deps.store,
        stream,
        'merge_denied',
        { confirmationId: input.confirmationId, status: outcome.status, at },
        at,
      )
    })
    return { merged: false, reason: outcome.status === 'stale' ? 'stale_head' : outcome.status }
  }

  if (!needsPreflight(input.answer, pending, at)) return settleWithout()
  const boundHead = pending.inputSha
  if (boundHead === undefined) return { merged: false, reason: 'card_unbound' }

  const pr = await readPr(deps.run, input.repo, input.prNumber)
  if (pr === undefined) return { merged: false, reason: 'pr_unreadable' }
  if (pr.state !== 'OPEN') return { merged: false, reason: 'pr_not_open' }
  if (pr.headRefOid !== boundHead) return settleWithout(pr.headRefOid)

  const { verdict, checks } = await readRequiredChecks(deps.run, input.repo, input.prNumber)
  if (verdict !== 'green') {
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
    return { merged: false, reason: verdict }
  }
  if (!MERGE_STATE_READY.has(pr.mergeStateStatus))
    return { merged: false, reason: MERGE_STATE_HOLD[pr.mergeStateStatus] ?? 'merge_state_unknown' }

  settleCard(deps, input.confirmationId, 'pr_merge', input.answer, at, pr.headRefOid)
  deps.store.atomic(() => {
    const flow = findFlowByPr(deps.store, input.repo, input.prNumber)
    if (flow !== undefined) savePrFlow(deps.store, advance(flow, 'ci_passed', at))
  })

  const merged = await deps.run([
    'pr',
    'merge',
    '-R',
    input.repo,
    '--squash',
    '--match-head-commit',
    pr.headRefOid,
    String(input.prNumber),
  ])
  if (merged.code !== 0) {
    deps.store.atomic(() => {
      appendEvent(
        deps.store,
        stream,
        'merge_failed',
        { confirmationId: input.confirmationId, stderr: evidence(merged.stderr), at },
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

/** The registered repository a push goes through; resolved from the registry on every use. */
type PushTarget = { gitDir: string; repo: string }

/** `owner/name` from any remote form git reports: https, ssh, scp-like or a path. */
const slugOf = (remote: string): string | undefined =>
  /([^/:]+\/[^/:]+?)(?:\.git)?\/?$/.exec(remote.trim())?.[1]

/**
 * §13/§14: where a push may come from and go to. The git directory is the local path a
 * repository was registered with, never anything a caller sends. The GitHub repository is
 * that clone's own `origin`, so one repository's commits cannot be sent to another. The
 * default branch is refused here, on both opening and approving: an always-confirm card
 * still does not make the default branch a place MEC pushes to.
 */
async function pushTarget(deps: ReleaseDeps, repoId: string, branch: string): Promise<PushTarget> {
  assertBranch(branch)
  const doc = repoId.startsWith('repo_') ? deps.store.engines.get(repoId) : undefined
  if (doc === undefined) throw codedError('unknown_repo', `repository ${repoId} is not registered`)
  const gitDir = String(doc.url ?? '')
  if (!isAbsolute(gitDir)) throw codedError('repo_not_local', `${repoId} has no local git directory`)
  const git = deps.git ?? defaultGitExec
  const origin = await git(['-C', gitDir, 'remote', 'get-url', 'origin'])
  const repo = origin.code === 0 ? slugOf(origin.stdout) : undefined
  if (repo === undefined) throw codedError('remote_unreadable', `${repoId} has no readable origin`)
  const viewed = await deps.run(['repo', 'view', repo, '--json', 'url,defaultBranchRef'])
  const facts =
    viewed.code === 0 ? parseJson<{ defaultBranchRef?: { name?: string } }>(viewed.stdout) : undefined
  const defaultBranch = facts?.defaultBranchRef?.name
  if (defaultBranch === undefined || defaultBranch === '')
    throw codedError('remote_unreadable', `the default branch of ${repo} cannot be read`)
  if (branch === defaultBranch)
    throw codedError('default_branch', `${branch} is the default branch of ${repo}`)
  return { gitDir, repo }
}

async function localHead(deps: ReleaseDeps, gitDir: string, branch: string): Promise<string | undefined> {
  const git = deps.git ?? defaultGitExec
  const read = await git(['-C', gitDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
  return read.code === 0 ? shaOf(read.stdout) : undefined
}

/**
 * Open the `push` card (§13: `git push` always confirms). Nothing leaves the machine; the
 * record binds the repository, the branch and the exact commit the branch is on now. A
 * caller who names a head must name that one.
 */
export async function openPushCard(
  deps: ReleaseDeps,
  input: { repoId: string; branch: string; headSha?: string },
): Promise<{ confirmationId: string; headSha: string }> {
  const at = deps.now().toISOString()
  const target = await pushTarget(deps, input.repoId, input.branch)
  const head = await localHead(deps, target.gitDir, input.branch)
  if (head === undefined) throw codedError('head_unreadable', `${target.repo} ${input.branch}`)
  if (input.headSha !== undefined && input.headSha !== head)
    throw codedError('stale_head', `${input.branch} is at ${head}, not ${input.headSha}`)
  const record = openConfirmation({
    id: freshConfirmationId(),
    cls: 'push',
    operationHash: createHash('sha256')
      .update(`push:${input.repoId}:${target.repo}:${input.branch}:${head}`)
      .digest('hex'),
    inputSha: head,
    expiresAt: expiresAt(deps.now),
  })
  const payload: Record<string, Json> = { repoId: input.repoId, repo: target.repo, branch: input.branch }
  deps.store.atomic(() => {
    deps.store.confirmations.save({ ...(record as unknown as StoreDoc), payload })
    appendEvent(
      deps.store,
      `release:${target.repo}:${input.branch}`,
      'push_card_opened',
      { confirmationId: record.id, repo: target.repo, branch: input.branch, headSha: head, at },
      at,
    )
  })
  return { confirmationId: record.id, headSha: head }
}

/**
 * Settle the `push` card. Deny and expiry push nothing and read nothing. Approve re-derives
 * the target and the head: a target that cannot be read leaves the card pending, a head that
 * moved stales it. A push that fails spends the approval and leaves its evidence on the
 * release stream; a retry is a NEW card, never a replay.
 */
export async function resolvePush(
  deps: ReleaseDeps,
  input: { confirmationId: string; answer: 'approve' | 'deny' },
): Promise<{ status: string; pushed?: boolean; headSha?: string; error?: string; reason?: string }> {
  const at = deps.now().toISOString()
  const pending = cardFor(deps.store, input.confirmationId, 'push')
  const payload = payloadOf<PushPayload>({ payload: pending.payload }, input.confirmationId)
  const stream = `release:${payload.repo}:${payload.branch}`

  let head: string | undefined
  let target: PushTarget | undefined
  if (needsPreflight(input.answer, pending, at)) {
    try {
      target = await pushTarget(deps, payload.repoId, payload.branch)
    } catch (error) {
      const refusal = refusalOf(error)
      if (refusal === undefined) throw error
      return { status: 'pending', reason: refusal.error }
    }
    if (target.repo !== payload.repo) return { status: 'pending', reason: 'remote_unreadable' }
    head = await localHead(deps, target.gitDir, payload.branch)
    if (head === undefined) return { status: 'pending', reason: 'head_unreadable' }
  }
  const outcome = settleCard(deps, input.confirmationId, 'push', input.answer, at, head)

  if (outcome.status !== 'approved' || target === undefined || head === undefined) {
    deps.store.atomic(() => {
      appendEvent(
        deps.store,
        stream,
        'push_denied',
        { confirmationId: input.confirmationId, status: outcome.status, at },
        at,
      )
    })
    return { status: outcome.status, ...(outcome.status === 'stale' && { reason: 'stale_head' }) }
  }

  const pushed = await pushIntegrationBranch(
    deps.run,
    payload.repo,
    target.gitDir,
    { branch: payload.branch, headSha: head },
    deps.git,
  )
  if (!pushed.pushed) {
    const error = evidence(pushed.error)
    deps.store.atomic(() => {
      appendEvent(
        deps.store,
        stream,
        'push_failed',
        { confirmationId: input.confirmationId, stderr: error, at },
        at,
      )
    })
    return { status: 'approved', pushed: false, error }
  }
  deps.store.atomic(() => {
    appendEvent(deps.store, stream, 'pushed', { confirmationId: input.confirmationId, headSha: head, at }, at)
  })
  return { status: 'approved', pushed: true, headSha: head }
}

/** What an answer did, whichever card it was: the card's status, then the truth about the action. */
export type CardOutcome = {
  id: string
  cls: string
  status: string
  reason?: string
  error?: string
  merged?: boolean
  pushed?: boolean
  headSha?: string
  prNumber?: number
  prUrl?: string
}

/**
 * The one door from an inbox answer to the action it approves. The release functions need
 * their card's payload; a card some other author opened under a release class has none, and
 * this says so (`isReleaseCard`) rather than letting the inbox settle it without acting.
 */
export function isReleaseCard(doc: StoreDoc): boolean {
  const payload = doc.payload as Record<string, unknown> | undefined
  if (typeof payload !== 'object' || payload === null) return false
  if (doc.cls === 'push') return typeof payload.repoId === 'string' && typeof payload.branch === 'string'
  if (doc.cls === 'pr_create') return typeof payload.repo === 'string' && typeof payload.branch === 'string'
  if (doc.cls === 'pr_merge') return typeof payload.repo === 'string' && typeof payload.prNumber === 'number'
  return false
}

export async function resolveReleaseCard(
  deps: ReleaseDeps,
  id: string,
  answer: 'approve' | 'deny',
): Promise<CardOutcome> {
  const doc = deps.store.confirmations.get(id)
  const cls = String(doc?.cls)
  const statusNow = (): string => String(deps.store.confirmations.get(id)?.status)
  if (cls === 'push') {
    const { status: _, ...rest } = await resolvePush(deps, { confirmationId: id, answer })
    return { id, cls, status: statusNow(), ...rest }
  }
  if (cls === 'pr_create') {
    const { status: _, ...rest } = await resolvePrCreate(deps, { confirmationId: id, answer })
    return { id, cls, status: statusNow(), ...rest }
  }
  const payload = doc?.payload as { repo: string; prNumber: number }
  const out = await mergeBehindCard(deps, {
    confirmationId: id,
    repo: payload.repo,
    prNumber: payload.prNumber,
    answer,
  })
  return { id, cls, status: statusNow(), ...out }
}

/** A decision card's evidence in the workbench's `DecisionDetail` shape (§13 "the exact diff or command"). */
export function cardDetail(doc: StoreDoc): Record<string, Json> | undefined {
  if (!isReleaseCard(doc)) return undefined
  const payload = doc.payload as Record<string, Json>
  const head = String(doc.inputSha ?? 'not bound')
  const repo = { label: 'Repository', value: String(payload.repo) }
  const branch = { label: 'Branch', value: String(payload.branch ?? 'unknown'), mono: true }
  const headFact = { label: 'Head', value: head, mono: true }
  const card = (fields: {
    what: string
    verb: string
    why: string
    facts: Array<{ label: string; value: string; mono?: boolean }>
    approve: string
    deny: string
  }): Record<string, Json> => ({
    what: fields.what,
    verb: fields.verb,
    why: fields.why,
    facts: fields.facts,
    operation: String(doc.operationHash ?? ''),
    requestedBy: 'The release agent',
    consequences: { approve: fields.approve, deny: fields.deny },
    checks: [],
    findings: [],
    diff: { summary: 'not served for this card', files: [] },
  })
  if (doc.cls === 'push') {
    return card({
      what: `Push ${branch.value} to ${repo.value}`,
      verb: 'push',
      why: 'A push leaves this machine, so it always asks you.',
      facts: [repo, branch, headFact],
      approve:
        'MEC pushes exactly this commit to this branch. It never forces; a diverged branch is rejected.',
      deny: 'Nothing is pushed.',
    })
  }
  if (doc.cls === 'pr_create') {
    return card({
      what: `Open a pull request from ${branch.value} on ${repo.value}`,
      verb: 'open the PR',
      why: 'A pull request is visible to others, so it always asks you.',
      facts: [
        repo,
        branch,
        headFact,
        { label: 'Title', value: String(payload.title) },
        { label: 'Body', value: String(payload.body) },
      ],
      approve: 'MEC opens this pull request if the branch is still on this commit.',
      deny: 'No pull request is opened.',
    })
  }
  return card({
    what: `Squash-merge pull request #${String(payload.prNumber)} on ${repo.value}`,
    verb: 'squash-merge',
    why: 'A merge changes the target branch, so it always asks you.',
    facts: [
      repo,
      { label: 'Pull request', value: `#${String(payload.prNumber)}` },
      { label: 'Title', value: String(payload.title ?? 'unknown') },
      branch,
      headFact,
    ],
    approve:
      'MEC squash-merges this exact commit once GitHub reports its required checks passing and the PR ready. Until then the card stays open.',
    deny: 'Nothing merges.',
  })
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
