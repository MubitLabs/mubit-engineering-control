import { mkdir, statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  type AgentAdapter,
  type AgentExit,
  type AgentSession,
  type DecisionResult,
  FakeAdapter,
} from '@mec/agents'
import {
  type AttemptReport,
  type ControlToRunner,
  RUNNER_PROTOCOL_VERSION,
  type RunnerCommand,
  type RunnerHello,
  StartPayload,
  RunnerEventType as T,
} from '@mec/contracts'
import { runCheck, tail } from './checks'
import { type Logger, RUNNER_VERSION, type RunnerConfig } from './config'
import { ControlConnection } from './connection'
import { AttemptJournal } from './journal'
import { Supervisor } from './supervisor'
import { type PreparedWorkspace, Workspaces } from './workspace'

interface Live {
  journal: AttemptJournal
  session: AgentSession | null
  cancelRequested: boolean
  decisions: Map<string, (d: DecisionResult) => void>
}

/**
 * The runner daemon (PDF §6). It is not an LLM: it prepares workspaces, supervises agent
 * processes, journals their events before forwarding them, and executes control commands at
 * most once per commandId.
 */
export class Runner {
  readonly supervisor = new Supervisor()
  readonly connection: ControlConnection
  private readonly workspaces: Workspaces
  private readonly journals = new Map<string, AttemptJournal>()
  private readonly live = new Map<string, Live>()
  private readonly adapters = new Map<string, AgentAdapter>()
  /** Highest sequence sent on the current connection, per attempt. Reset on every (re)connect. */
  private readonly sentUpTo = new Map<string, number>()
  private heartbeat: NodeJS.Timeout | null = null
  private stopping = false

  constructor(
    readonly config: RunnerConfig,
    private readonly log: Logger,
    adapters?: AgentAdapter[],
  ) {
    const defaults = adapters ?? [
      new FakeAdapter({
        binDir: path.join(config.home, 'bin'),
        stateDir: path.join(config.home, 'agent-state'),
      }),
    ]
    for (const a of defaults) this.adapters.set(a.kind, a)
    this.workspaces = new Workspaces(config.home, {
      token: config.git?.token ?? null,
      authorName: config.git?.authorName ?? 'Mubit Engineering Control',
      authorEmail: config.git?.authorEmail ?? 'mec@mubit.ai',
      push: config.git?.push ?? false,
    })
    this.connection = new ControlConnection({
      controlUrl: config.controlUrl,
      token: config.token,
      log,
      hello: () => this.hello(),
      onMessage: (m) => void this.onMessage(m),
      onDisconnect: () => this.sentUpTo.clear(),
    })
  }

  private get journalRoot() {
    return path.join(this.config.home, 'journal')
  }

  async start(): Promise<void> {
    await mkdir(this.journalRoot, { recursive: true })
    await this.workspaces.init()
    await this.recover()
    this.connection.start()
    this.heartbeat = setInterval(() => {
      this.connection.send({ type: 'heartbeat', attempts: this.reports() })
    }, this.config.heartbeatMs)
  }

  /** Stops agents (their interruption is journalled for replay) and disconnects. */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    await Promise.all([...this.live.values()].map((l) => l.session?.interrupt()))
    // Give the attempt loops a moment to journal their interruption.
    for (let i = 0; i < 50 && [...this.live.values()].some((l) => l.session); i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    await this.supervisor.terminateAll()
    await this.connection.stop()
    for (const j of this.journals.values()) await j.close()
  }

  /**
   * After a restart nothing from the previous process is running (systemd stops the whole
   * cgroup). Attempts that were active are recorded as interrupted so control can reconcile.
   */
  private async recover(): Promise<void> {
    for (const attemptId of await AttemptJournal.list(this.journalRoot)) {
      const journal = await AttemptJournal.open(this.journalRoot, this.config.runnerId, attemptId)
      if (journal.phase === 'done' && journal.pending().length === 0) {
        await journal.close()
        continue
      }
      this.journals.set(attemptId, journal)
      if (journal.phase === 'active') {
        await journal.append(T.interrupted, { reason: 'runner_restarted' })
        await journal.update({ phase: 'parked' })
      }
    }
  }

