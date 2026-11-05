import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { api, type ChatMessage, type RepositoryEntry, type ServerEvent, type WorkItem } from '../api'
import { inspectApi } from '../api-inspect'
import { decodeChatLines } from '../inspection-decode'
import { type Address, addressHash, parseAddress } from '../next/address'
import { repositoryName } from '../repo-target'
import { type StreamHooks, subscribeResumable } from './events'

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
  /** When the rows were read. A failed read keeps both. */
  readAt?: string
}

export interface WorkspaceState {
  repositories: Feed<RepositoryEntry>
  /** Rows with no repository exist, so the sidebar offers them. Null until a read has answered. */
  unassigned: boolean | null
  scope: string | null
  chat: Feed<ChatMessage>
  work: Feed<WorkItem>
  /** The inspection routes' own repository labels, which search hits and rows carry. */
  labels: Readonly<Record<string, string>>
  /** The event history moved on and a new snapshot replaced it. Null once said and dismissed. */
  resetAt: string | null
}

export interface WorkspaceSnapshot {
  cursors: Record<string, number>
  labels: Record<string, string>
}

export interface WorkspaceClient {
  repositories(): Promise<RepositoryEntry[]>
  chat(scope: string, signal?: AbortSignal): Promise<ChatMessage[]>
  work(scope: string, signal?: AbortSignal): Promise<WorkItem[]>
  /** One consistent read of the event cursors, so a new connection replays no history. */
  snapshot(): Promise<WorkspaceSnapshot>
  subscribe(
    subscriptions: ReadonlyArray<{ stream: string; after: number }>,
    onEvent: (event: ServerEvent) => void,
    hooks?: StreamHooks,
  ): () => void
}

export const liveClient: WorkspaceClient = {
  repositories: () => api.repositories(),
  // Checked on the way in, so a shape the page cannot read ends in the failed state.
  chat: (scope, signal) =>
    api.chat(scope, signal).then((rows) => {
      decodeChatLines(rows)
      return rows
    }),
  work: (scope, signal) => api.work(scope, signal),
  snapshot: () =>
    inspectApi.snapshot().then(({ cursors, repositories }) => ({
      cursors,
      labels: Object.fromEntries(
        repositories.flatMap(({ id, label }) => (label === null ? [] : [[id, label]])),
      ),
    })),
  subscribe: subscribeResumable,
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
    unassigned: null,
    scope: null,
    chat: loading(),
    work: loading(),
    labels: {},
    resetAt: null,
  }
  const watchers = new Set<() => void>()
  /** The read in flight. Anything answering under an older controller is from another scope. */
  let reading: AbortController | null = null
  let streamKey = ''
  let unsubscribe: () => void = () => {}
  let debounce: ReturnType<typeof setTimeout> | undefined
  let cursors: Record<string, number> = {}
  /** Streams the snapshot named, every repository's, followed alongside this scope's. */
  let followed: readonly string[] = []
  let snapshotting = false
  let running = false
  /** A reset waits here until a snapshot lands, so one failed read cannot drop it. */
  let resetPending = false
  const refreshed = new Set<() => void>()

  const set = (patch: Partial<WorkspaceState>) => {
    state = { ...state, ...patch }
    for (const watcher of watchers) watcher()
  }

  const follow = () => {
    if (resetPending) return
    const scoped = state.work.rows.map((row) => `work:${row.id}`)
    const streams = [...new Set([...scoped, ...followed, 'repositories'])]
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
      { onReset, onReopen: refresh },
    )
  }

  function takeSnapshot() {
    if (snapshotting) return
    snapshotting = true
    client
      .snapshot()
      .then(({ cursors: served, labels }) => {
        snapshotting = false
        if (!running) return
        // A reset's history is gone, so its cursors replace ours even when they are lower.
        cursors = resetPending ? { ...served } : { ...served, ...cursors }
        followed = Object.keys(served)
        streamKey = ''
        set({ labels, ...(resetPending && { resetAt: new Date().toISOString() }) })
        resetPending = false
        follow()
        refresh()
      })
      .catch(() => {
        // The scope's own streams and the interval still cover this; `refresh` tries a reset again.
        snapshotting = false
        if (running) follow()
      })
  }

  function onReset() {
    unsubscribe = () => {}
    streamKey = ''
    resetPending = true
    takeSnapshot()
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
        chat: chat.status === 'loading' ? { ...chat, status: 'error' } : chat,
        work: work.status === 'loading' ? { ...work, status: 'error' } : work,
      })
    }, READ_TIMEOUT_MS)

    const chat = client
      .chat(scope, controller.signal)
      .then((rows) => {
        if (live()) {
          const kept = rows.filter((row) => inScope(scope, row))
          set({ chat: { status: 'ready', rows: kept, readAt: new Date().toISOString() } })
        }
      })
      .catch(() => {
        if (live()) set({ chat: { ...state.chat, status: 'error' } })
      })
    const work = client
      .work(scope, controller.signal)
      .then((rows) => {
        if (!live()) return
        const kept = rows.filter((row) => inScope(scope, row))
        set({ work: { status: 'ready', rows: kept, readAt: new Date().toISOString() } })
        follow()
      })
      .catch(() => {
        if (live()) set({ work: { ...state.work, status: 'error' } })
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
    if (resetPending) takeSnapshot()
    readRepositories()
    if (state.scope !== null) read(state.scope)
    for (const watcher of refreshed) watcher()
  }

  return {
    getState: () => state,

    subscribe(watcher: () => void): () => void {
      watchers.add(watcher)
      return () => {
        watchers.delete(watcher)
      }
    },

    /** Everything that reads alongside this feed, on the same triggers. */
    onRefresh(watcher: () => void): () => void {
      refreshed.add(watcher)
      return () => {
        refreshed.delete(watcher)
      }
    },

    start(): () => void {
      running = true
      refresh()
      takeSnapshot()
      return () => {
        running = false
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

    clearReset(): void {
      if (state.resetAt !== null) set({ resetAt: null })
    },
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
  unassigned: boolean | null
}): ResolvedRepository {
  const { addressed, stored, repositories, unassigned } = input
  const known = (id: string | null) => repositories.find((repo) => repo.id === id)
  if (addressed === UNASSIGNED && unassigned === null) return { id: null, notice: null }
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
