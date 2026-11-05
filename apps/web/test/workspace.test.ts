import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, RepositoryEntry, WorkItem } from '../src/api'
import { createWorkspace, resolveRepository, UNASSIGNED, type WorkspaceClient } from '../src/live/workspace'

const repo = (id: string): RepositoryEntry => ({
  id,
  url: `https://example.test/acme/${id}`,
  bootstrap: [],
  checks: [],
  trust: true,
})

const work = (id: string, repoId?: string): WorkItem => ({
  id,
  ...(repoId !== undefined && { repoId }),
  state: 'executing',
  stage: 'executing',
  taskCounts: { total: 0, byStatus: {} },
  updatedAt: '',
})

const message = (id: string, repoId?: string): ChatMessage => ({
  id,
  ...(repoId !== undefined && { repoId }),
  text: id,
  createdAt: '',
})

interface Read<T> {
  scope: string
  signal: AbortSignal
  resolve: (rows: T[]) => void
  reject: (error: unknown) => void
}

function rig(repositories = [repo('repo_a'), repo('repo_b')]) {
  const chat: Read<ChatMessage>[] = []
  const works: Read<WorkItem>[] = []
  const streams: string[][] = []
  const client: WorkspaceClient = {
    repositories: async () => repositories,
    chat: (scope, signal) =>
      scope === UNASSIGNED
        ? Promise.resolve([])
        : new Promise((resolve, reject) => {
            chat.push({ scope, signal: signal as AbortSignal, resolve, reject })
          }),
    work: (scope, signal) =>
      scope === UNASSIGNED
        ? Promise.resolve([])
        : new Promise((resolve, reject) => {
            works.push({ scope, signal: signal as AbortSignal, resolve, reject })
          }),
    subscribe: (subscriptions) => {
      streams.push(subscriptions.map((entry) => entry.stream))
      return () => {}
    },
  }
  return {
    workspace: createWorkspace(client),
    chat,
    works,
    streams,
    settle: () => new Promise((d) => setTimeout(d)),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('workspace feed', () => {
  it('reads only the active repository', async () => {
    const { workspace, chat, works, settle } = rig()
    workspace.setScope('repo_a')
    chat[0]?.resolve([message('m1', 'repo_a')])
    works[0]?.resolve([work('w1', 'repo_a')])
    await settle()
    const state = workspace.getState()
    expect(chat[0]?.scope).toBe('repo_a')
    expect(state.chat).toMatchObject({ status: 'ready', rows: [{ id: 'm1' }] })
    expect(state.work).toMatchObject({ status: 'ready', rows: [{ id: 'w1' }] })
  })

  it('drops a row from another repository', async () => {
    const { workspace, chat, works, settle } = rig()
    workspace.setScope('repo_b')
    chat[0]?.resolve([message('m_a', 'repo_a'), message('m_b', 'repo_b')])
    works[0]?.resolve([work('w_a', 'repo_a'), work('w_b', 'repo_b')])
    await settle()
    expect(workspace.getState().work.rows.map((row) => row.id)).toEqual(['w_b'])
    expect(workspace.getState().chat.rows.map((row) => row.id)).toEqual(['m_b'])
  })

  it('Unassigned keeps only rows with no repository', async () => {
    const reads: WorkItem[] = [work('w_none'), work('w_a', 'repo_a')]
    const workspace = createWorkspace({
      repositories: async () => [],
      chat: async () => [],
      work: async () => reads,
      subscribe: () => () => {},
    })
    workspace.setScope(UNASSIGNED)
    await new Promise((done) => setTimeout(done))
    expect(workspace.getState().work.rows.map((row) => row.id)).toEqual(['w_none'])
  })

  it('switching cancels in-flight reads and a late answer never paints', async () => {
    const { workspace, chat, works, settle } = rig()
    workspace.setScope('repo_a')
    workspace.setScope('repo_b')
    expect(chat[0]?.signal.aborted).toBe(true)
    expect(works[0]?.signal.aborted).toBe(true)

    works[1]?.resolve([work('w_b', 'repo_b')])
    chat[1]?.resolve([message('m_b', 'repo_b')])
    await settle()
    // The server answered the cancelled read anyway, and it must not empty the new repo's list.
    works[0]?.resolve([work('w_a', 'repo_a')])
    chat[0]?.resolve([message('m_a', 'repo_a')])
    await settle()
    expect(workspace.getState().work.rows.map((row) => row.id)).toEqual(['w_b'])
    expect(workspace.getState().chat.rows.map((row) => row.id)).toEqual(['m_b'])
  })

  it('a late failure from a switched-away repo shows nothing', async () => {
    const { workspace, works, settle } = rig()
    workspace.setScope('repo_a')
    workspace.setScope('repo_b')
    works[0]?.reject(new Error('aborted'))
    await settle()
    expect(workspace.getState().work.status).toBe('loading')
  })

  it('switching starts from loading, never the last repo’s rows', async () => {
    const { workspace, chat, works, settle } = rig()
    workspace.setScope('repo_a')
    chat[0]?.resolve([message('m1', 'repo_a')])
    works[0]?.resolve([work('w1', 'repo_a')])
    await settle()
    workspace.setScope('repo_b')
    expect(workspace.getState()).toMatchObject({
      scope: 'repo_b',
      chat: { status: 'loading', rows: [] },
      work: { status: 'loading', rows: [] },
    })
  })

  it('a failed refresh keeps the rows and says so', async () => {
    const { workspace, chat, works, settle } = rig()
    workspace.setScope('repo_a')
    chat[0]?.resolve([])
    works[0]?.resolve([work('w1', 'repo_a')])
    await settle()
    workspace.refresh()
    works[1]?.reject(new Error('offline'))
    chat[1]?.resolve([])
    await settle()
    expect(workspace.getState().work).toMatchObject({ status: 'error', rows: [{ id: 'w1' }] })
  })

  it('a read that never answers ends in an error, not endless loading', async () => {
    vi.useFakeTimers()
    const { workspace, works } = rig()
    workspace.setScope('repo_a')
    expect(workspace.getState().work.status).toBe('loading')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(workspace.getState().work.status).toBe('error')
    expect(works[0]?.signal.aborted).toBe(true)
  })

  it('finds Unassigned rows and the registered repositories on start', async () => {
    const workspace = createWorkspace({
      repositories: async () => [repo('repo_a')],
      chat: async () => [message('m_old')],
      work: async () => [],
      subscribe: () => () => {},
    })
    const stop = workspace.start()
    await new Promise((done) => setTimeout(done))
    expect(workspace.getState().repositories).toMatchObject({ status: 'ready', rows: [{ id: 'repo_a' }] })
    expect(workspace.getState().unassigned).toBe(true)
    stop()
  })

  it('subscribes to this repository’s work streams only', async () => {
    const { workspace, chat, works, streams, settle } = rig()
    workspace.setScope('repo_a')
    chat[0]?.resolve([])
    works[0]?.resolve([work('w1', 'repo_a')])
    await settle()
    expect(streams.at(-1)).toEqual(['work:w1', 'repositories'])
  })
})

describe('resolveRepository', () => {
  const repositories = [repo('repo_a'), repo('repo_b')]
  const base = { addressed: null, stored: null, repositories, unassigned: false }

  it('the address wins', () => {
    expect(resolveRepository({ ...base, addressed: 'repo_b', stored: 'repo_a' })).toEqual({
      id: 'repo_b',
      notice: null,
    })
  })

  it('then the stored repository', () => {
    expect(resolveRepository({ ...base, stored: 'repo_b' }).id).toBe('repo_b')
  })

  it('then the only one', () => {
    expect(resolveRepository({ ...base, repositories: [repo('repo_a')] }).id).toBe('repo_a')
  })

  it('several and none chosen is none', () => {
    expect(resolveRepository(base)).toEqual({ id: null, notice: null })
  })

  it('zero repositories is none', () => {
    expect(resolveRepository({ ...base, repositories: [] })).toEqual({ id: null, notice: null })
  })

  it('a stale address falls back with a notice', () => {
    const resolved = resolveRepository({ ...base, addressed: 'repo_gone', stored: 'repo_a' })
    expect(resolved.id).toBe('repo_a')
    expect(resolved.notice).toContain('repo_a')
    expect(resolved.notice).toContain('no longer')
  })

  it('a stale stored repository never lands silently on another', () => {
    const one = resolveRepository({ ...base, repositories: [repo('repo_a')], stored: 'repo_gone' })
    expect(one.id).toBe('repo_a')
    expect(one.notice).not.toBeNull()
    const many = resolveRepository({ ...base, stored: 'repo_gone' })
    expect(many.id).toBeNull()
    expect(many.notice).not.toBeNull()
  })

  it('Unassigned is addressable only while such rows exist', () => {
    expect(resolveRepository({ ...base, addressed: UNASSIGNED, unassigned: true }).id).toBe(UNASSIGNED)
    expect(resolveRepository({ ...base, addressed: UNASSIGNED }).id).toBeNull()
  })
})