  reports(): AttemptReport[] {
    return [...this.journals.values()].map((j) => ({
      attemptId: j.attemptId,
      generation: j.generation,
      process: this.live.get(j.attemptId)?.session ? 'live' : 'stopped',
      lastSequence: j.lastSequence,
    }))
  }

  private async hello(): Promise<RunnerHello> {
    let diskFreeMb: number | null = null
    try {
      const s = await statfs(this.config.home)
      diskFreeMb = Math.floor((s.bavail * s.bsize) / 1024 / 1024)
    } catch {
      diskFreeMb = null
    }
    return {
      type: 'hello',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      runnerVersion: RUNNER_VERSION,
      hostname: os.hostname(),
      os: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      capacity: {
        maxAttempts: this.config.maxAttempts,
        cpus: os.cpus().length,
        memoryMb: Math.floor(os.totalmem() / 1024 / 1024),
        diskFreeMb,
      },
      agents: await Promise.all([...this.adapters.values()].map((a) => a.probe())),
      attempts: this.reports(),
    }
  }

  private async onMessage(msg: ControlToRunner): Promise<void> {
    switch (msg.type) {
      case 'welcome':
        this.sentUpTo.clear()
        for (const j of this.journals.values()) {
          const acked = msg.acked[j.attemptId]
          if (acked !== undefined) await j.ack(acked)
          this.flush(j)
        }
        this.log.info('connected to control', { attempts: this.journals.size })
        return
      case 'ack': {
        const j = this.journals.get(msg.attemptId)
        await j?.ack(msg.sequence)
        if (j && j.phase === 'done' && j.pending().length === 0) {
          this.journals.delete(j.attemptId)
          await j.close()
        }
        return
      }
      case 'command':
        await this.onCommand(msg.command)
        return
      case 'error':
        this.log.warn('control reported an error', { code: msg.code, message: msg.message })
        return
    }
  }

  private result(commandId: string, status: 'accepted' | 'duplicate' | 'rejected', reason?: string) {
    this.connection.send({ type: 'command_result', commandId, status, reason })
  }

