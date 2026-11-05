/**
 * The launch effect with `MEC_REAL_RUNNER=1` (spec §8, §14, §5.12, §17): from a queued attempt to
 * a started engine. The order is the spec's: load and agree, cache, pinned base, worktree, `.mec/`
 * files, bootstrap, model, bundle, token, env, start. A refusal spends nothing, and nothing before
 * the start is a spend at all. The token is minted last and lives only in the brief, the process
 * env and `.mec/mcp.json`, which is sealed before anything repo-controlled runs again.
 */
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  AttemptBrief,
  AttemptRef,
  IsolationProfile,
  Json,
  KeyFingerprint,
  Store,
  StoreDoc,
} from '@mec/contracts'
import { AttemptBrief as AttemptBriefSchema, Later, ModelRequest } from '@mec/contracts'
import { BUILTIN_ROSTER, type BuiltinRole } from '@mec/domain'
import { ClaudeAdapter } from '@mec/engines'
import {
  cachedDefaultTip,
  commitAll,
  excludeFromWorktree,
  git,
  headSha,
  historyTouches,
  RepoCache,
  Worktrees,
} from '@mec/git'
import { issueToken } from '@mec/mec-tools'
import { type LaunchAuthority, mandateOf, repoFields } from '@mec/meta'
import { loadModelsTable, PromptStore, userModelsPath } from '@mec/prompts'
import {
  type AttemptFacts,
  type AttemptPlan,
  AttemptRunner,
  buildAgentEnv,
  buildAttemptSettings,
  type CheckSpec,
  ModelResolutionError,
  ownedSpawn,
  type ResolvedModel,
  resolveModel,
  runCheck,
  Supervisor,
  serialiseAttemptSettings,
  writeAttemptGitconfig,
  writeShimDir,
} from '@mec/runtime'
import { redact } from '@mec/slots'

/** The engines this build may launch. Codex and OpenCode arrive with M2.4. */
const LAUNCHABLE_ENGINES: readonly string[] = ['claude']

/** The one slot kind whose login needs no key in the environment (§5.2, §5.12). */
const LAUNCHABLE_KINDS: readonly string[] = ['claude-sub']

/** Whether a launch of this slot could start at all: engine and kind, health aside. */
export function isLaunchableSlot(slot: StoreDoc): boolean {
  return LAUNCHABLE_ENGINES.includes(String(slot.engine)) && LAUNCHABLE_KINDS.includes(String(slot.kind))
}

/** The engine's own domains (H1's allowance) and nothing else: §14's registry field is unbuilt. */
const ENGINE_DOMAINS: readonly string[] = ['claude.ai', 'api.claude.com']

/**
 * §13's always-confirm commands, refused by the engine itself. A linked slot runs under the
 * user's own settings, whose allow rules can answer a Bash ask before `mcp__mec__confirm` hears it.
 */
const ENGINE_DENIED_TOOLS = 'Bash(git push:*),Bash(gh:*)'

/** Decision #36 (§11): until policy carries a value. */
const DEFAULT_WALL_CLOCK_MS = 30 * 60_000

/** §17's launch row: a passing failure is retried this many times, then it fails the attempt. */
const MAX_PASSING_RETRIES = 3

/** Provider or network, as git and the engine put them: 408, 429, 5xx, reset, timeout. */
const PASSING = /\b(408|429|5\d\d)\b|ECONNRESET|ETIMEDOUT|timed out|could not resolve host|connection reset/i

/** How often running attempts are checked for a stop that was asked for. */
const SWEEP_MS = 500

const STDERR_TAIL_CHARS = 2000

/** §5.12's engine hygiene; the home variable stays what the slot says. */
const claudeHygiene = (attemptId: string): Record<string, string> => ({
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  CLAUDE_CODE_MCP_ALLOWLIST_ENV: '1',
  CLAUDE_CODE_PROJECT_DIR_NAME: attemptId,
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
})

/** What keeps the launch from running, for the record. Nothing was spent. */
class LaunchRefused extends Error {}

/** A refusal or failure with its reason on the attempt, for the row's `last_error`. */
const refuse = (reason: string): LaunchRefused => new LaunchRefused(reason)

type LaunchPayload = { attemptId: string; taskId: string; workItemId: string; slotId: string }

