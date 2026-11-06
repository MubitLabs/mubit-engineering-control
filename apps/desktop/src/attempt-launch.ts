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
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  AttemptBrief,
  AttemptRef,
  EngineAdapter,
  EngineId,
  Input,
  IsolationProfile,
  Json,
  KeyFingerprint,
  Store,
  StoreDoc,
} from '@mec/contracts'
import { AttemptBrief as AttemptBriefSchema, Later, ModelRequest } from '@mec/contracts'
import { BUILTIN_ROSTER, type BuiltinRole } from '@mec/domain'
import {
  bootstrapOutput,
  cachedDefaultTip,
  commitAll,
  completeMidMerge,
  dirtyFiles,
  excludeFromWorktree,
  git,
  gitLines,
  headSha,
  historyTouches,
  isMidMerge,
  RepoCache,
  recordBootstrapOutput,
  Worktrees,
  worktreeAdminDir,
} from '@mec/git'
import { issueToken } from '@mec/mec-tools'
import { type Continuation, integrationDocId, type LaunchAuthority, mandateOf, repoFields } from '@mec/meta'
import { loadModelsTable, PromptStore, userModelsPath } from '@mec/prompts'
import {
  type AttemptFacts,
  type AttemptPlan,
  AttemptRunner,
  buildAgentEnv,
  type CheckSpec,
  ModelResolutionError,
  ownedSpawn,
  processStart,
  type ResolvedModel,
  resolveModel,
  runCheck,
  type StopReason,
  Supervisor,
  writeAttemptGitconfig,
  writeShimDir,
} from '@mec/runtime'
import { redact } from '@mec/slots'
import { bridgeOf, driftOf, ENGINE_ROWS, type EngineRow, lacksHome, type Prepared } from './engine-registry'
import { worktreeIsOurs } from './slot-switch'

export { isLaunchableSlot } from './engine-registry'

/** Decision #36 (§11): until policy carries a value. */
const DEFAULT_WALL_CLOCK_MS = 30 * 60_000

/** §17's launch row: a passing failure is retried this many times, then it fails the attempt. */
const MAX_PASSING_RETRIES = 3

/** Provider or network, as git and the engine put them: 408, 429, 5xx, reset, timeout. */
const PASSING = /\b(408|429|5\d\d)\b|ECONNRESET|ETIMEDOUT|timed out|could not resolve host|connection reset/i

/** How often running attempts are checked for a stop that was asked for. */
const SWEEP_MS = 500

const STDERR_TAIL_CHARS = 2000

/** What keeps the launch from running, for the record. Nothing was spent. */
class LaunchRefused extends Error {}

/** A refusal or failure with its reason on the attempt, for the row's `last_error`. */
const refuse = (reason: string): LaunchRefused => new LaunchRefused(reason)

type LaunchPayload = {
  attemptId: string
  taskId: string
  workItemId: string
  slotId: string
  /** A new generation of a stopped or parked attempt, with what it is told first. */
  note?: string
}

function fieldsOf(payload: Json): LaunchPayload {
  const fields = (payload ?? {}) as Record<string, unknown>
  const text = (name: string): string => (typeof fields[name] === 'string' ? (fields[name] as string) : '')
  return {
    attemptId: text('attempt_id'),
    taskId: text('task_id'),
    workItemId: text('work_item_id'),
    slotId: text('slot_id'),
    ...(fields.resume === true && { note: text('note') }),
  }
}

