// M2.4, §17, §20: a card approved with no recorded outcome. The world is read and written down, and
// nothing is sent again from the approval alone. The fakes refuse every sending command.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoreDoc } from '@mec/contracts'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { reconcileExternal } from '../src/recovery'

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function open(): SqliteStore {
  const dir = mkdtempSync(join(tmpdir(), 'mec-reconcile-'))
  dirs.push(dir)
  const db = new Database(join(dir, 'mec.db'))
  migrate(db, MIGRATIONS_v1)
  return new SqliteStore(db)
}

const card = (id: string, cls: string, payload: StoreDoc, status = 'approved'): StoreDoc => ({
  id,
  cls,
  status,
  operationHash: 'h',
  inputSha: SHA,
  createdAt: '2026-11-05T10:00:00.000Z',
  expiresAt: '2026-11-06T10:00:00.000Z',
  payload: payload as never,
})

const PUSH = { repo: 'o/r', repoId: 'repo_a', branch: 'mec/x', remoteUrl: 'git@github.com:o/r.git' }
const PR = { repo: 'o/r', branch: 'mec/x', title: 't', body: 'b' }
const MERGE = { repo: 'o/r', prNumber: 7, branch: 'mec/x' }

function fakes(answers: { lsRemote?: string; prList?: string; prState?: string; failRead?: boolean }) {
  const calls: string[] = []
  const answer = (code: number, stdout: string) => ({ code, stdout, stderr: '' })
  const git = async (args: readonly string[]) => {
    calls.push(`git ${args.join(' ')}`)
    if (args[0] !== 'ls-remote') throw new Error(`git ${args[0]} must never run here`)
    return answers.failRead === true ? answer(128, '') : answer(0, answers.lsRemote ?? '')
  }
  const run = async (args: readonly string[]) => {
    calls.push(`gh ${args.join(' ')}`)
    if (args.includes('create') || args.includes('merge')) throw new Error('nothing is sent from an approval')
    if (args[1] === 'list') return answer(0, answers.prList ?? '[]')
    return answer(0, JSON.stringify({ state: answers.prState ?? 'OPEN' }))
  }
  return { git, run, calls }
}

const boot = (store: SqliteStore, f: ReturnType<typeof fakes>) =>
  reconcileExternal({
    store,
    effects: store.effects,
    run: f.run,
    git: f.git,
    now: () => new Date('2026-11-05T11:00:00.000Z'),
  })

const types = (store: SqliteStore, stream: string): string[] =>
  store.events.read(stream).map((event) => event.type)

describe('external reconciliation', () => {
  it('approved push found on remote is recorded pushed', async () => {
    const store = open()
    store.confirmations.save(card('conf_1', 'push', PUSH))
    const f = fakes({ lsRemote: `${SHA}\trefs/heads/mec/x\n` })
    await boot(store, f)
    expect(types(store, 'release:o/r:mec/x')).toEqual(['pushed'])
    expect(store.events.read('release:o/r:mec/x')[0]?.body).toMatchObject({
      reconciled: true,
      headSha: SHA,
    })
    expect(f.calls.filter((call) => call.startsWith('git push'))).toEqual([])
  })

  it('absent push needs a new card', async () => {
    const store = open()
    store.confirmations.save(card('conf_1', 'push', PUSH))
    const f = fakes({ lsRemote: '' })
    await boot(store, f)
    expect(types(store, 'release:o/r:mec/x')).toEqual(['push_not_sent'])
    expect(f.calls).toHaveLength(1)
  })

  it('a remote on another head is not this push', async () => {
    const store = open()
    store.confirmations.save(card('conf_1', 'push', PUSH))
    await boot(store, fakes({ lsRemote: `${OTHER}\trefs/heads/mec/x\n` }))
    expect(types(store, 'release:o/r:mec/x')).toEqual(['push_not_sent'])
  })

  it('a remote that cannot be read records nothing and asks again next boot', async () => {
    const store = open()
    store.confirmations.save(card('conf_1', 'push', PUSH))
    await boot(store, fakes({ failRead: true }))
    expect(types(store, 'release:o/r:mec/x')).toEqual([])
    await boot(store, fakes({ lsRemote: `${SHA}\trefs/heads/mec/x\n` }))
    expect(types(store, 'release:o/r:mec/x')).toEqual(['pushed'])
  })

  it('PR found by head is not created twice', async () => {
    const store = open()
    store.confirmations.save(card('conf_2', 'pr_create', PR))
    const prList = JSON.stringify([{ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' }])
    const f = fakes({ prList })
    await boot(store, f)
    expect(types(store, 'release:o/r:mec/x')).toEqual(['pr_created'])
    expect(f.calls.filter((call) => call.includes(' create'))).toEqual([])
  })

  it('no PR by that head records that nothing was sent', async () => {
    const store = open()
    store.confirmations.save(card('conf_2', 'pr_create', PR))
    await boot(store, fakes({}))
    expect(types(store, 'release:o/r:mec/x')).toEqual(['pr_not_sent'])
  })

  it('merge is confirmed from GitHub state', async () => {
    const store = open()
    store.confirmations.save(card('conf_3', 'pr_merge', MERGE))
    const f = fakes({ prState: 'MERGED' })
    await boot(store, f)
    expect(types(store, 'release:o/r:pr-7')).toEqual(['merged_on_github'])
    expect(f.calls.filter((call) => call.includes(' merge '))).toEqual([])
  })

  it('an open PR after an approved merge is recorded as not merged', async () => {
    const store = open()
    store.confirmations.save(card('conf_3', 'pr_merge', MERGE))
    await boot(store, fakes({ prState: 'OPEN' }))
    expect(types(store, 'release:o/r:pr-7')).toEqual(['merge_not_sent'])
  })

  it('a card with an outcome, or that no one approved, is not read at all', async () => {
    const store = open()
    store.confirmations.save(card('conf_1', 'push', PUSH))
    store.confirmations.save(card('conf_2', 'pr_create', PR, 'denied'))
    const stream = 'release:o/r:mec/x'
    store.events.append(stream, {
      stream,
      seq: 1,
      at: '2026-11-05T10:30:00.000Z',
      type: 'push_failed',
      body: { confirmationId: 'conf_1' },
    })
    const f = fakes({})
    await boot(store, f)
    expect(f.calls).toEqual([])
  })

  it('a second boot reads nothing twice', async () => {
    const store = open()
    store.confirmations.save(card('conf_1', 'push', PUSH))
    await boot(store, fakes({ lsRemote: `${SHA}\trefs/heads/mec/x\n` }))
    const second = fakes({ lsRemote: '' })
    await boot(store, second)
    expect(second.calls).toEqual([])
  })
})