  private async onCommand(cmd: RunnerCommand): Promise<void> {
    if (!cmd.attemptId || cmd.generation === null)
      return this.result(cmd.commandId, 'rejected', 'missing attempt')
    let journal = this.journals.get(cmd.attemptId)
    if (journal?.hasCommand(cmd.commandId)) return this.result(cmd.commandId, 'duplicate')
    if (journal && cmd.generation < journal.generation) {
      return this.result(
        cmd.commandId,
        'rejected',
        `stale generation ${cmd.generation} < ${journal.generation}`,
      )
    }

    switch (cmd.type) {
      case 'start':
      case 'resume': {
        if (journal && journal.generation >= cmd.generation) return this.result(cmd.commandId, 'duplicate')
        if (this.stopping) return this.result(cmd.commandId, 'rejected', 'runner stopping')
        const resume = cmd.type === 'resume'
        if (!journal) {
          if (resume) return this.result(cmd.commandId, 'rejected', 'no local record of this attempt')
          journal = await AttemptJournal.open(this.journalRoot, this.config.runnerId, cmd.attemptId, {
            generation: cmd.generation,
            phase: 'active',
            agentKind: String(cmd.payload.agentKind ?? 'fake'),
            nativeSessionRef: null,
            workdir: null,
            start: cmd.payload,
          })
          this.journals.set(cmd.attemptId, journal)
        } else {
          if (journal.phase === 'done')
            return this.result(cmd.commandId, 'rejected', 'attempt already finished')
          await journal.update({ generation: cmd.generation, phase: 'active' })
        }
        await journal.recordCommand(cmd.commandId)
        this.result(cmd.commandId, 'accepted')
        void this.run(journal, resume).catch((err) => this.log.error('attempt crashed', { err: String(err) }))
        return
      }
      case 'interrupt':
      case 'cancel': {
        if (!journal) return this.result(cmd.commandId, 'rejected', 'unknown attempt')
        await journal.recordCommand(cmd.commandId)
        this.result(cmd.commandId, 'accepted')
        const live = this.live.get(cmd.attemptId)
        if (live?.session) {
          live.cancelRequested = cmd.type === 'cancel'
          await live.session.interrupt()
        } else if (cmd.type === 'cancel' && journal.phase !== 'done') {
          await this.emit(journal, T.cancelled, { reason: 'cancelled while parked' })
          await journal.update({ phase: 'done' })
        }
        return
      }
      case 'message': {
        if (!journal) return this.result(cmd.commandId, 'rejected', 'unknown attempt')
        await journal.recordCommand(cmd.commandId)
        const live = this.live.get(cmd.attemptId)
        if (!live?.session) return this.result(cmd.commandId, 'rejected', 'no running session')
        this.result(cmd.commandId, 'accepted')
        await live.session.send(String(cmd.payload.text ?? ''))
        await this.emit(journal, T.messageDelivered, { messageId: cmd.payload.messageId ?? null })
        return
      }
      case 'resolve_decision': {
        if (!journal) return this.result(cmd.commandId, 'rejected', 'unknown attempt')
        await journal.recordCommand(cmd.commandId)
        const ref = String(cmd.payload.nativeRequestRef ?? '')
        const resolve = this.live.get(cmd.attemptId)?.decisions.get(ref)
        if (!resolve) return this.result(cmd.commandId, 'rejected', 'no pending request with that reference')
        this.result(cmd.commandId, 'accepted')
        resolve(cmd.payload.decision as DecisionResult)
        return
      }
      case 'probe':
        return this.result(cmd.commandId, 'accepted')
    }
  }

  /** Journals first, then forwards if connected. Unsent events are replayed after the welcome. */
  private async emit(journal: AttemptJournal, type: string, payload: Record<string, unknown>): Promise<void> {
    await journal.append(type, payload)
    this.flush(journal)
  }

  /**
   * Sends the journal's unacknowledged events that this connection has not seen yet, strictly in
   * sequence order. Synchronous, so live events can never overtake a replay.
   */
  private flush(journal: AttemptJournal): void {
    if (!this.connection.ready) return
    const from = this.sentUpTo.get(journal.attemptId) ?? -1
    for (const event of journal.pending()) {
      if (event.sequence <= from) continue
      if (!this.connection.send({ type: 'event', event })) return
      this.sentUpTo.set(journal.attemptId, event.sequence)
    }
  }

