// M2.1: the attempt runner against a real process. The fake CLI is a real binary in its own
// process group speaking stream-json; the adapter, the journal, the git operations and the check
// runner are the real ones. Only the store is a double, so ordering can be observed fact by fact.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AttemptBrief, AttemptRef, EngineEvent, IsolationProfile } from '@mec/contracts'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../../engines/src/claude/adapter'
import { git } from '../../git/src/exec'
import { historyTouches } from '../../git/src/repos'
import { commitAll, headSha } from '../../git/src/worktrees'
import { type AttemptFacts, type AttemptPlan, AttemptRunner, NotWiredError } from '../src/attempt-runner'
import type { CheckOutcome, CheckSpec } from '../src/checks'
import { ownedSpawn } from '../src/owned-spawn'
import { writeShimDir } from '../src/shims'
import { Supervisor } from '../src/supervisor'

const FAKE_CLI = fileURLToPath(new URL('../../testkit/fake-cli/claude', import.meta.url))
const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'mec-runner-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const SECRET = 'attempt-scoped-token-value-0123456789'
const ANTHROPIC_SHAPED = `sk-ant-${'a'.repeat(32)}`
const IDENT = { name: 'Mec Fixture', email: 'mec@example.com' }
const HOST_ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root }

const ISOLATION: IsolationProfile = {
  sandbox: 'required',
  read_only: false,
  allow_write: [],
  deny_read: [],
  allowed_domains: [],
  blocked_commands: [],
  background_cap_ms: 1000,
  permission_mode: 'bridge',
  repo_trusted: false,
}

/** Records every fact in order, the transaction it fell in, and the state a store would hold. */
class Facts implements AttemptFacts {
  readonly log: string[] = []
  readonly events: EngineEvent[] = []
  state = 'queued'
  head: string | undefined
  reason: string | undefined
  outcomes: CheckOutcome[] = []
  note: string | undefined
  /** Throws from the transaction, as a store on a full disk would. */
  failOn: EngineEvent['type'] | undefined
  commits = 0

  atomic<T>(fn: () => T): T {
    this.log.push('begin')
    const value = fn()
    this.commits += 1
    this.log.push('commit')
    return value
  }
  engineEvent(_attempt: AttemptRef, event: EngineEvent): void {
    if (event.type === this.failOn) throw new Error('store refused the write')
    this.events.push(event)
    this.log.push(`event:${event.type}`)
  }
  attemptStarted(): void {
    this.state = 'running'
  }
  inputsDelivered(): void {}
  inputsRead(): void {}
  turnEnded(): void {}
  reportReceived(): void {}
  permissionRequested(): void {}
  rateLimitObserved(): void {}
  usageObserved(): void {}
  attemptExited(): void {
    this.log.push('exited')
  }
  deliveryFailed(): void {}
  slotChanged(): void {}
  workCompleted(_attempt: AttemptRef, head: string): void {
    this.state = 'work_complete'
    this.head = head
  }
  checksFinished(_attempt: AttemptRef, head: string, outcomes: CheckOutcome[], passed: boolean): void {
    this.state = passed ? 'succeeded' : 'checks_failed'
    this.head = head
    this.outcomes = outcomes
  }
  checksSkipped(_attempt: AttemptRef, head: string, reason: string): void {
    this.head = head
    this.note = reason
  }
  attemptParked(_attempt: AttemptRef, state: string, reason: string): void {
    this.state = state
    this.reason = reason
  }
  attemptInterrupted(_attempt: AttemptRef, reason: string): void {
    this.state = 'interrupted'
    this.reason = reason
  }
  attemptFailed(_attempt: AttemptRef, reason: string): void {
    this.state = 'failed'
    this.reason = reason
  }
}

let counter = 0

