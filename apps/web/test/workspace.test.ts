import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, RepositoryEntry, WorkItem } from '../src/api'
import {
  chatRead,
  createWorkspace,
  type Feed,
  resolveActive,
  resolveRepository,
  UNASSIGNED,
  type WorkspaceClient,
} from '../src/live/workspace'

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
    snapshot: async () => ({ cursors: {}, labels: {} }),
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
      snapshot: async () => ({ cursors: {}, labels: {} }),
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
      snapshot: async () => ({ cursors: {}, labels: {} }),
      subscribe: () => () => {},
    })
    const stop = workspace.start()
    await new Promise((done) => setTimeout(done))
    expect(workspace.getState().repositories).toMatchObject({ status: 'ready', rows: [{ id: 'repo_a' }] })
    expect(workspace.getState().unassigned).toBe(true)
    stop()
  })

  it('does not know about Unassigned until both its reads have answered', async () => {
    let answerChat: (rows: ChatMessage[]) => void = () => {}
    const workspace = createWorkspace({
      repositories: async () => [repo('repo_a')],
      chat: () => new Promise((resolve) => (answerChat = resolve)),
      work: async () => [],
      snapshot: async () => ({ cursors: {}, labels: {} }),
      subscribe: () => () => {},
    })
    const stop = workspace.start()
    await new Promise((done) => setTimeout(done))
    expect(workspace.getState().repositories.status).toBe('ready')
    expect(workspace.getState().unassigned).toBeNull()
    answerChat([])
    await new Promise((done) => setTimeout(done))
    expect(workspace.getState().unassigned).toBe(false)
    stop()
  })

  it('a failed Unassigned read stays unknown, then a later read settles it', async () => {
    let online = false
    const workspace = createWorkspace({
      repositories: async () => [repo('repo_a')],
      chat: async () => {
        if (!online) throw new Error('offline')
        return [message('m_old')]
      },
      work: async () => [],
      snapshot: async () => ({ cursors: {}, labels: {} }),
      subscribe: () => () => {},
    })
    const stop = workspace.start()
    await new Promise((done) => setTimeout(done))
    expect(workspace.getState().unassigned).toBeNull()
    online = true
    workspace.refresh()
    await new Promise((done) => setTimeout(done))
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

  it('an Unassigned address waits for its reads: no fallback and no notice', () => {
    const unknown = { ...base, addressed: UNASSIGNED, unassigned: null }
    const empty = { id: null, notice: null }
    expect(resolveRepository(unknown)).toEqual(empty)
    expect(resolveRepository({ ...unknown, stored: 'repo_a' })).toEqual(empty)
    expect(resolveRepository({ ...unknown, stored: 'repo_gone' })).toEqual(empty)
    expect(resolveRepository({ ...unknown, repositories: [repo('repo_a')] })).toEqual(empty)
    expect(resolveRepository({ ...unknown, repositories: [] })).toEqual(empty)
  })

  it('unknown Unassigned changes nothing for any other address', () => {
    expect(resolveRepository({ ...base, addressed: 'repo_b', unassigned: null }).id).toBe('repo_b')
    expect(resolveRepository({ ...base, stored: 'repo_a', unassigned: null }).id).toBe('repo_a')
    const lost = resolveRepository({ ...base, addressed: 'repo_gone', stored: 'repo_a', unassigned: null })
    expect(lost.notice).toContain('no longer')
  })
})

describe('a repositories read that failed', () => {
  const repositories = [repo('repo_a'), repo('repo_b')]
  const failed: Feed<RepositoryEntry> = { status: 'error', rows: repositories }
  const none = { addressed: null, stored: null, unassigned: false }

  it('keeps the active repository from the rows it kept', () => {
    const resolved = resolveActive({ ...none, addressed: 'repo_b', repositories: failed })
    expect(resolved).toEqual({ id: 'repo_b', notice: null })
  })

  it('keeps the stored repository too', () => {
    const resolved = resolveActive({ ...none, stored: 'repo_a', repositories: failed })
    expect(resolved).toEqual({ id: 'repo_a', notice: null })
  })

  it('proves nothing has gone: no notice, and the stored choice stands', () => {
    for (const input of [{ addressed: 'repo_c' }, { stored: 'repo_c' }]) {
      const resolved = resolveActive({ ...none, ...input, repositories: failed })
      expect(resolved).toEqual({ id: null, notice: null })
    }
  })

  it('a repository the server has dropped is still said once a read answers', () => {
    const answered: Feed<RepositoryEntry> = { status: 'ready', rows: repositories }
    const resolved = resolveActive({ ...none, addressed: 'repo_c', repositories: answered })
    expect(resolved.notice).toContain('no longer registered')
  })

  it('nothing is known while the first read is out', () => {
    const resolved = resolveActive({
      ...none,
      stored: 'repo_a',
      repositories: { status: 'loading', rows: [] },
    })
    expect(resolved).toEqual({ id: null, notice: null })
  })

  it('Unassigned history is still reachable with no repository to keep', () => {
    const resolved = resolveActive({
      addressed: UNASSIGNED,
      stored: null,
      unassigned: true,
      repositories: { status: 'error', rows: [] },
    })
    expect(resolved.id).toBe(UNASSIGNED)
  })

  it('a feed keeps its rows, so the next render still has them', async () => {
    let down = false
    const workspace = createWorkspace({
      repositories: async () => {
        if (down) throw new Error('down')
        return repositories
      },
      chat: async () => [],
      work: async () => [],
      snapshot: async () => ({ cursors: {}, labels: {} }),
      subscribe: () => () => {},
    })
    workspace.refresh()
    await vi.waitFor(() => expect(workspace.getState().repositories.status).toBe('ready'))
    down = true
    workspace.refresh()
    await vi.waitFor(() => expect(workspace.getState().repositories.status).toBe('error'))
    expect(workspace.getState().repositories.rows).toEqual(repositories)
  })
})

describe('the thread as a read', () => {
  const line = message('m1', 'repo_a')
  const read: Feed<ChatMessage> = { status: 'ready', rows: [line], readAt: '2026-11-05T10:00:00.000Z' }
  const healthy: Feed<RepositoryEntry> = { status: 'ready', rows: [] }

  it('is ready while both reads are', () => {
    expect(chatRead(read, healthy).status).toBe('ready')
  })

  it('a failed repositories read makes it stale, with its lines and its time', () => {
    expect(chatRead(read, { status: 'error', rows: [] })).toMatchObject({
      status: 'failed',
      data: [{ id: 'm1' }],
      readAt: '2026-11-05T10:00:00.000Z',
    })
  })

  it('a failed chat read keeps its lines', () => {
    expect(chatRead({ ...read, status: 'error' }, healthy)).toMatchObject({
      status: 'failed',
      data: [{ id: 'm1' }],
    })
  })

  it('is loading until it has anything to say', () => {
    expect(chatRead({ status: 'loading', rows: [] }, { status: 'error', rows: [] })).toEqual({
      status: 'loading',
    })
  })
})