/** The environment a repo's command runs in: scrubbed, no shims to trust, no token (decision #25). */
function repoEnv(
  attemptId: string,
  worktree: string,
  tempDir: string,
  gitconfig: string,
): Record<string, string> {
  return buildAgentEnv({
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
export const argvOf = (command: string): string[] => command.trim().split(/\s+/)

const CONFLICT_MARKER = /^(<{7}|>{7}) /m

/**
 * What an attempt's tree becomes when it ends. A repair in a mid-merge worktree ends the merge
 * (§14), and `completeMidMerge` proves two parents, so it can never pass as an ordinary commit.
 * A file still carrying markers was not resolved, and a commit would hide that. Anything else is
 * `commitAll`, with its `.mec/` exclusion. Neither carries what the bootstrap left untouched (§14).
 */
export async function commitWork(
  path: string,
  message: string,
  identity: { name: string; email: string },
): Promise<string | null> {
  const keepOut = await bootstrapOutput(path)
  if (!(await isMidMerge(path))) return commitAll(path, message, identity, keepOut)
  const unmerged = await gitLines(['diff', '--name-only', '--diff-filter=U'], { cwd: path })
  const marked = unmerged.filter((file) => {
    const full = join(path, file)
    return existsSync(full) && CONFLICT_MARKER.test(readFileSync(full, 'utf8'))
  })
  if (marked.length > 0) throw new Error(`conflict markers remain in ${marked.join(', ')}`)
  const { mergeSha } = await completeMidMerge({
    worktree: path,
    message,
    ...identity,
    ...(keepOut !== undefined && { keepOut }),
  })
  return mergeSha
}

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
  /** A resumed attempt's engine is up. */
  resumed?: (payload: Json) => void
  /** A resume ended without an engine, and why. */
  resumeEnded?: (payload: Json, reason: string) => void
  /** §20: an attempt the sweep found stalled; its group is gone. */
  stalled?: (attemptId: string) => void
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
  readonly #prepared = new Map<string, Prepared & { binary: string; secrets: Record<string, string> }>()
  readonly #passing = new Map<string, number>()
  readonly #swept = new Map<string, number>()
  readonly #sweep: NodeJS.Timeout
  /** Checks being run again after a restart: no monitor owns them, so a stop finds them here. */
  readonly #rechecks = new Map<string, { abort: AbortController; reason?: StopReason }>()
  #closing = false

  constructor(deps: AttemptLauncherDeps) {
    this.#deps = deps
    this.#cache = RepoCache.open(join(deps.dataDir, 'repos'))
    this.#runner = new AttemptRunner({
      journalRoot: join(deps.dataDir, 'journal'),
      supervisor: this.#supervisor,
      facts: deps.facts,
      git: { commitAll: commitWork, headSha, historyTouches, adminDirOf: worktreeAdminDir },
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

  /** §12.3: resolves once the engine took it. A rejection is a failed delivery. */
  deliver(attempt: AttemptRef, input: Input): Promise<void> {
    return this.#runner.deliver(attempt, input)
  }

  /** From here on no engine starts. */
  quiesce(): void {
    this.#closing = true
    for (const entry of this.#rechecks.values()) {
      entry.reason ??= 'server_closing'
      entry.abort.abort()
    }
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
      if (fields.note !== undefined) this.#deps.resumeEnded?.(payload, reason)
      const attempt = this.#deps.store.attempts.get(fields.attemptId)
      if (attempt !== undefined) {
        const ref = { attempt_id: fields.attemptId, generation: Number(attempt.generation ?? 1) }
        this.#deps.facts.atomic(() => this.#deps.facts.attemptFailed(ref, reason))
      }
      throw new Error(`launch failed: ${reason}`)
    }
  }

  /**
   * §20: a restart's second look at a head whose checks never finished. No engine starts and no
   * token is minted. The head must still be what the attempt reported, read through a `.git` that
   * is still the one this attempt's worktree was given.
   */
  async recheck(payload: Json): Promise<void> {
    if (this.#closing) throw new Later('the server is closing')
    const { facts } = this.#deps
    const fields = fieldsOf(payload)
    const { attempt, work, repo } = this.#load(fields)
    const ref = { attempt_id: fields.attemptId, generation: Number(attempt.generation ?? 1) }
    const head = String(attempt.head_sha)
    const worktree = String(attempt.worktree)
    const ours = worktreeIsOurs(worktree, work.git_dir) && (await headSha(worktree)) === head
    if (!ours) {
      const reason = 'after a restart the worktree is not on the reported head'
      facts.atomic(() => facts.checksSkipped(ref, head, reason, 'head_moved'))
      return
    }
    const tempDir = String(attempt.temp_dir ?? join(this.#deps.dataDir, 'tmp', fields.attemptId))
    mkdirSync(tempDir, { recursive: true })
    const env = repoEnv(fields.attemptId, worktree, tempDir, join(worktree, '.mec', 'gitconfig'))
    const stored = (Array.isArray(repo.checks) ? repo.checks : []) as { name: string; cmd: string }[]
    const checks = stored.map((check): CheckSpec => {
      const [cmd = '', ...args] = argvOf(check.cmd)
      return { name: check.name, cmd, args, cwd: worktree, env }
    })
    const entry: { abort: AbortController; reason?: StopReason } = { abort: new AbortController() }
    this.#rechecks.set(fields.attemptId, entry)
    try {
      await this.#runner.recheck(
        ref,
        head,
        {
          checks,
          fingerprints: this.fingerprints(),
          exacts: [],
          onCheckStart: (pid) => this.#markProcess(fields.attemptId, 'check_process', pid),
        },
        entry.abort.signal,
        () => entry.reason,
      )
    } finally {
      this.#rechecks.delete(fields.attemptId)
    }
  }

  /** Stored as soon as the group exists: a boot signals only what this proves is ours (§8.1). */
  #markProcess(attemptId: string, field: 'process' | 'check_process', pid: number): void {
    const { store } = this.#deps
    const started = processStart(pid)
    if (started === undefined) return
    store.atomic(() => {
      const doc = store.attempts.get(attemptId)
      if (doc !== undefined) store.attempts.save({ ...doc, [field]: { pid, started } })
    })
  }

  async #launch(payload: Json, fields: LaunchPayload): Promise<void> {
    const { store, dataDir, tools, facts } = this.#deps
    const loaded = this.#load(fields)
    const { attempt, task, work, repo, slot } = loaded
    const { attemptId } = fields
    const generation = Number(attempt.generation ?? 1)
    const engine = String(slot.engine)
    const row = ENGINE_ROWS[engine]
    if (row === undefined) throw refuse(`engine_not_launchable: ${engine}`)
    if (!row.kinds.includes(String(slot.kind))) throw refuse(`slot_kind_unsupported: ${slot.kind}`)
    if (lacksHome(slot)) throw refuse(`slot_home_missing: ${fields.slotId} is not linked and has no home`)
    if (slot.state !== 'healthy') throw new Later(`slot ${fields.slotId} is ${String(slot.state)}`)
    const binary = resolveBinary(engine, process.env.PATH)
    if (binary === undefined) throw refuse(`engine_missing: ${engine} is not on PATH`)
    const home = process.env.HOME ?? '/tmp'
    const probeEnv = { PATH: process.env.PATH ?? '', HOME: home, ...slotEnv(slot, row) }
    await this.#probe(row, slot, binary, probeEnv)
    // A repair or a review is its own role on the task's own record (§15).
    const roleName = String(attempt.role ?? task.role)
    const continuation = attempt.continuation as Continuation | undefined
    const resuming = fields.note !== undefined
    const role = BUILTIN_ROSTER[roleName as BuiltinRole]
    if (role === undefined) throw refuse(`unknown_role: ${roleName}`)

    // Cache and pinned base (§14, decision #36): the first dispatch pins it for the whole work item.
    const registered = (work.pin as { url?: string } | undefined)?.url ?? String(repo.url)
    const { gitDir } = await this.#cache.ensure(cacheUrl(registered))
    const baseSha = this.#baseFor(task, await this.#pinBase(fields.workItemId, gitDir))

    // §15: a repair or a review works where the attempt before it did, on what it left.
    const stayed = (field: unknown): string | undefined =>
      resuming && typeof field === 'string' ? field : undefined
    const worktree = continuation?.worktree ?? stayed(attempt.worktree) ?? join(dataDir, 'work', attemptId)
    const tempDir = join(dataDir, 'tmp', attemptId)
    const branch = continuation?.branch ?? stayed(attempt.branch) ?? branchOf(store, fields, attempt)
    if (continuation?.worktree !== undefined && !existsSync(join(worktree, '.git'))) {
      throw refuse(`worktree_gone: ${worktree}`)
    }
    await new Worktrees(gitDir).add({ path: worktree, branch, baseSha, createBranch: true })
    await excludeFromWorktree(worktree, '.mec/*')
    mkdirSync(tempDir, { recursive: true })

    // `.mec/` files. No credential helper in the gitconfig: remote work is not a worker's (§13).
    const identity = await commitIdentity(registered, gitDir)
    const { binDir } = writeShimDir(worktree)
    const gitconfig = writeAttemptGitconfig(worktree, { userName: identity.name, userEmail: identity.email })
    const isolation: IsolationProfile = {
      sandbox: row.sandbox,
      read_only: role.readOnly,
      allow_write: [],
      deny_read: [],
      allowed_domains: [...row.domains],
      blocked_commands: [],
      background_cap_ms: DEFAULT_WALL_CLOCK_MS,
      permission_mode: 'bridge',
      repo_trusted: repo.trust === true,
    }
    const prepared = await row.prepare({
      attemptId,
      worktree,
      tempDir,
      homeDir: home,
      dataDir,
      sharedClone: realpathSync(gitDir),
      isolation,
      toolsUrl: tools.url,
      binary,
      probeEnv,
    })

    // The repo's commands run with a scrubbed env, no shims to trust and no token (decision #25).
    const hostEnv = repoEnv(attemptId, worktree, tempDir, gitconfig)
    const repoCommand = (name: string, command: string): CheckSpec => {
      const [cmd = '', ...args] = argvOf(command)
      return { name, cmd, args, cwd: worktree, env: hostEnv }
    }
    const bootstrap = Array.isArray(repo.bootstrap) ? repo.bootstrap.map(String) : []
    const beforeBootstrap = await dirtyFiles(worktree)
    for (const [index, command] of bootstrap.entries()) {
      const outcome = await runCheck(repoCommand(`bootstrap_${index + 1}`, command))
      if (outcome.status !== 'passed') {
        throw refuse(`bootstrap_failed: ${command}: ${outcome.logTail.slice(-400)}`)
      }
    }
    if (bootstrap.length > 0) await recordBootstrapOutput(worktree, beforeBootstrap)

    const resolvedModel = this.#model(task, slot, engine)
    if (resolvedModel === undefined && row.modelRequired) {
      throw refuse(`model_refused: ${engine} inherits no model, and this task names none`)
    }
    const originId = originMessageOf(task, work)
    const originText = String(store.messages.get(originId)?.text ?? '')
    const environment = [
      `Worktree: ${worktree}`,
      `Branch: ${branch}`,
      `Pinned base: ${baseSha}`,
      `Temp dir: ${tempDir}`,
      `Attempt: ${attemptId}`,
      ...row.notes,
    ].join('\n')
    // §5.10: the same slot's session continues, and it has the brief. Without one it starts over.
    const session = resuming && typeof attempt.session_id === 'string' ? attempt.session_id : undefined
    const bundle = new PromptStore(join(dataDir, 'prompts')).assemble(roleName, engine, {
      generated: [
        { name: 'original_request', text: `The original request, verbatim:\n${originText}` },
        { name: 'task', text: `Your task:\n${String(task.objective)}` },
        { name: 'environment', text: environment },
        ...(continuation === undefined ? [] : [{ name: continuation.kind, text: briefOf(continuation) }]),
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
    if (row.tokenFile) {
      writeFileSync(
        mcpPath,
        `${JSON.stringify({
          mcpServers: {
            mec: { type: 'http', url: tools.url, headers: { Authorization: `Bearer ${token}` } },
          },
        })}\n`,
        { mode: 0o600 },
      )
      chmodSync(mcpPath, 0o600)
    }

    const env = buildAgentEnv({
      inherited: process.env as Record<string, string | undefined>,
      home,
      shimPath: binDir,
      slot: { ...row.hygiene(attemptId), ...slotEnv(slot, row) },
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
        ...prepared.env,
      },
    })
    // A plan stores `wallClockMs`; a row seeded in the brief's spelling still reads.
    const budget = (task.budget ?? {}) as {
      turns?: number
      wallClockMs?: number
      wall_clock_ms?: number
      usd?: number
    }
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
      // §8.7: a recovery note is the first thing a resumed attempt reads.
      objective: !resuming
        ? bundle.text
        : session !== undefined
          ? fields.note
          : `${fields.note}\n\n${bundle.text}`,
      owned_paths: Array.isArray(task.ownedPaths) ? task.ownedPaths : [],
      acceptance_checks: Array.isArray(task.acceptanceChecks) ? task.acceptanceChecks : [],
      budget: {
        turns: budget.turns ?? role.budgetTurns,
        wall_clock_ms: budget.wallClockMs ?? budget.wall_clock_ms ?? DEFAULT_WALL_CLOCK_MS,
        ...(budget.usd !== undefined && { usd: budget.usd }),
      },
      bundle_revision: bundle.revision,
      tools: { url: tools.url, token },
      env: prepared.briefEnv ?? {},
      isolation,
    })

    const checks = (Array.isArray(repo.checks) ? repo.checks : []) as { name: string; cmd: string }[]
    const secrets = row.secretsOf?.(slot) ?? {}
    this.#prepared.set(attemptId, { ...prepared, binary, secrets })
    let stderr = ''
    this.#plans.set(attemptId, {
      env,
      cwd: worktree,
      bridge: bridgeOf(row, this.#deps.bridge, facts, facts.atomic.bind(facts)),
      ...(resolvedModel !== undefined && {
        model: {
          id: resolvedModel.model,
          ...(resolvedModel.effort !== undefined && { effort: resolvedModel.effort }),
          ...(resolvedModel.variant !== undefined && { variant: resolvedModel.variant }),
        },
      }),
      slotId: fields.slotId,
      checks: checks.map((check) => repoCommand(check.name, check.cmd)),
      identity,
      fingerprints: this.fingerprints(),
      exacts: [token, ...Object.values(secrets)],
      seal: () => rmSync(mcpPath, { force: true }),
      stderrTail: () => stderr,
      // Derived, not read back: a resumed worktree's `.git` has been in a worker's hands. Git names
      // the admin directory after the path, and a continuation's path is not this attempt's.
      gitAdmin: join(realpathSync(gitDir), 'worktrees', basename(worktree)),
      onCheckStart: (pid) => this.#markProcess(attemptId, 'check_process', pid),
      ...(session !== undefined && { resume: { session_id: session } }),
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
    if (resuming) this.#deps.resumed?.(payload)
  }

  /**
   * The start itself. A failure seals the token file, because nothing else will, and stops a
   * server that came up: an engine whose handshake failed has no monitor to stop it.
   */
  async #start(attempt: AttemptRef, brief: AttemptBrief, mcpPath: string): Promise<void> {
    try {
      await this.#runner.launchAttempt(attempt, brief)
    } catch (error) {
      rmSync(mcpPath, { force: true })
      const { attempt_id, generation } = attempt
      if (this.#supervisor.owns(attempt_id, generation)) {
        await this.#supervisor.stop(attempt_id, generation).catch(() => {})
      }
      throw error
    } finally {
      this.#prepared.delete(attempt.attempt_id)
    }
  }

  #adapterFor(brief: AttemptBrief): EngineAdapter {
    const prepared = this.#prepared.get(brief.attempt_id)
    const row = ENGINE_ROWS[brief.engine]
    if (prepared === undefined || row === undefined) throw new Error(`no launch for ${brief.attempt_id}`)
    const owner = { attemptId: brief.attempt_id, generation: brief.generation }
    const onStderr = this.#stderr.get(brief.attempt_id)
    return row.adapter({
      binary: prepared.binary,
      cwd: brief.worktree,
      prepared,
      secrets: prepared.secrets,
      onFailure: (detail) => onStderr?.(detail),
      spawn: ({ stdin }) =>
        ownedSpawn(this.#supervisor, owner, {
          stdin,
          ...(onStderr !== undefined && { onStderr }),
          onStart: (pid) => this.#markProcess(brief.attempt_id, 'process', pid),
        }),
    })
  }

  /** §26: an engine that moved under its slot, or lost its login, starts nothing and spends nothing. */
  async #probe(row: EngineRow, slot: StoreDoc, binary: string, env: Record<string, string>): Promise<void> {
    if (row.probe === undefined) return
    const probe = await row.probe(binary, env)
    const drift = driftOf(row, probe)
    const reason = drift === undefined ? undefined : 'engine_unsupported'
    if (reason !== undefined) {
      const { store } = this.#deps
      store.atomic(() => {
        const at = new Date().toISOString()
        store.slots.save({ ...slot, state: 'degraded', state_reason: reason, updatedAt: at })
      })
      throw refuse(`${reason}: ${drift}`)
    }
    if (!probe.auth.logged_in) throw refuse(`auth_required: ${probe.auth.detail ?? row.engine}`)
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

  /**
   * The base, pinned once and reused by every later task of the work item, with the default
   * branch it came from and the cache it is in: delivery reads both from here (§14).
   */
  async #pinBase(workItemId: string, gitDir: string): Promise<string> {
    const { store } = this.#deps
    const pinned = store.workItems.get(workItemId)
    if (typeof pinned?.base_sha === 'string' && typeof pinned.git_dir === 'string') return pinned.base_sha
    const tip = typeof pinned?.base_sha === 'string' ? pinned.base_sha : await cachedDefaultTip(gitDir)
    const head = await git(['symbolic-ref', '--short', 'HEAD'], { cwd: gitDir })
    store.atomic(() => {
      const work = store.workItems.get(workItemId)
      if (work !== undefined) {
        store.workItems.save({
          ...work,
          base_sha: tip,
          default_branch: head.stdout.trim(),
          git_dir: gitDir,
          updatedAt: new Date().toISOString(),
        })
      }
    })
    return tip
  }

  /** §14: an `integration` dependent starts from the integration commit, anything else from the pin. */
  #baseFor(task: StoreDoc, pinned: string): string {
    const waits = Array.isArray(task.dependsOn) && task.dependsOn.length > 0
    if (!waits || task.basePolicy === 'contract') return pinned
    const head = this.#deps.store.engines.get(integrationDocId(String(task.workItemId)))?.head
    return typeof head === 'string' ? head : pinned
  }

  #model(task: StoreDoc, slot: StoreDoc, engine: string): ResolvedModel | undefined {
    if (task.modelRequest === undefined) return undefined
    const request = ModelRequest.safeParse(task.modelRequest)
    if (!request.success) throw refuse(`model_refused: ${request.error.message}`)
    try {
      const { table } = loadModelsTable({ userPath: userModelsPath(this.#deps.dataDir) })
      const provider = typeof slot.provider === 'string' ? slot.provider : undefined
      return resolveModel(
        request.data,
        { engine: engine as EngineId, ...(provider !== undefined && { provider }) },
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
    for (const { attempt_id } of this.#runner.sweep()) this.#deps.stalled?.(attempt_id)
    for (const [attemptId, entry] of this.#rechecks) {
      const asked = store.events.read(`attempt:${attemptId}`).some((event) => {
        return event.type === 'attempt.interrupt_requested'
      })
      if (asked) {
        entry.reason ??= 'stop_requested'
        entry.abort.abort()
      }
    }
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

/** What a repair or a reviewer is told, beside the evidence (§15). */
function briefOf(continuation: Continuation): string {
  if (continuation.kind === 'repair') return `Repair this, from this evidence:\n${continuation.evidence}`
  if (continuation.kind === 'handoff') return continuation.evidence
  return [
    continuation.evidence,
    `This is review round ${continuation.round}: put round {count: ${continuation.round}} on your report.`,
    "End with a `ready` report. List each finding as an artifact {kind: 'finding', ref: what is wrong and where}.",
    'A `ready` report with no finding says this commit passed review.',
  ].join('\n')
}

/**
 * The slot layer: what the slot stores, with the home variables by the probe's rule. A linked slot
 * runs as the engine's own command does. A slot saved before its env was recorded has only its
 * home, and that is enough.
 */
function slotEnv(slot: StoreDoc, row: EngineRow): Record<string, string> {
  const env = slot.env
  const stored = typeof env !== 'object' || env === null || Array.isArray(env) ? {} : env
  const homeEnv = row.homeEnv(String(slot.home))
  const kept = Object.fromEntries(
    Object.entries(stored).filter(([name, value]) => !(name in homeEnv) && typeof value === 'string'),
  ) as Record<string, string>
  return slot.linkedDefault === true ? kept : { ...kept, ...homeEnv }
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
export async function commitIdentity(
  registered: string,
  gitDir: string,
): Promise<{ name: string; email: string }> {
  const local = !/^[a-z][a-z0-9+.-]*:\/\//i.test(registered) && existsSync(registered)
  const cwd = local ? registered : gitDir
  const read = async (key: string): Promise<string> =>
    (await git(['config', '--get', key], { cwd, allowFailure: true })).stdout.trim()
  const [name, email] = [await read('user.name'), await read('user.email')]
  if (name === '' || email === '') throw refuse('no_commit_identity: the repository sets no user.name/email')
  return { name, email }
}