function fieldsOf(payload: Json): LaunchPayload {
  const fields = (payload ?? {}) as Record<string, unknown>
  const text = (name: string): string => (typeof fields[name] === 'string' ? (fields[name] as string) : '')
  return {
    attemptId: text('attempt_id'),
    taskId: text('task_id'),
    workItemId: text('work_item_id'),
    slotId: text('slot_id'),
  }
}

/** The absolute engine path, found before the attempt's PATH exists: that PATH starts with shims. */
export function resolveBinary(name: string, path: string | undefined): string | undefined {
  for (const dir of (path ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir) || dir.endsWith(join('.mec', 'bin'))) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // not here
    }
  }
  return undefined
}

/** A registered path or URL as `RepoCache` takes it: https, or file. */
const cacheUrl = (urlOrPath: string): string =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(urlOrPath) ? urlOrPath : pathToFileURL(resolve(urlOrPath)).href

/** Registration refused shell syntax (§14), so a command is whitespace-separated argv. */
const argvOf = (command: string): string[] => command.trim().split(/\s+/)

type Loaded = {
  attempt: StoreDoc
  task: StoreDoc
  work: StoreDoc
  repo: StoreDoc
  slot: StoreDoc
}

export type AttemptLauncherDeps = {
  store: Store
  dataDir: string
  policyText: string
  facts: AttemptFacts
  tools: { url: string; secret: string; bumpGeneration(attemptId: string): void }
  bridge: AttemptPlan['bridge']
  /** Runs the launch gate again, because the steps before the start can take minutes. */
  gate: (payload: Json) => LaunchAuthority
  /** Records a dropped launch the gate refused at the last moment. */
  drop: (payload: Json, verdict: Extract<LaunchAuthority, { verdict: 'drop' }>) => void
}

export class AttemptLauncher {
  readonly #deps: AttemptLauncherDeps
  readonly #cache: RepoCache
  readonly #supervisor = new Supervisor()
  readonly #runner: AttemptRunner
  /** Planned launches and live redaction, keyed by attempt: tokens stay in process. */
  readonly #plans = new Map<string, AttemptPlan>()
  readonly #tokens = new Map<string, string>()
  readonly #stderr = new Map<string, (chunk: string) => void>()
  readonly #passing = new Map<string, number>()
  readonly #swept = new Map<string, number>()
  readonly #sweep: NodeJS.Timeout
  #closing = false