  private async run(journal: AttemptJournal, resume: boolean): Promise<void> {
    const parsed = StartPayload.safeParse(journal.info.start)
    const attemptId = journal.attemptId
    const generation = journal.generation
    const live: Live = { journal, session: null, cancelRequested: false, decisions: new Map() }
    this.live.set(attemptId, live)
    const emit = (type: string, payload: Record<string, unknown>) => this.emit(journal, type, payload)
    const fail = async (reason: string, detail: string) => {
      await emit(T.failed, { reason, detail })
      await journal.update({ phase: 'done' })
    }

    try {
      if (!parsed.success) return await fail('invalid_start', 'start payload did not match the protocol')
      const start = parsed.data
      const active = [...this.live.values()].filter((l) => l !== live).length
      if (active >= this.config.maxAttempts) {
        return await fail('capacity', `runner is at its limit of ${this.config.maxAttempts}`)
      }
      await emit(T.preparing, { generation, resume })

      let ws: PreparedWorkspace
      try {
        ws = await this.workspaces.prepare(attemptId, start, journal.info.workdir)
      } catch (e) {
        return await fail('workspace_failed', (e as Error).message)
      }
      const port = journal.info.port ?? this.allocatePort()
      await journal.update({ workdir: ws.workdir, baseSha: ws.baseSha, branch: ws.branch, port })
      await emit(T.workspaceReady, {
        workdir: ws.workdir,
        branch: ws.branch,
        baseSha: ws.baseSha,
        submodules: ws.submodules,
        port,
      })
      const env = this.taskEnv(attemptId, port)

      if (!resume) {
        for (const cmd of start.bootstrap) {
          const outcome = await runCheck(this.supervisor, { attemptId, generation }, cmd, ws.workdir, env)
          await emit('workspace.bootstrap', {
            name: cmd.name,
            status: outcome.status,
            exitCode: outcome.exitCode,
            durationMs: outcome.durationMs,
            logTail: tail(outcome.log),
          })
          if (outcome.status !== 'passed') {
            return await fail('bootstrap_failed', `${cmd.name}: ${outcome.detail ?? 'failed'}`)
          }
        }
      }

      const adapter = this.adapters.get(start.agentKind)
      if (!adapter) return await fail('unsupported_agent', `no adapter for ${start.agentKind}`)

      // Events are serialised through one promise chain so journal order matches emission order.
      let chain: Promise<void> = Promise.resolve()
      const ordered = (type: string, payload: Record<string, unknown>) => {
        chain = chain.then(() => emit(type, payload)).catch(() => {})
      }
      const session = adapter.start(
        {
          attemptId,
          generation,
          workdir: ws.workdir,
          prompt: briefFor(start),
          mode: 'implement',
          options: start.inputs,
          env,
          resume:
            resume && journal.info.nativeSessionRef
              ? { nativeSessionRef: journal.info.nativeSessionRef }
              : undefined,
        },
        {
          emit: ordered,
          spawn: (spec) => this.supervisor.spawn({ attemptId, generation }, spec),
          requestDecision: () => Promise.reject(new Error('decisions arrive in M7')),
        },
      )
      live.session = session
      const { nativeSessionRef } = await session.ready
      await chain
      await journal.update({ nativeSessionRef })
      await emit(T.started, { nativeSessionRef, agentKind: adapter.kind, resumed: resume })

      const exit = await session.done
      await chain
      live.session = null
      await this.finish(journal, start, exit, live.cancelRequested)
    } finally {
      live.session = null
      this.live.delete(attemptId)
    }
  }

  private async finish(
    journal: AttemptJournal,
    start: StartPayload,
    exit: AgentExit,
    cancelled: boolean,
  ): Promise<void> {
    const emit = (type: string, payload: Record<string, unknown>) => this.emit(journal, type, payload)
    switch (exit.status) {
      case 'finished':
        return this.verify(journal, start, exit.summary ?? null)
      case 'interrupted':
        if (cancelled) {
          await emit(T.cancelled, { reason: 'cancelled by request' })
          await journal.update({ phase: 'done' })
        } else {
          await emit(T.interrupted, { reason: this.stopping ? 'runner_stopping' : 'interrupted by request' })
          await journal.update({ phase: 'parked' })
        }
        return
      case 'quota':
        await emit(T.quotaExhausted, { detail: exit.detail, resetAt: exit.resetAt ?? null })
        await journal.update({ phase: 'parked' })
        return
      case 'auth':
        await emit(T.authRequired, { detail: exit.detail })
        await journal.update({ phase: 'parked' })
        return
      case 'failed':
        await emit(T.failed, { reason: 'agent_failed', detail: exit.detail })
        await journal.update({ phase: 'done' })
        return
    }
  }