/** One repository, one worktree, one fake binary with this script, one runner. */
async function rig(
  steps: unknown[],
  {
    checks,
    wallClockMs,
    binary: binaryOverride,
    ...over
  }: Partial<Omit<AttemptPlan, 'checks'>> & {
    checks?: (worktree: string) => CheckSpec[]
    wallClockMs?: number
    binary?: string | null
  } = {},
) {
  counter += 1
  const dir = join(root, `case-${counter}`)
  const worktree = join(dir, 'work')
  mkdirSync(join(dir, 'bin'), { recursive: true })
  await git(['init', '--quiet', '-b', 'main', worktree])
  writeFileSync(join(worktree, 'a.txt'), 'baseline\n')
  await git(['add', '--all'], { cwd: worktree })
  await git(['-c', 'user.name=x', '-c', 'user.email=x@example.com', 'commit', '--quiet', '-m', 'baseline'], {
    cwd: worktree,
  })
  // The exclude a launch writes; a plain repo keeps it in its own info/.
  writeFileSync(join(worktree, '.git', 'info', 'exclude'), '.mec/*\n')
  const base = await headSha(worktree)
  const bin = join(dir, 'bin', 'claude')
  copyFileSync(FAKE_CLI, bin)
  writeFileSync(join(dir, 'bin', 'scenario.json'), JSON.stringify({ steps }))
  mkdirSync(join(worktree, '.mec'))
  writeFileSync(join(worktree, '.mec', 'settings.json'), '{}\n')
  writeFileSync(join(worktree, '.mec', 'mcp.json'), '{"mcpServers":{}}\n')

  const attempt: AttemptRef = { attempt_id: `att_${counter}`, generation: 1 }
  const brief = {
    attempt_id: attempt.attempt_id,
    generation: 1,
    task_id: 'task_1',
    work_item_id: 'wi_1',
    role: { name: 'implementer', revision: 'r1' },
    engine: 'claude',
    slot_id: 'slot_1',
    worktree,
    base_sha: base,
    branch: 'mec/wi/task/a1',
    origin: { messages: [{ id: 'msg_1', text: 'do it' }] },
    objective: 'do it',
    owned_paths: [],
    acceptance_checks: [],
    budget: { turns: 3, wall_clock_ms: wallClockMs ?? 20_000 },
    bundle_revision: 'r1',
    tools: { url: 'http://127.0.0.1:1', token: SECRET },
    env: {
      MEC_SETTINGS_PATH: join(worktree, '.mec', 'settings.json'),
      MEC_MCP_CONFIG_PATH: join(worktree, '.mec', 'mcp.json'),
    },
    isolation: ISOLATION,
  } satisfies AttemptBrief

  const facts = new Facts()
  const supervisor = new Supervisor()
  const binary = binaryOverride === null ? undefined : (binaryOverride ?? bin)
  const journalRoot = join(dir, 'journal')
  const plan: AttemptPlan = {
    env: HOST_ENV,
    cwd: worktree,
    bridge: { request: async () => 'deny' },
    slotId: 'slot_1',
    checks: checks?.(worktree) ?? [],
    identity: IDENT,
    fingerprints: [],
    exacts: [SECRET],
    seal: () => rmSync(join(worktree, '.mec', 'mcp.json'), { force: true }),
    ...over,
  }
  const runner = new AttemptRunner({
    journalRoot,
    supervisor,
    facts,
    git: { commitAll, headSha, historyTouches },
    adapterFor: () =>
      new ClaudeAdapter({
        ...(binary !== undefined && { binary }),
        spawnFn: ownedSpawn(supervisor, { attemptId: attempt.attempt_id, generation: 1 }),
      }),
    planFor: () => plan,
  })
  const journalFile = join(journalRoot, attempt.attempt_id, 'events.jsonl')
  const journalLines = (): EngineEvent[] =>
    existsSync(journalFile)
      ? readFileSync(journalFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as EngineEvent)
      : []
  return {
    dir,
    worktree,
    attempt,
    brief,
    facts,
    supervisor,
    runner,
    journalLines,
    ackFile: join(journalRoot, attempt.attempt_id, 'ack'),
    seen: () => JSON.parse(readFileSync(join(dir, 'bin', 'seen.json'), 'utf8')) as Record<string, unknown>,
    pidOf: (name: string) => Number(readFileSync(join(dir, 'bin', name), 'utf8')),
  }
}

