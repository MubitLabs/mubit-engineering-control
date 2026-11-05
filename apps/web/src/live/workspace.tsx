import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { api, type ChatMessage, type RepositoryEntry, subscribeMerged, type WorkItem } from '../api'
import { type Address, addressHash, parseAddress } from '../next/address'
import { repositoryName } from '../repo-target'

/**
 * The next shell's data. One scope at a time: a repository's id, or Unassigned for legacy rows.
 * It takes nothing from classic's store, whose first-live selection is the bug this layer exists
 * to avoid, and keeps to plain objects so the races below run in a test with no browser.
 */

export const UNASSIGNED = 'unassigned'

const READ_TIMEOUT_MS = 15_000
const REFETCH_DEBOUNCE_MS = 250
const REFETCH_INTERVAL_MS = 10_000

export interface Feed<T> {
  status: 'loading' | 'ready' | 'error'
  rows: T[]
}

export interface WorkspaceState {
  repositories: Feed<RepositoryEntry>
  /** Rows with no repository exist, so the sidebar offers them. */
  unassigned: boolean
  scope: string | null
  chat: Feed<ChatMessage>
  work: Feed<WorkItem>
}

export interface WorkspaceClient {
  repositories(): Promise<RepositoryEntry[]>
  chat(scope: string, signal?: AbortSignal): Promise<ChatMessage[]>
  work(scope: string, signal?: AbortSignal): Promise<WorkItem[]>
  subscribe(
    subscriptions: ReadonlyArray<{ stream: string; after: number }>,
    onEvent: (event: { seq: number } & Record<string, unknown>) => void,
  ): () => void
}

export const liveClient: WorkspaceClient = {
  repositories: () => api.repositories(),
  chat: (scope, signal) => api.chat(scope, signal),
  work: (scope, signal) => api.work(scope, signal),
  subscribe: subscribeMerged,
}

export const loading = <T,>(): Feed<T> => ({ status: 'loading', rows: [] })

/** No perpetual loading: a read that never answers ends in the error state with its retry. */
function within<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), READ_TIMEOUT_MS)
  })
  return Promise.race([read, late]).finally(() => clearTimeout(timer))
}

const inScope = (scope: string, row: { repoId?: string }): boolean =>
  scope === UNASSIGNED ? row.repoId === undefined : row.repoId === scope

export function createWorkspace(client: WorkspaceClient) {
  let state: WorkspaceState = {
    repositories: loading(),
    unassigned: false,
    scope: null,
    chat: loading(),
    work: loading(),
  }
  const watchers = new Set<() => void>()
  /** The read in flight. Anything answering under an older controller is from another scope. */
  let reading: AbortController | null = null
  let streamKey = ''
  let unsubscribe: () => void = () => {}
  let debounce: ReturnType<typeof setTimeout> | undefined
  const cursors: Record<string, number> = {}

  const set = (patch: Partial<WorkspaceState>) => {
    state = { ...state, ...patch }
    for (const watcher of watchers) watcher()
  }

  const follow = (rows: readonly WorkItem[]) => {
    const streams = [...rows.map((row) => `work:${row.id}`), 'repositories']
    const next = streams.join(',')
    if (next === streamKey) return
    streamKey = next
    unsubscribe()
    unsubscribe = client.subscribe(
      streams.map((stream) => ({ stream, after: cursors[stream] ?? 0 })),
      (event) => {
        if (typeof event.stream === 'string') cursors[event.stream] = event.seq
        clearTimeout(debounce)
        debounce = setTimeout(refresh, REFETCH_DEBOUNCE_MS)
      },
    )
  }

  const read = (scope: string) => {
    reading?.abort()
    const controller = new AbortController()
    reading = controller
    const live = () => reading === controller
    const timer = setTimeout(() => {
      if (!live()) return
      controller.abort()
      const { chat, work } = state
      set({
        chat: chat.status === 'loading' ? { status: 'error', rows: chat.rows } : chat,
        work: work.status === 'loading' ? { status: 'error', rows: work.rows } : work,
      })
    }, READ_TIMEOUT_MS)

    const chat = client
      .chat(scope, controller.signal)
      .then((rows) => {
        if (live()) set({ chat: { status: 'ready', rows: rows.filter((row) => inScope(scope, row)) } })
      })
      .catch(() => {
        if (live()) set({ chat: { status: 'error', rows: state.chat.rows } })
      })
    const work = client
      .work(scope, controller.signal)
      .then((rows) => {
        if (!live()) return
        const kept = rows.filter((row) => inScope(scope, row))
        set({ work: { status: 'ready', rows: kept } })
        follow(kept)
      })
      .catch(() => {
        if (live()) set({ work: { status: 'error', rows: state.work.rows } })
      })
    void Promise.allSettled([chat, work]).then(() => clearTimeout(timer))
  }

  const readRepositories = () => {
    within(client.repositories())
      .then((rows) => set({ repositories: { status: 'ready', rows } }))
      .catch(() => set({ repositories: { status: 'error', rows: state.repositories.rows } }))
    Promise.all([client.chat(UNASSIGNED), client.work(UNASSIGNED)])
      .then(([chat, work]) => {
        const unassigned =
          chat.some((row) => inScope(UNASSIGNED, row)) || work.some((row) => inScope(UNASSIGNED, row))
        if (unassigned !== state.unassigned) set({ unassigned })
      })
      .catch(() => {
        // Not knowing is not the same as none: the entry stays as it was.
      })
  }

  function refresh() {
    readRepositories()
    if (state.scope !== null) read(state.scope)
  }

  return {
    getState: () => state,

    subscribe(watcher: () => void): () => void {
      watchers.add(watcher)
      return () => {
        watchers.delete(watcher)
      }
    },

    start(): () => void {
      refresh()
      return () => {
        reading?.abort()
        reading = null
        clearTimeout(debounce)
        unsubscribe()
        unsubscribe = () => {}
        streamKey = ''
      }
    },

    /** A switch cancels what was in flight and shows nothing of the last scope. */
    setScope(scope: string | null): void {
      if (scope === state.scope) return
      reading?.abort()
      reading = null
      set({ scope, chat: loading(), work: loading() })
      if (scope !== null) read(scope)
    },

    refresh,
  }
}

