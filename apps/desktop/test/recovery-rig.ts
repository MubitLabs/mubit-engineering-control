// Shared by the M2.4 tests: a scratch repository, the fake CLI first on PATH, a store seeded the way
// a plan commit leaves it, and a real server. A crash is the state a killed server leaves on disk,
// with any orphan a real detached process, so a boot sees exactly what it would. Nothing spends.
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StoreDoc } from '@mec/contracts'
import { type MetaBrain, repoFields } from '@mec/meta'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { startServer } from '../src/composition'
import { TEST_KEY } from './approval-rig'

export const POLICY = '{"preAuthorised":{}}'
export const WORK = 'wi_abcdefghij'
const FAKE_CLI = fileURLToPath(new URL('../../../packages/testkit/fake-cli/claude', import.meta.url))
const REAL_PATH = process.env.PATH

const roots: string[] = []
const closers: (() => Promise<void>)[] = []
const pids: number[] = []

/** Closes what a test started; a process it left behind ends with it. */
export async function cleanUp(): Promise<void> {
  for (const close of closers.splice(0)) await close()
  process.env.PATH = REAL_PATH
  process.env.MEC_REAL_RUNNER = '0'
  delete process.env.MEC_FAKE_ENGINE
  for (const pid of pids.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // gone, as it should be
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

export type Rig = {
  root: string
  dataDir: string
  repo: string
  bin: string
  stdin: () => { message?: { content?: unknown } }[]
  seen: () => { argv: string[]; pid: number }
  started: () => boolean
  rescript: (steps: unknown[]) => void
}

export function scratch(steps: unknown[]): Rig {
  const root = mkdtempSync(join(tmpdir(), 'mec-recovery-'))
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
  const rescript = (next: unknown[]): void => {
    writeFileSync(join(bin, 'scenario.json'), JSON.stringify({ steps: next }))
  }
  rescript(steps)
  process.env.PATH = `${bin}:${REAL_PATH}`
  const text = (name: string): string => {
    try {
      return readFileSync(join(bin, name), 'utf8')
    } catch {
      return ''
    }
  }
  return {
    root,
    dataDir,
    repo,
    bin,
    rescript,
    stdin: () =>
      text('stdin.jsonl')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line)),
    seen: () => JSON.parse(text('seen.json')),
    started: () => text('seen.json') !== '',
  }
}

export type Seed = {
  bootstrap?: string[]
  checks?: { name: string; cmd: string }[]
  slot?: Record<string, unknown>
  task?: Record<string, unknown>
  work?: Record<string, unknown>
  attempt?: Record<string, unknown>
  /** No launch row: the state an attempt is in once its launch has run. */
  noRow?: boolean
  /** No attempt either: a task a pass has not placed yet. */
  noAttempt?: boolean
  /** A store from before the agreement, where no repository carries one. */
  preUpgrade?: boolean
}

export function seedInto(store: SqliteStore, repo: string, seed: Seed = {}): void {
  store.atomic(() => {
    store.engines.save({
      id: 'repo_a',
      url: repo,
      bootstrap: seed.bootstrap ?? [],
      checks: seed.checks ?? [],
      trust: false,
      ...(seed.preUpgrade !== true && { hostRunAgreedAt: '2026-11-05T08:00:00.000Z' }),
    })
    store.messages.save({ id: 'msg_1', text: 'please add the thing' })
    store.slots.save({
      id: 'slot_a',
      engine: 'claude',
      kind: 'claude-sub',
      home: '/nowhere',
      state: 'healthy',
      env: {},
      ...seed.slot,
    })
    store.workItems.save({
      id: WORK,
      state: 'executing',
      repoId: 'repo_a',
      pin: repoFields(store, 'repo_a', POLICY).pin as never,
      mandate: { originMessageId: 'msg_1' },
      createdAt: '2026-11-05T09:00:00.000Z',
      ...seed.work,
    })
    store.tasks.save({
      id: 'task_1',
      workItemId: WORK,
      repoId: 'repo_a',
      status: 'active',
      role: 'implementer',
      objective: 'add the thing',
      originalRequestRef: 'msg_1',
      acceptanceChecks: ['manual-review'],
      ...seed.task,
    })
    if (seed.noAttempt === true) return
    store.attempts.save({
      id: 'att_1',
      taskId: 'task_1',
      workItemId: WORK,
      slotId: 'slot_a',
      state: 'queued',
      generation: 1,
      createdAt: '2026-11-05T10:00:00.000Z',
      ...seed.attempt,
    })
    if (seed.noRow === true) return
    store.effects.enqueue('launch', 'att_1:1', {
      attempt_id: 'att_1',
      task_id: 'task_1',
      work_item_id: WORK,
      slot_id: 'slot_a',
      generation: 1,
    })
  })
}