async function until(test: () => boolean, ms = 45_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!test()) {
    if (Date.now() > deadline) throw new Error('condition never held')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const groupGone = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

const DONE = [{ init: true }, { result: 'completed' }]
const MADE = [{ init: true }, { write: { path: 'made.txt', text: 'x\n' } }, { result: 'completed' }]
const check = (script: string) => (cwd: string) => [
  { name: 'unit', cmd: '/bin/sh', args: ['-c', script], cwd, env: HOST_ENV },
]

describe('AttemptRunner', { timeout: 60_000 }, () => {
  it('the engine binary is not the shim', async () => {
    const shimmed = await rig(DONE)
    const { binDir } = writeShimDir(shimmed.worktree)
    const env = { ...HOST_ENV, PATH: `${binDir}:${join(shimmed.dir, 'bin')}:${HOST_ENV.PATH}` }

    const direct = await rig(DONE, { env })
    await direct.runner.launchAttempt(direct.attempt, direct.brief)
    await direct.runner.settled()
    expect(direct.seen().path0).toBe(binDir)
    expect(direct.seen().self).toBe(join(direct.dir, 'bin', 'claude'))
    expect(direct.facts.state).toBe('work_complete')

    // The same PATH with a bare `claude`, which is what the adapter asked for: the shim runs.
    const bare = await rig(DONE, { env, binary: null })
    await bare.runner.launchAttempt(bare.attempt, bare.brief)
    await bare.runner.settled()
    expect(existsSync(join(bare.dir, 'bin', 'seen.json'))).toBe(false)
    expect(bare.facts.state).toBe('failed')
  })

  it('launch returns once the engine runs, and the monitor owns the rest', async () => {
    const { attempt, brief, facts, runner } = await rig([
      { init: true },
      { sleep: 400 },
      { result: 'completed' },
    ])
    await runner.launchAttempt(attempt, brief)
    expect(facts.state).toBe('queued')
    expect(runner.live()).toEqual([attempt])
    await runner.settled()
    expect(facts.state).toBe('work_complete')
    expect(runner.live()).toEqual([])
  })

  it('stop confirms the whole process group is gone', async () => {
    const { attempt, brief, facts, runner, supervisor, seen, pidOf } = await rig([
      { init: true },
      { ignoreTerm: true },
      { child: { ignoreTerm: true } },
      { forever: true },
    ])
    await runner.launchAttempt(attempt, brief)
    await until(() => facts.state === 'running')
    await until(() => {
      try {
        return pidOf('child.pid') > 0
      } catch {
        return false
      }
    })
    const leader = Number(seen().pid)
    const child = pidOf('child.pid')

    await runner.stop(attempt)

    expect(groupGone(leader)).toBe(true)
    expect(() => process.kill(child, 0)).toThrow()
    expect(supervisor.isAlive(attempt.attempt_id, 1)).toBe(false)
    expect(facts.state).toBe('interrupted')
    expect(facts.reason).toBe('stop_requested')
  })

  it('stop waits for a child that outlives its leader', async () => {
    const { attempt, brief, facts, runner, pidOf } = await rig([
      { init: true },
      { child: { ignoreTerm: true } },
      { forever: true },
    ])
    await runner.launchAttempt(attempt, brief)
    await until(() => facts.state === 'running')
    await until(() => {
      try {
        return pidOf('child.pid') > 0
      } catch {
        return false
      }
    })
    const child = pidOf('child.pid')

    await runner.stop(attempt)

    expect(() => process.kill(child, 0)).toThrow()
  })

  it('a child left behind by a finished engine goes with it', async () => {
    const { attempt, brief, runner, pidOf } = await rig([
      { init: true },
      { child: { ignoreTerm: false } },
      { result: 'completed' },
    ])
    await runner.launchAttempt(attempt, brief)
    await runner.settled()
    await until(() => {
      try {
        process.kill(pidOf('child.pid'), 0)
        return false
      } catch {
        return true
      }
    })
  })

  it('events reach the journal before exit', async () => {
    const { attempt, brief, runner, journalLines, facts } = await rig([
      { init: true },
      { sleep: 3000 },
      { result: 'completed' },
    ])
    await runner.launchAttempt(attempt, brief)
    await until(() => journalLines().length > 0)
    expect(journalLines()[0]?.type).toBe('session_started')
    expect(facts.state).toBe('running')
    expect(journalLines().some((event) => event.type === 'exit')).toBe(false)
    await runner.stop(attempt)
  })

  it('seq is the journal seq, gap free from 1, on every event', async () => {
    const { attempt, brief, runner, journalLines, ackFile } = await rig(DONE)
    await runner.launchAttempt(attempt, brief)
    await runner.settled()
    const lines = journalLines()
    expect(lines.map((event) => event.seq)).toEqual(lines.map((_, index) => index + 1))
    expect(readFileSync(ackFile, 'utf8')).toBe(String(lines.length))
    expect(lines.every((event) => event.generation === 1)).toBe(true)
  })

  it('redaction runs before the journal write', async () => {
    const say = (text: string) => ({
      emit: { type: 'assistant', message: { content: [{ type: 'text', text }] } },
    })
    const { attempt, brief, runner, journalLines, facts } = await rig([
      { init: true },
      say(`token ${SECRET} and key ${ANTHROPIC_SHAPED}`),
      { result: 'completed' },
    ])
    await runner.launchAttempt(attempt, brief)
    await runner.settled()
    const text = JSON.stringify(journalLines())
    expect(text).toContain('[redacted:')
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(ANTHROPIC_SHAPED)
    expect(JSON.stringify(facts.events)).not.toContain(SECRET)
  })

  it('ack moves only after the store commit', async () => {
    const { attempt, brief, runner, journalLines, ackFile, facts } = await rig([
      { init: true },
      { emit: { type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } } },
      { sleep: 300 },
      { result: 'completed' },
    ])
    facts.failOn = 'message'
    await runner.launchAttempt(attempt, brief)
    await runner.settled()
    // The refused event is in the journal for replay, and the cursor stayed behind it.
    const message = journalLines().find((event) => event.type === 'message')
    expect(message).toBeDefined()
    expect(Number(readFileSync(ackFile, 'utf8'))).toBe((message?.seq ?? 0) - 1)
    expect(facts.state).toBe('failed')
  })

  it('head touching .mec fails the attempt', async () => {
    const { attempt, brief, runner, facts, worktree } = await rig([
      { init: true },
      {
        sh: [
          'git add -f .mec/mcp.json',
          'git -c user.name=x -c user.email=x@example.com commit -q -m leak',
          'git rm -q -f .mec/mcp.json',
          'git -c user.name=x -c user.email=x@example.com commit -q -m hide',
        ].join(' && '),
      },
      { result: 'completed' },
    ])
    await runner.launchAttempt(attempt, brief)
    await runner.settled()
    expect(facts.state).toBe('failed')
    expect(facts.reason).toBe('mec_in_history')
    expect(await headSha(worktree)).not.toBe(brief.base_sha)
  })

  it('exit 0 with no checks stays work_complete', async () => {
    const { attempt, brief, runner, facts, worktree } = await rig([
      { init: true },
      { write: { path: 'made.txt', text: 'x\n' } },
      { result: 'completed' },
    ])
    await runner.launchAttempt(attempt, brief)
    await runner.settled()
    expect(facts.state).toBe('work_complete')
    expect(facts.note).toContain('no checks')
    // The leftover tree was committed, and the control directory stayed out of it.
    const head = await headSha(worktree)
    expect(facts.head).toBe(head)
    expect(head).not.toBe(brief.base_sha)
    expect(await historyTouches(worktree, brief.base_sha, head, '.mec')).toBe(false)
  })

  it('failed check gives checks_failed on the exact head', async () => {
    const { attempt, brief, runner, facts, worktree } = await rig(MADE, {
      checks: check('echo broken; exit 3'),
    })
    await runner.launchAttempt(attempt, brief)
    await runner.settled()
    expect(facts.state).toBe('checks_failed')
    expect(facts.head).toBe(await headSha(worktree))
    expect(facts.head).not.toBe(brief.base_sha)
    expect(facts.outcomes[0]?.status).toBe('failed')
    expect(facts.outcomes[0]?.logTail).toContain('broken')
  })

  it('passing checks on the head give succeeded, and the check sees the commit, not the token', async () => {
    const script = 'git log -1 --name-only --format= | grep made.txt && test ! -e .mec/mcp.json'
    const { attempt, brief, runner, facts, worktree } = await rig(MADE, { checks: check(script) })
    await runner.launchAttempt(attempt, brief)
    await runner.settled()
    expect(facts.state).toBe('succeeded')
    expect(facts.head).toBe(await headSha(worktree))
  })

  it('a log tail never carries the token', async () => {
    const { attempt, brief, runner, facts } = await rig(DONE, { checks: check(`echo ${SECRET}`) })
    await runner.launchAttempt(attempt, brief)
    await runner.settled()
    expect(facts.state).toBe('succeeded')
    expect(facts.outcomes[0]?.logTail).not.toContain(SECRET)
  })

  it('wall clock stop ends interrupted', async () => {
    const { attempt, brief, runner, facts } = await rig([{ init: true }, { forever: true }], {
      wallClockMs: 300,
    })
    await runner.launchAttempt(attempt, brief)
    await runner.settled()
    expect(facts.state).toBe('interrupted')
    expect(facts.reason).toBe('wall_clock')
  })

  it('a crash fails the attempt with the reason', async () => {
    const { attempt, brief, runner, facts } = await rig([{ init: true }, { exit: 3 }])
    await runner.launchAttempt(attempt, brief)
    await runner.settled()
    expect(facts.state).toBe('failed')
    expect(facts.reason).toBe('engine_crashed')
  })

  it('an engine that never opened a session fails, even on exit 0', async () => {
    const { attempt, brief, runner, facts } = await rig([])
    await runner.launchAttempt(attempt, brief)
    await runner.settled()
    expect(facts.state).toBe('failed')
    expect(facts.reason).toBe('no_session')
  })

  it('a rejected quota window parks the attempt with its workspace', async () => {
    const { attempt, brief, runner, facts, worktree } = await rig([
      { init: true },
      { write: { path: 'half.txt', text: 'x\n' } },
      {
        emit: {
          type: 'rate_limit_event',
          rate_limit_info: { unifiedWindows: { five_hour: { status: 'rejected', resetsAt: 1800000000 } } },
        },
      },
      { result: 'api_error' },
    ])
    await runner.launchAttempt(attempt, brief)
    await runner.settled()
    expect(facts.state).toBe('quota_wait')
    expect(existsSync(join(worktree, 'half.txt'))).toBe(true)
    expect(await headSha(worktree)).toBe(brief.base_sha)
  })

  it('a completed turn does not park on an earlier rejection', async () => {
    const { attempt, brief, runner, facts } = await rig([
      { init: true },
      {
        emit: {
          type: 'rate_limit_event',
          rate_limit_info: { unifiedWindows: { five_hour: { status: 'rejected', resetsAt: 1800000000 } } },
        },
      },
      { result: 'completed' },
    ])
    await runner.launchAttempt(attempt, brief)
    await runner.settled()
    expect(facts.state).toBe('work_complete')
  })

  it('deliver and replay name what is not wired', async () => {
    const { attempt, runner } = await rig([])
    await expect(runner.deliver(attempt, { id: 'inp_1', kind: 'message', text: 'x' })).rejects.toThrow(
      NotWiredError,
    )
    await expect(runner.replay(attempt)).rejects.toThrow(NotWiredError)
  })

  it('a stop for an attempt nobody runs is no error', async () => {
    const { attempt, runner } = await rig([])
    await expect(runner.stop(attempt)).resolves.toBeUndefined()
  })
})