export type Workspace = ReturnType<typeof createWorkspace>

export interface ResolvedRepository {
  id: string | null
  notice: string | null
}

/**
 * The active repository: the address, then the stored choice, then the only one. A repository
 * that has gone falls back with a notice, never silently onto another repository's work.
 */
export function resolveRepository(input: {
  addressed: string | null
  stored: string | null
  repositories: readonly RepositoryEntry[]
  unassigned: boolean
}): ResolvedRepository {
  const { addressed, stored, repositories, unassigned } = input
  const known = (id: string | null) => repositories.find((repo) => repo.id === id)
  if (addressed === UNASSIGNED && unassigned) return { id: UNASSIGNED, notice: null }
  if (known(addressed)) return { id: addressed, notice: null }

  const lost = addressed !== null || (stored !== null && !known(stored))
  const fallback = known(stored) ?? (repositories.length === 1 ? repositories[0] : undefined)
  if (!lost) return { id: fallback?.id ?? null, notice: null }
  const next =
    fallback === undefined ? 'Choose another to continue.' : `Showing ${repositoryName(fallback.url)}.`
  return { id: fallback?.id ?? null, notice: `That repository is no longer registered. ${next}` }
}

const subscribeHash = (notify: () => void) => {
  window.addEventListener('hashchange', notify)
  return () => window.removeEventListener('hashchange', notify)
}
const currentHash = () => window.location.hash

/** The address bar is the state: `location.hash` pushes history, so back and forward just work. */
export function useAddress(): [Address, (address: Address) => void] {
  const hash = useSyncExternalStore(subscribeHash, currentHash)
  const go = useCallback((address: Address) => {
    window.location.hash = addressHash(address)
  }, [])
  return [parseAddress(hash), go]
}

/** Keeps the feed current: streams cover known work, this catches the rest and a returning tab. */
export function useWorkspaceUpkeep(workspace: Workspace): void {
  useEffect(() => {
    const stop = workspace.start()
    const onBack = () => workspace.refresh()
    const timer = setInterval(onBack, REFETCH_INTERVAL_MS)
    window.addEventListener('online', onBack)
    document.addEventListener('visibilitychange', onBack)
    return () => {
      stop()
      clearInterval(timer)
      window.removeEventListener('online', onBack)
      document.removeEventListener('visibilitychange', onBack)
    }
  }, [workspace])
}