export function seedStore(rig: Rig, seed: Seed = {}): void {
  const db = new Database(join(rig.dataDir, 'mec.db'))
  migrate(db, MIGRATIONS_v1)
  seedInto(new SqliteStore(db), rig.repo, seed)
  db.close()
}

/** The store of a server that is down, or a second connection beside a live one. */
export function peek<T>(rig: Rig, read: (store: SqliteStore, db: Database.Database) => T): T {
  const db = new Database(join(rig.dataDir, 'mec.db'))
  try {
    return read(new SqliteStore(db), db)
  } finally {
    db.close()
  }
}

/** The same, for work that outlives its first await. */
export async function peekAsync<T>(rig: Rig, read: (store: SqliteStore) => Promise<T>): Promise<T> {
  const db = new Database(join(rig.dataDir, 'mec.db'))
  try {
    return await read(new SqliteStore(db))
  } finally {
    db.close()
  }
}

export type Served = Awaited<ReturnType<typeof startServer>>

export async function serve(
  rig: Rig,
  opts: Partial<Parameters<typeof startServer>[0]> & { real?: boolean } = {},
): Promise<Served> {
  const { real = true, ...rest } = opts
  process.env.MEC_REAL_RUNNER = real ? '1' : '0'
  const server = await startServer({
    dataDir: rig.dataDir,
    policyText: POLICY,
    closeBoundMs: 6000,
    ...('approvalKey' in rest || 'openLink' in rest ? {} : { approvalKey: TEST_KEY }),
    ...rest,
  })
  closers.push(server.close)
  return server
}

export async function until(test: () => boolean, ms = 30_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`${what} never held`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

export const settle = (ms = 2500): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const attemptOf = (rig: Rig, id = 'att_1'): StoreDoc | undefined =>
  peek(rig, (store) => store.attempts.get(id))

/** Fails naming where the attempt was, and what its launch row said. */
export async function reaches(rig: Rig, state: string, id = 'att_1'): Promise<void> {
  try {
    await until(() => attemptOf(rig, id)?.state === state, 20_000, `${id} reaching ${state}`)
  } catch (error) {
    const doc = attemptOf(rig, id)
    const rows = peek(rig, (_store, db) => db.prepare("SELECT * FROM effects WHERE kind = 'launch'").all())
    const seen = { state: doc?.state, reason: doc?.terminal_reason, rows }
    throw new Error(`${String(error)}; last seen ${JSON.stringify(seen)}`)
  }
}

export const eventsOf = (rig: Rig, stream: string): string[] =>
  peek(rig, (store) => store.events.read(stream).map((event) => event.type))

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A detached process with its own group, as an engine is, that this test owns. */
export function orphan(script = 'setInterval(()=>{},1000)'): number {
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' })
  child.unref()
  pids.push(child.pid as number)
  return child.pid as number
}

/** The probe answer for a slot that stays as it is: a logged-out reading changes nothing here. */
export const PROBE_OK = async (): Promise<{ code: number; stdout: string; stderr: string }> => ({
  code: 0,
  stdout: '{"loggedIn":true}',
  stderr: '',
})
export const PROBE_DOWN = async (): Promise<{ code: number; stdout: string; stderr: string }> => ({
  code: 1,
  stdout: '{"loggedIn":false}',
  stderr: '',
})

export const brainThatNeverRuns: MetaBrain = () => {
  throw new Error('no planner turn belongs in this test')
}
