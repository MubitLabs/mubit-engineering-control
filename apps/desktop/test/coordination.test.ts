// M2.2 end to end: a real store, the real server and queue, and real processes through the fake
// CLI. The planner is scripted, so nothing here spends. What a message does after the first one
// is the point: nobody sends a second.
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StoreDoc } from '@mec/contracts'
import { type MetaBrain, type MetaDecision, type MetaPlanTask, repoFields } from '@mec/meta'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer } from '../src/composition'

const FAKE_CLI = fileURLToPath(new URL('../../../packages/testkit/fake-cli/claude', import.meta.url))
const POLICY = '{"preAuthorised":{}}'
const REAL_PATH = process.env.PATH
const REPO = 'repo_a'

const roots: string[] = []
const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  process.env.PATH = REAL_PATH
  delete process.env.MEC_REAL_RUNNER
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

type Scenario = { steps: unknown[]; followUp?: unknown[] }

function scratch(scenario: Scenario, slot: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mec-coord-'))
  roots.push(root)
  const dataDir = join(root, 'state')
  mkdirSync(dataDir)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  gitIn(repo, 'init', '--quiet', '-b', 'main')
  gitIn(repo, 'config', 'user.name', 'Repo Owner')
  gitIn(repo, 'config', 'user.email', 'owner@example.com')
  gitIn(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  gitIn(repo, 'add', '--all')
  gitIn(repo, 'commit', '--quiet', '-m', 'baseline')

  const bin = join(root, 'bin')
  mkdirSync(bin)
  copyFileSync(FAKE_CLI, join(bin, 'claude'))
  writeFileSync(join(bin, 'scenario.json'), JSON.stringify(scenario))
  process.env.PATH = `${bin}:${REAL_PATH}`
  process.env.MEC_REAL_RUNNER = '1'

  const db = new Database(join(dataDir, 'mec.db'))
  migrate(db, MIGRATIONS_v1)
  const store = new SqliteStore(db)
  store.atomic(() => {
    store.engines.save({
      id: REPO,
      url: repo,
      bootstrap: [],
      checks: [{ name: 'made', cmd: 'test -f made.txt' }],
      trust: false,
    })
    store.slots.save({
      id: 'slot_linked',
      engine: 'claude',
      kind: 'claude-sub',
      home: '/nowhere',
      state: 'healthy',
      env: {},
      concurrency: 2,
      ...slot,
    })
  })
  db.close()
  return { root, dataDir, repo, bin }
}

type Rig = ReturnType<typeof scratch> & {
  url: string
  post: (path: string, body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>
  read: <T>(fn: (store: SqliteStore) => T) => T
  stdin: () => { message: { content: string | { type: string; text: string }[] } }[]
}

async function serve(context: ReturnType<typeof scratch>, brain: MetaBrain): Promise<Rig> {
  const server = await startServer({
    dataDir: context.dataDir,
    policyText: POLICY,
    closeBoundMs: 4000,
    brain,
  })
  closers.push(server.close)
  return {
    ...context,
    url: server.url,
    post: async (path, body) => {
      const response = await fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: (await response.json()) as Record<string, unknown> }
    },
    read: (fn) => {
      const db = new Database(join(context.dataDir, 'mec.db'))
      try {
        return fn(new SqliteStore(db))
      } finally {
        db.close()
      }
    },
    stdin: () => {
      const path = join(context.bin, 'stdin.jsonl')
      if (!existsSync(path)) return []
      return readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    },
  }
}

async function until(test: () => boolean, ms = 40_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!test()) {
    if (Date.now() > deadline) throw new Error('condition never held')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const task = (taskId: string, dependsOn: string[] = []): MetaPlanTask => ({
  taskId,
  objective: `do ${taskId}`,
  dependsOn,
  role: 'implementer',
  basePolicy: 'contract',
})

const planOf = (...tasks: MetaPlanTask[]): MetaBrain => {
  const once: MetaDecision = { ack: 'On it', plan: { tasks } }
  let turns = 0
  return async () => {
    turns += 1
    return turns === 1 ? once : { ack: 'ok' }
  }
}

const WORK = [{ init: true }, { write: { path: 'made.txt', text: 'made\n' } }, { result: 'completed' }]

const attemptIn = (r: Rig, id = 'att_1'): StoreDoc | undefined => r.read((store) => store.attempts.get(id))

const stageOf = (r: Rig, messageId: string): string | undefined =>
  r.read((store) => (store.messages.get(messageId)?.receipt as { stage: string } | undefined)?.stage)

describe('continuing coordination (§11, §12)', () => {
  it('two-task contract chain finishes with no user message', async () => {
    const r = await serve(scratch({ steps: WORK }), planOf(task('first'), task('second', ['first'])))
    const sent = await r.post('/api/chat/messages', { text: 'do both', repoId: REPO })
    expect(sent.status).toBeLessThan(300)

    const statuses = (): string[] => r.read((store) => store.tasks.list().map((doc) => String(doc.status)))
    await until(() => statuses().filter((status) => status === 'accepted').length === 2)

    const facts = r.read((store) => {
      const attempts = store.attempts.list()
      const first = store.tasks.list({ localKey: 'first' })[0] as StoreDoc
      const second = store.tasks.list({ localKey: 'second' })[0] as StoreDoc
      return { attempts, first, second, messages: store.messages.list().length }
    })
    expect(facts.attempts.map((doc) => doc.state)).toEqual(['succeeded', 'succeeded'])
    expect(facts.second.dependsOn).toEqual([facts.first.id])
    expect(facts.messages).toBe(1)
    // Contract dependents start from the pinned base: the second worktree has no first-task file.
    expect(facts.attempts[1]?.base_sha).toBe(facts.attempts[0]?.base_sha)
    expect(String(facts.attempts[0]?.placement)).toContain('slot_linked')
  }, 60_000)

  it('a dependent stays out until its prerequisite is accepted, on one slot unit', async () => {
    const steps = [{ init: true }, { sleep: 500 }, ...WORK.slice(1)]
    const r = await serve(
      scratch({ steps }, { concurrency: 1 }),
      planOf(task('first'), task('second', ['first'])),
    )
    await r.post('/api/chat/messages', { text: 'do both', repoId: REPO })
    await until(() => attemptIn(r)?.state === 'running')

    expect(attemptIn(r, 'att_2')).toBeUndefined()
    const second = r.read((store) => store.tasks.list({ localKey: 'second' })[0])
    expect(second?.deferred).toMatchObject({ reason: 'dependency', releases: 'first is accepted' })
    await until(() => attemptIn(r, 'att_2')?.state === 'succeeded')
  }, 60_000)

  it('a failed prerequisite blocks the dependent, and /api/work says why', async () => {
    const steps = [{ init: true }, { exit: 3 }]
    const r = await serve(scratch({ steps }), planOf(task('first'), task('second', ['first'])))
    await r.post('/api/chat/messages', { text: 'do both', repoId: REPO })

    const blocked = () => r.read((store) => store.tasks.list({ localKey: 'second' })[0]?.status)
    await until(() => blocked() === 'blocked')
    expect(r.read((store) => store.attempts.list()).length).toBe(1)
    const reason = r.read((store) => store.tasks.list({ localKey: 'second' })[0]?.blockedReason)
    expect(String(reason)).toContain('prerequisite first cannot finish')

    const work = (await (await fetch(`${r.url}/api/work`)).json()) as { blockedReason?: string }[]
    expect(work[0]?.blockedReason).toBe('engine_crashed')
  }, 60_000)

  it('two work items on one unit: the second defers with its reason and launches when it frees', async () => {
    const steps = [{ init: true }, { sleep: 1500 }, ...WORK.slice(1)]
    let turns = 0
    const brain: MetaBrain = async () => {
      turns += 1
      return { ack: 'On it', plan: { tasks: [task(`job${turns}`)] } }
    }
    const r = await serve(scratch({ steps }, { concurrency: 1 }), brain)
    await r.post('/api/chat/messages', { text: 'one', repoId: REPO })
    await r.post('/api/chat/messages', { text: 'two', repoId: REPO, intent: 'new' })

    const second = r.read((store) => store.tasks.list({ localKey: 'job2' })[0])
    expect(second?.deferred).toMatchObject({ reason: 'capacity', releases: 'a slot unit comes free' })
    expect(attemptIn(r, 'att_2')).toBeUndefined()

    await until(() => attemptIn(r, 'att_2')?.state === 'succeeded')
    expect(r.read((store) => store.tasks.list({ localKey: 'job2' })[0]?.deferred)).toBeUndefined()
  }, 60_000)

  it('owned follow-up reaches stdin unchanged, and the receipt stops at delivered until a turn end', async () => {
    const steps = [{ init: true }, { sleep: 5000 }, ...WORK.slice(1)]
    const r = await serve(scratch({ steps }), planOf(task('first')))
    const { body } = await r.post('/api/chat/messages', { text: 'go', repoId: REPO })
    await until(() => attemptIn(r)?.state === 'running')

    const text = 'Also  keep "this"\nexact'
    const follow = await r.post('/api/chat/messages', {
      text,
      repoId: REPO,
      referencesWorkItem: body.workItemId,
      intent: 'follow_up',
    })
    const messageId = String(follow.body.messageId)

    await until(() => stageOf(r, messageId) === 'delivered')
    expect(r.stdin()[1]?.message.content[0]).toEqual({ type: 'text', text })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(stageOf(r, messageId)).toBe('delivered')

    await until(() => stageOf(r, messageId) !== 'delivered')
    await until(() => attemptIn(r)?.state === 'succeeded')
    expect(stageOf(r, messageId)).toBe('read')
  }, 60_000)

  // The fake reads `$INPUT_ID` and `$MESSAGE_ID` from the follow-up's own stdin line, as an engine
  // has to: nothing else tells it either.
  const followUpRun = async (followUp: unknown[]) => {
    const steps = [{ init: true }, { waitInput: 2 }, ...WORK.slice(1)]
    const wakes: string[] = []
    const plan = planOf(task('first'))
    const brain: MetaBrain = async (context) => {
      if (context.wake?.reason !== 'user message') wakes.push(String(context.wake?.reason))
      return plan(context)
    }
    const r = await serve(scratch({ steps, followUp }), brain)
    const { body } = await r.post('/api/chat/messages', { text: 'go', repoId: REPO })
    await until(() => attemptIn(r)?.state === 'running')
    const follow = await r.post('/api/chat/messages', {
      text: 'also write heron.txt',
      repoId: REPO,
      referencesWorkItem: body.workItemId,
      intent: 'follow_up',
    })
    return { r, wakes, messageId: String(follow.body.messageId) }
  }

  it('a follow-up the specialist acted on reaches settled, and the planner never plans it', async () => {
    const { r, wakes, messageId } = await followUpRun([
      { write: { path: 'heron.txt', text: 'heron\n' } },
      {
        call: {
          tool: 'report',
          args: { kind: 'progress', summary: 'wrote heron.txt', handled_inputs: ['$INPUT_ID'] },
        },
      },
      { result: 'completed' },
    ])

    await until(() => attemptIn(r)?.state === 'succeeded')
    await until(() => stageOf(r, messageId) === 'settled')
    await new Promise((resolve) => setTimeout(resolve, 2200))

    const message = r.read((store) => store.messages.get(messageId))
    expect(message).toMatchObject({ owned: false, receipt: { stage: 'settled' } })
    expect(message?.released).toBeUndefined()
    expect(wakes).toEqual([])
  }, 60_000)

  it('a follow-up the specialist cannot own is handed back by the id on its stdin line', async () => {
    const { r, wakes, messageId } = await followUpRun([
      { call: { tool: 'handback', args: { message_id: '$MESSAGE_ID', reason: 'beyond this task' } } },
      { result: 'completed' },
    ])

    await until(() => wakes.includes('follow-up handed back'))
    await until(() => attemptIn(r)?.state === 'succeeded')
    await until(() => stageOf(r, messageId) === 'settled')
    const message = r.read((store) => store.messages.get(messageId))
    expect(message).toMatchObject({ handback: { reason: 'beyond this task', attemptId: 'att_1' } })
    expect(message?.released).toBeUndefined()
    expect(wakes).not.toContain('message released')
  }, 60_000)

  it('reserved wake delivers before a queued launch', async () => {
    const steps = [{ init: true }, { sleep: 3000 }, ...WORK.slice(1)]
    let turns = 0
    const brain: MetaBrain = async () => {
      turns += 1
      return { ack: 'On it', plan: { tasks: [task(`job${turns}`)] } }
    }
    const r = await serve(scratch({ steps }), brain)
    const { body } = await r.post('/api/chat/messages', { text: 'one', repoId: REPO })
    await until(() => attemptIn(r)?.state === 'running')

    const follow = await r.post('/api/chat/messages', {
      text: 'and this',
      repoId: REPO,
      referencesWorkItem: body.workItemId,
      intent: 'follow_up',
    })
    await r.post('/api/chat/messages', { text: 'two', repoId: REPO, intent: 'new' })

    await until(() => attemptIn(r, 'att_2') !== undefined)
    const stage = stageOf(r, String(follow.body.messageId))
    expect(stage === 'delivered' || stage === 'read').toBe(true)
    const when = r.read((store) => ({
      delivered: store.events.read('attempt:att_1').find((event) => event.type === 'attempt.inputs_delivered')
        ?.at,
      queued: store.events.read('attempt:att_2').find((event) => event.type === 'attempt_queued')?.at,
    }))
    expect(String(when.delivered) <= String(when.queued)).toBe(true)
  }, 60_000)

  it('specialist question reaches the card unchanged and the answer returns to it', async () => {
    const question = 'Keep  the "audit" table?'
    const steps = [
      { init: true },
      { call: { tool: 'ask_user', args: { question, options: ['yes', 'no'] } } },
      { sleep: 5000 },
      ...WORK.slice(1),
    ]
    const r = await serve(scratch({ steps }), planOf(task('first')))
    await r.post('/api/chat/messages', { text: 'go', repoId: REPO })

    type Card = { id: string; question: string; status: string; options: string[] }
    const cards = async (): Promise<Card[]> =>
      (await (await fetch(`${r.url}/api/questions`)).json()) as Card[]
    await until(
      () => r.read((store) => store.engines.list({ attemptId: 'att_1', status: 'open' }).length) > 0,
    )

    const [card] = await cards()
    expect(card).toMatchObject({ question, options: ['yes', 'no'], status: 'open' })

    await r.post(`/api/questions/${card?.id}/answer`, { answer: 'yes, keep it' })
    await until(() => r.stdin().length > 1)
    expect(r.stdin()[1]?.message.content).toContain('yes, keep it')
  }, 60_000)

  it('a confirm-by-default ask waits on a card; the answer is the owner’s, and the toast is true', async () => {
    const ask = { tool_name: 'Bash', input: { command: 'pnpm add left-pad' } }
    const steps = [{ init: true }, { call: { tool: 'confirm', args: ask } }, ...WORK.slice(1)]
    const r = await serve(scratch({ steps }), planOf(task('first')))
    await r.post('/api/chat/messages', { text: 'go', repoId: REPO })

    const pending = () => r.read((store) => store.confirmations.list({ status: 'pending' }))
    await until(() => pending().length === 1)
    const [card] = pending()
    expect(card).toMatchObject({ cls: 'install', attemptId: 'att_1', requestedBy: 'specialist' })
    expect(existsSync(join(r.bin, 'tool-answers.jsonl'))).toBe(false)

    const detail = await (await fetch(`${r.url}/api/inbox/${String(card?.id)}/detail`)).json()
    expect(detail).toMatchObject({ requestedBy: 'The specialist' })

    const approved = await r.post(`/api/inbox/${String(card?.id)}/resolve`, { answer: 'approve' })
    expect(approved.body).toMatchObject({ status: 'approved', continues: true })

    await until(() => existsSync(join(r.bin, 'tool-answers.jsonl')))
    expect(readFileSync(join(r.bin, 'tool-answers.jsonl'), 'utf8')).toContain('allow')
    await until(() => attemptIn(r)?.state === 'succeeded')
  }, 60_000)

  it('an always-confirm ask opens no card and is denied at once', async () => {
    const ask = { tool_name: 'Bash', input: { command: 'git push origin main' } }
    const steps = [{ init: true }, { call: { tool: 'confirm', args: ask } }, ...WORK.slice(1)]
    const r = await serve(scratch({ steps }), planOf(task('first')))
    await r.post('/api/chat/messages', { text: 'go', repoId: REPO })

    await until(() => existsSync(join(r.bin, 'tool-answers.jsonl')))
    expect(readFileSync(join(r.bin, 'tool-answers.jsonl'), 'utf8')).toContain('deny')
    expect(r.read((store) => store.confirmations.list())).toHaveLength(0)
  }, 60_000)

  it('a report wakes the planner in the queue, once, and a progress report does not', async () => {
    const steps = [
      { init: true },
      { call: { tool: 'report', args: { kind: 'progress', summary: 'halfway' } } },
      { call: { tool: 'report', args: { kind: 'ready', summary: 'done' } } },
      ...WORK.slice(1),
    ]
    const wakes: string[] = []
    const plan = planOf(task('first'))
    const brain: MetaBrain = async (context) => {
      if (context.wake?.reason !== 'user message') wakes.push(String(context.wake?.reason))
      return plan(context)
    }
    const r = await serve(scratch({ steps }), brain)
    await r.post('/api/chat/messages', { text: 'go', repoId: REPO })

    await until(() => attemptIn(r)?.state === 'succeeded')
    await until(() => wakes.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 2200))
    expect(wakes).toEqual(['report ready'])
    const notes = r.read((store) => store.engines.list().filter((doc) => String(doc.id).startsWith('note/')))
    expect(notes.map((doc) => doc.text)).toEqual(['att_1 progress: halfway'])
  }, 60_000)

  it('the timer’s pass places work a slot change freed, with no command to say so', async () => {
    const r = await serve(scratch({ steps: WORK }, { state: 'degraded' }), planOf(task('first')))
    await r.post('/api/chat/messages', { text: 'go', repoId: REPO })
    const waiting = r.read((store) => store.tasks.list({ localKey: 'first' })[0])
    expect(waiting?.deferred).toMatchObject({ reason: 'slot_unhealthy' })

    r.read((store) => {
      store.slots.save({ ...(store.slots.get('slot_linked') as StoreDoc), state: 'healthy' })
    })
    await until(() => attemptIn(r)?.state === 'succeeded')
  }, 60_000)

  it('a pause runs no scheduler pass, and resume does', async () => {
    const r0 = scratch({ steps: WORK })
    const db = new Database(join(r0.dataDir, 'mec.db'))
    const store = new SqliteStore(db)
    store.atomic(() => {
      store.engines.save({ id: 'settings/processing', paused: true, pausedAt: new Date().toISOString() })
      store.workItems.save({
        id: 'wi_1',
        state: 'executing',
        repoId: REPO,
        mandate: { originMessageId: 'msg_0', status: 'active' },
        ...repoFields(store, REPO, POLICY),
      })
      store.tasks.save({
        id: 'task_1',
        workItemId: 'wi_1',
        repoId: REPO,
        status: 'ready',
        role: 'implementer',
        objective: 'o',
        dependsOn: [],
      })
    })
    db.close()
    const server = await startServer({
      dataDir: r0.dataDir,
      policyText: POLICY,
      closeBoundMs: 4000,
      brain: planOf(),
    })
    closers.push(server.close)
    await new Promise((resolve) => setTimeout(resolve, 2300))
    const peek = () => {
      const reader = new Database(join(r0.dataDir, 'mec.db'))
      const count = new SqliteStore(reader).attempts.list().length
      reader.close()
      return count
    }
    expect(peek()).toBe(0)
    server.resume()
    await until(() => peek() === 1)
  }, 60_000)
})