  /**
   * The agent stopping is not success (PDF §15): commit and capture the diff, run the task's
   * checks against that exact SHA, and only then report the outcome.
   */
  private async verify(journal: AttemptJournal, start: StartPayload, summary: string | null): Promise<void> {
    const emit = (type: string, payload: Record<string, unknown>) => this.emit(journal, type, payload)
    const attemptId = journal.attemptId
    const { workdir, baseSha, branch, port } = journal.info
    let headSha: string | null = null

    if (workdir && baseSha) {
      try {
        const diff = await this.workspaces.finalize(
          workdir,
          baseSha,
          `${start.taskKey}: ${start.taskTitle}\n\nAttempt ${attemptId} (generation ${journal.generation})`,
        )
        headSha = diff.headSha
        const patchArtifactId = diff.patch
          ? await this.upload(attemptId, 'patch', `${start.taskKey}.patch`, diff.patch)
          : null
        await emit(T.workspaceDiff, {
          baseSha: diff.baseSha,
          headSha: diff.headSha,
          files: diff.files.slice(0, 500),
          fileCount: diff.files.length,
          insertions: diff.insertions,
          deletions: diff.deletions,
          truncated: diff.truncated,
          patchArtifactId,
        })
      } catch (e) {
        await emit(T.failed, { reason: 'commit_failed', detail: (e as Error).message })
        await journal.update({ phase: 'done' })
        return
      }
    }
    await emit(T.finished, { summary, headSha })
    await emit(T.checksStarted, { checks: start.checks.map((c) => c.name), sha: headSha })

    const results: { name: string; status: string }[] = []
    const env = this.taskEnv(attemptId, port ?? this.allocatePort())
    for (const cmd of start.checks) {
      const outcome = await runCheck(
        this.supervisor,
        { attemptId, generation: journal.generation },
        cmd,
        workdir ?? this.config.home,
        env,
      )
      const logArtifactId = await this.upload(attemptId, 'check_log', `${cmd.name}.log`, outcome.log)
      await emit(T.checkResult, {
        name: cmd.name,
        status: outcome.status,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        detail: outcome.detail,
        sha: headSha,
        logArtifactId,
        logTail: tail(outcome.log),
      })
      results.push({ name: cmd.name, status: outcome.status })
    }
    const passed = results.every((r) => r.status === 'passed')

    if (passed && workdir && branch && this.workspaces.pushEnabled) {
      try {
        await this.workspaces.push(workdir, branch)
        await emit('workspace.pushed', { branch, sha: headSha })
      } catch (e) {
        await emit('workspace.push_failed', { branch, detail: (e as Error).message })
      }
    }
    await emit(T.checksCompleted, {
      passed,
      results,
      sha: headSha,
      note: start.checks.length === 0 ? 'no checks configured for this task' : null,
    })
    await journal.update({ phase: 'done' })
  }

  /** Environment shared by agents and checks: no credentials, a unique port, the attempt id. */
  private taskEnv(attemptId: string, port: number): Record<string, string> {
    return {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? this.config.home,
      LANG: 'C.UTF-8',
      CI: '1',
      MEC_ATTEMPT_ID: attemptId,
      MEC_PORT: String(port),
      PORT: String(port),
    }
  }

  /** Ten consecutive ports per attempt, unique among the attempts this runner holds. */
  private allocatePort(): number {
    const used = new Set(
      [...this.journals.values()].map((j) => j.info.port).filter((p) => typeof p === 'number'),
    )
    for (let p = 20_000; p < 30_000; p += 10) if (!used.has(p)) return p
    throw new Error('no free port range')
  }

  /** Uploads a log or patch to control; on failure the event keeps an inline tail instead. */
  private async upload(
    attemptId: string,
    kind: string,
    name: string,
    content: string,
  ): Promise<string | null> {
    try {
      const res = await fetch(`${this.config.controlUrl}/runner/artifacts`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.token}`,
          'content-type': 'application/octet-stream',
          'x-mec-attempt-id': attemptId,
          'x-mec-kind': kind,
          'x-mec-name': name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100),
        },
        body: content,
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return null
      return ((await res.json()) as { artifactId: string }).artifactId
    } catch {
      return null
    }
  }
}

function briefFor(start: StartPayload): string {
  const spec = start.spec as {
    objective?: string
    deliverables?: string[]
    acceptanceChecks?: string[]
  }
  return [
    `Task ${start.taskKey}: ${start.taskTitle}`,
    '',
    spec.objective ?? '',
    spec.deliverables?.length ? `\nDeliverables:\n${spec.deliverables.map((d) => `- ${d}`).join('\n')}` : '',
  ].join('\n')
}