  constructor(deps: AttemptLauncherDeps) {
    this.#deps = deps
    this.#cache = RepoCache.open(join(deps.dataDir, 'repos'))
    this.#runner = new AttemptRunner({
      journalRoot: join(deps.dataDir, 'journal'),
      supervisor: this.#supervisor,
      facts: deps.facts,
      git: { commitAll, headSha, historyTouches },
      adapterFor: (brief) => this.#adapterFor(brief),
      planFor: (brief) => this.#planOf(brief),
    })
    this.#sweep = setInterval(() => this.#actOnStops(), SWEEP_MS)
    this.#sweep.unref()
  }

  /** Strings to redact for one attempt: its token, if it is live here. */
  exactsFor(attemptId: string): string[] {
    const token = this.#tokens.get(attemptId)
    return token === undefined ? [] : [token]
  }

  /** Every key fingerprint on record; only the salted hash exists here (§5.4). */
  fingerprints(): KeyFingerprint[] {
    return this.#deps.store.slots
      .list()
      .flatMap((slot) => (slot.fingerprint === undefined ? [] : [slot.fingerprint as KeyFingerprint]))
  }

  /** From here on no engine starts. */
  quiesce(): void {
    this.#closing = true
  }

  /** §20: every owned group is confirmed gone before the tools server stops. */
  async close(): Promise<void> {
    this.quiesce()
    clearInterval(this.#sweep)
    await this.#runner.stopAll()
  }

  /** The whole launch handler past the gate. A `Later` keeps the row; a throw fails it. */
  async launch(payload: Json): Promise<void> {
    if (this.#closing) throw new Later('the server is closing')
    const fields = fieldsOf(payload)
    try {
      await this.#launch(payload, fields)
      this.#passing.delete(fields.attemptId)
    } catch (error) {
      if (error instanceof Later) throw error
      const detail = error instanceof Error ? error.message : String(error)
      const reason = redact(detail, this.fingerprints(), this.exactsFor(fields.attemptId))
      const tries = (this.#passing.get(fields.attemptId) ?? 0) + 1
      const passing = !(error instanceof LaunchRefused) && PASSING.test(detail)
      if (passing && tries <= MAX_PASSING_RETRIES) {
        this.#passing.set(fields.attemptId, tries)
        throw new Error(`launch will retry: ${reason}`)
      }
      this.#passing.delete(fields.attemptId)
      const attempt = this.#deps.store.attempts.get(fields.attemptId)
      if (attempt !== undefined) {
        const ref = { attempt_id: fields.attemptId, generation: Number(attempt.generation ?? 1) }
        this.#deps.facts.atomic(() => this.#deps.facts.attemptFailed(ref, reason))
      }
      throw new Error(`launch failed: ${reason}`)
    }
  }

  async #launch(payload: Json, fields: LaunchPayload): Promise<void> {
    const { store, dataDir, tools, facts } = this.#deps
    const loaded = this.#load(fields)
    const { attempt, task, work, repo, slot } = loaded
    const { attemptId } = fields
    const generation = Number(attempt.generation ?? 1)
    const engine = String(slot.engine)
    if (!LAUNCHABLE_ENGINES.includes(engine)) throw refuse(`engine_not_launchable: ${engine}`)
    if (!LAUNCHABLE_KINDS.includes(String(slot.kind))) throw refuse(`slot_kind_unsupported: ${slot.kind}`)
    if (slot.state !== 'healthy') throw new Later(`slot ${fields.slotId} is ${String(slot.state)}`)
    const binary = resolveBinary(engine, process.env.PATH)
    if (binary === undefined) throw refuse(`engine_missing: ${engine} is not on PATH`)
    const roleName = String(task.role)
    const role = BUILTIN_ROSTER[roleName as BuiltinRole]
    if (role === undefined) throw refuse(`unknown_role: ${roleName}`)

    // Cache and pinned base (§14, decision #36): the first dispatch pins it for the whole work item.
    const registered = (work.pin as { url?: string } | undefined)?.url ?? String(repo.url)
    const { gitDir } = await this.#cache.ensure(cacheUrl(registered))
    const baseSha = await this.#pinBase(fields.workItemId, gitDir)

    const worktree = join(dataDir, 'work', attemptId)
    const tempDir = join(dataDir, 'tmp', attemptId)
    const branch = branchOf(store, fields, attempt)
    await new Worktrees(gitDir).add({ path: worktree, branch, baseSha, createBranch: true })
    await excludeFromWorktree(worktree, '.mec/*')
    mkdirSync(tempDir, { recursive: true })

    // `.mec/` files. No credential helper in the gitconfig: remote work is not a worker's (§13).
    const identity = await commitIdentity(registered, gitDir)
    const { binDir } = writeShimDir(worktree)
    const gitconfig = writeAttemptGitconfig(worktree, { userName: identity.name, userEmail: identity.email })
    const home = process.env.HOME ?? '/tmp'
    const isolation: IsolationProfile = {
      sandbox: 'required',
      read_only: role.readOnly,
      allow_write: [],
      deny_read: [],
      allowed_domains: [...ENGINE_DOMAINS],
      blocked_commands: [],
      background_cap_ms: DEFAULT_WALL_CLOCK_MS,
      permission_mode: 'bridge',
      repo_trusted: repo.trust === true,
    }
    const settings = buildAttemptSettings(isolation, {
      worktree,
      tempDir,
      allowedDomains: [],
      homeDir: home,
      dataDir,
      sharedClone: realpathSync(gitDir),
    })
    const settingsPath = join(worktree, '.mec', 'claude-settings.json')
    writeFileSync(settingsPath, serialiseAttemptSettings(settings))

    // The repo's commands run with a scrubbed env, no shims to trust and no token (decision #25).
    const hostEnv = buildAgentEnv({
      inherited: process.env as Record<string, string | undefined>,
      home: tempDir,
      attempt: {
        MEC_ATTEMPT_ID: attemptId,
        MEC_WORKTREE: worktree,
        TMPDIR: tempDir,
        GIT_CONFIG_GLOBAL: gitconfig,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
    const repoCommand = (name: string, command: string): CheckSpec => {
      const [cmd = '', ...args] = argvOf(command)
      return { name, cmd, args, cwd: worktree, env: hostEnv }
    }
    const bootstrap = Array.isArray(repo.bootstrap) ? repo.bootstrap.map(String) : []
    for (const [index, command] of bootstrap.entries()) {
      const outcome = await runCheck(repoCommand(`bootstrap_${index + 1}`, command))
      if (outcome.status !== 'passed') {
        throw refuse(`bootstrap_failed: ${command}: ${outcome.logTail.slice(-400)}`)
      }
    }

    const resolvedModel = this.#model(task, slot)
    const originId = originMessageOf(task, work)
    const originText = String(store.messages.get(originId)?.text ?? '')
    const environment = [
      `Worktree: ${worktree}`,
      `Branch: ${branch}`,
      `Pinned base: ${baseSha}`,
      `Temp dir: ${tempDir}`,
      `Attempt: ${attemptId}`,
      'Your shell is sandboxed: write only to the worktree and temp dir. The shared clone behind the worktree',
      'is read-only to your shell, so anything that writes to git fails there, and that is expected.',
      'Do not run git add or git commit: reading with git status, diff and log works.',
      'Leave your work in the worktree; MEC commits it when you finish and then runs the repository checks',
      'on that commit. A run that is stopped or runs out of turns gets no commit.',
    ].join('\n')
    const bundle = new PromptStore(join(dataDir, 'prompts')).assemble(roleName, engine, {
      generated: [
        { name: 'original_request', text: `The original request, verbatim:\n${originText}` },
        { name: 'task', text: `Your task:\n${String(task.objective)}` },
        { name: 'environment', text: environment },
      ],
    })

    // The start is near: nothing ran that spends, and the world may have moved meanwhile.
    if (this.#closing) throw new Later('the server is closing')
    const gate = this.#deps.gate(payload)
    if (gate.verdict === 'defer') throw new Later(gate.reason)
    if (gate.verdict === 'drop') {
      this.#deps.drop(payload, gate)
      return
    }

    // §6, §8.6: generations start at 1 and the server's count at 0, so this is per launch.
    tools.bumpGeneration(attemptId)
    const token = issueToken({ attemptId, generation, role: 'specialist', secret: tools.secret })
    this.#tokens.set(attemptId, token)
    const mcpPath = join(worktree, '.mec', 'mcp.json')
    writeFileSync(
      mcpPath,
      `${JSON.stringify({
        mcpServers: { mec: { type: 'http', url: tools.url, headers: { Authorization: `Bearer ${token}` } } },
      })}\n`,
      { mode: 0o600 },
    )
    chmodSync(mcpPath, 0o600)

    const env = buildAgentEnv({
      inherited: process.env as Record<string, string | undefined>,
      home,
      shimPath: binDir,
      slot: { ...claudeHygiene(attemptId), ...slotEnv(slot) },
      attempt: {
        MEC_ATTEMPT_ID: attemptId,
        MEC_WORKTREE: worktree,
        MEC_BASE_SHA: baseSha,
        MEC_TASK: fields.taskId,
        MEC_TOOLS_URL: tools.url,
        MEC_TOOLS_TOKEN: token,
        TMPDIR: tempDir,
        GIT_CONFIG_GLOBAL: gitconfig,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
    const budget = (task.budget ?? {}) as { turns?: number; wall_clock_ms?: number; usd?: number }
    const brief = AttemptBriefSchema.parse({
      attempt_id: attemptId,
      generation,
      task_id: fields.taskId,
      work_item_id: fields.workItemId,
      role: { name: roleName, revision: bundle.revision },
      engine,
      slot_id: fields.slotId,
      worktree,
      base_sha: baseSha,
      branch,
      origin: { messages: [{ id: originId, text: originText }] },
      objective: bundle.text,
      owned_paths: Array.isArray(task.ownedPaths) ? task.ownedPaths : [],
      acceptance_checks: Array.isArray(task.acceptanceChecks) ? task.acceptanceChecks : [],
      budget: {
        turns: budget.turns ?? role.budgetTurns,
        wall_clock_ms: budget.wall_clock_ms ?? DEFAULT_WALL_CLOCK_MS,
        ...(budget.usd !== undefined && { usd: budget.usd }),
      },
      bundle_revision: bundle.revision,
      tools: { url: tools.url, token },
      env: {
        MEC_SETTINGS_PATH: settingsPath,
        MEC_MCP_CONFIG_PATH: mcpPath,
        MEC_ALLOWED_TOOLS: 'mcp__mec__*',
        MEC_DISALLOWED_TOOLS: ENGINE_DENIED_TOOLS,
      },
      isolation,
    })

    const checks = (Array.isArray(repo.checks) ? repo.checks : []) as { name: string; cmd: string }[]
    let stderr = ''
    this.#plans.set(attemptId, {
      env,
      cwd: worktree,
      bridge: this.#deps.bridge,
      ...(resolvedModel !== undefined && {
        model: {
          id: resolvedModel.model,
          ...(resolvedModel.effort !== undefined && { effort: resolvedModel.effort }),
        },
      }),
      slotId: fields.slotId,
      checks: checks.map((check) => repoCommand(check.name, check.cmd)),
      identity,
      fingerprints: this.fingerprints(),
      exacts: [token],
      seal: () => rmSync(mcpPath, { force: true }),
      stderrTail: () => stderr,
    })
    this.#stderr.set(attemptId, (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_CHARS)
    })

    const pinned = {
      engine,
      role: roleName,
      worktree,
      temp_dir: tempDir,
      branch,
      base_sha: baseSha,
      sandbox: isolation.sandbox,
      bundle_revision: bundle.revision,
      origin_message_id: originId,
      ...(resolvedModel !== undefined && {
        resolved_model: resolvedModel.model,
        ...(resolvedModel.tier_degraded !== undefined && { tier_degraded: resolvedModel.tier_degraded }),
      }),
    }
    facts.atomic(() => {
      const fresh = store.attempts.get(attemptId) ?? attempt
      store.attempts.save({ ...fresh, ...pinned, updatedAt: new Date().toISOString() })
      store.engines.save({
        id: `prompts/${bundle.revision}`,
        revision: bundle.revision,
        text: redact(bundle.text, this.fingerprints(), [token]),
        updatedAt: new Date().toISOString(),
      })
    })

    await this.#start({ attempt_id: attemptId, generation }, brief, mcpPath)
  }

  /** The start itself; a failure seals the token file, because nothing else will. */
  async #start(attempt: AttemptRef, brief: AttemptBrief, mcpPath: string): Promise<void> {
    try {
      await this.#runner.launchAttempt(attempt, brief)
    } catch (error) {
      rmSync(mcpPath, { force: true })
      throw error
    }
  }

  #adapterFor(brief: AttemptBrief): ClaudeAdapter {
    const owner = { attemptId: brief.attempt_id, generation: brief.generation }
    const onStderr = this.#stderr.get(brief.attempt_id)
    return new ClaudeAdapter({
      binary: resolveBinary('claude', process.env.PATH),
      spawnFn: ownedSpawn(this.#supervisor, owner, { ...(onStderr !== undefined && { onStderr }) }),
    })
  }

  #planOf(brief: AttemptBrief): AttemptPlan {
    const plan = this.#plans.get(brief.attempt_id)
    if (plan === undefined) throw new Error(`no plan for ${brief.attempt_id}`)
    return plan
  }

  /** Refuses unless the row, attempt, task, work, repo and slot all name each other (§8). */
  #load(fields: LaunchPayload): Loaded {
    const { store } = this.#deps
    const attempt = store.attempts.get(fields.attemptId)
    const task = store.tasks.get(fields.taskId)
    const work = store.workItems.get(fields.workItemId)
    const slot = store.slots.get(fields.slotId)
    const repoId = typeof work?.repoId === 'string' ? work.repoId : undefined
    const repo = repoId === undefined ? undefined : store.engines.get(repoId)
    if (attempt === undefined) throw refuse('launch_mismatch: no attempt')
    if (task === undefined) throw refuse('launch_mismatch: no task')
    if (work === undefined) throw refuse('launch_mismatch: no work item')
    if (repo === undefined) throw refuse('launch_mismatch: no repository')
    if (slot === undefined) throw refuse(`launch_mismatch: no slot ${fields.slotId}`)
    if (attempt.taskId !== fields.taskId || task.workItemId !== fields.workItemId) {
      throw refuse('launch_mismatch: attempt and task disagree')
    }
    if (attempt.workItemId !== fields.workItemId || attempt.slotId !== fields.slotId) {
      throw refuse('launch_mismatch: attempt and work disagree')
    }
    if (task.repoId !== repoId || (work.pin as { repoId?: string } | undefined)?.repoId !== repoId) {
      throw refuse('launch_mismatch: task and repository disagree')
    }
    const pinned = (work.pin as { profileHash?: string }).profileHash
    const current = repoFields(store, repoId, this.#deps.policyText).pin as { profileHash?: string }
    if (pinned !== undefined && pinned !== current.profileHash) {
      throw refuse('repo_profile_changed: this work was admitted under other commands')
    }
    return { attempt, task, work, repo, slot }
  }

  /** The base, pinned once and reused by every later task of the work item. */
  async #pinBase(workItemId: string, gitDir: string): Promise<string> {
    const { store } = this.#deps
    const known = store.workItems.get(workItemId)?.base_sha
    if (typeof known === 'string') return known
    const tip = await cachedDefaultTip(gitDir)
    store.atomic(() => {
      const work = store.workItems.get(workItemId)
      if (work !== undefined) {
        store.workItems.save({ ...work, base_sha: tip, updatedAt: new Date().toISOString() })
      }
    })
    return tip
  }

  #model(task: StoreDoc, slot: StoreDoc): ResolvedModel | undefined {
    if (task.modelRequest === undefined) return undefined
    const request = ModelRequest.safeParse(task.modelRequest)
    if (!request.success) throw refuse(`model_refused: ${request.error.message}`)
    try {
      const { table } = loadModelsTable({ userPath: userModelsPath(this.#deps.dataDir) })
      const provider = typeof slot.provider === 'string' ? slot.provider : undefined
      return resolveModel(
        request.data,
        { engine: 'claude', ...(provider !== undefined && { provider }) },
        table,
      )
    } catch (error) {
      if (error instanceof ModelResolutionError) throw refuse(`model_refused: ${error.message}`)
      throw error
    }
  }

  /** `stopWork` and the planner's `stop_agent` record a request; the kill is done here (§8.1). */
  #actOnStops(): void {
    const { store } = this.#deps
    for (const ref of this.#runner.live()) {
      const { attempt_id: attemptId } = ref
      const doc = store.attempts.get(attemptId)
      const stream = `attempt:${attemptId}`
      const fresh = store.events.read(stream, this.#swept.get(attemptId) ?? 0)
      const last = fresh.at(-1)
      if (last !== undefined) this.#swept.set(attemptId, last.seq)
      const asked = fresh.some((event) => event.type === 'attempt.interrupt_requested')
      if (asked || doc?.state === 'interrupted') this.#runner.stop(ref).catch(() => {})
    }
  }
}

/** The slot layer is what the slot says: a linked slot says nothing, and runs as `claude` does. */
function slotEnv(slot: StoreDoc): Record<string, string> {
  const env = slot.env
  if (typeof env !== 'object' || env === null || Array.isArray(env)) return {}
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string')) as Record<
    string,
    string
  >
}

/** `mec/<work-item8>/<task>/a<n>` (§14); n is this attempt's place among the task's attempts. */
function branchOf(store: Store, fields: LaunchPayload, attempt: StoreDoc): string {
  const place = store.attempts
    .list({ taskId: fields.taskId })
    .map((doc) => String(doc.createdAt ?? ''))
    .filter((createdAt) => createdAt <= String(attempt.createdAt ?? '')).length
  const work8 = fields.workItemId.replace(/^wi_/, '').slice(0, 8)
  return `mec/${work8}/${fields.taskId}/a${Math.max(place, 1)}`
}

function originMessageOf(task: StoreDoc, work: StoreDoc): string {
  if (typeof task.originalRequestRef === 'string') return task.originalRequestRef
  return mandateOf(work).originMessageId
}

/** Decision #36: the registered repo's own identity, and no identity refuses the attempt. */
async function commitIdentity(registered: string, gitDir: string): Promise<{ name: string; email: string }> {
  const local = !/^[a-z][a-z0-9+.-]*:\/\//i.test(registered) && existsSync(registered)
  const cwd = local ? registered : gitDir
  const read = async (key: string): Promise<string> =>
    (await git(['config', '--get', key], { cwd, allowFailure: true })).stdout.trim()
  const [name, email] = [await read('user.name'), await read('user.email')]
  if (name === '' || email === '') throw refuse('no_commit_identity: the repository sets no user.name/email')
  return { name, email }
}
