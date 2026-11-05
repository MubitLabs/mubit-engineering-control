import { AlreadyHandledError, HttpError, type ResolveAnswer, type ResolveResult } from '../api'
import { DecodeError } from '../api-decode'
import { inspectApi } from '../api-inspect'
import type {
  CardEvidence,
  NeedItem,
  Page,
  SearchHit,
  TaskDetail,
  WorkDetail,
  WorkRow,
} from '../next/inspection-wire'
import {
  type AnswerOutcome,
  type ApprovalOutcome,
  DENIED,
  type Read,
  type WorkAction,
} from '../next/work-model'
import { describeApproval } from '../release-cards'

/**
 * The reads behind Work, Needs you and search, across every repository. Decoded pages go in and
 * work-model's `Read<T>` comes out; a filter is applied there, on what was read, so it can never
 * reach a request. Plain objects again, so every race below runs in a test with no browser.
 */

/** A page holds 100 rows: 2,000 is far past any real list, and past it the list says it is part. */
const MAX_PAGES = 20
const READ_TIMEOUT_MS = 15_000
const SEARCH_DEBOUNCE_MS = 200
const SEARCH_MAX = 200

export interface CommandResult {
  id: string
  status: string
}

export interface InspectionClient {
  work(cursor: string | null, signal?: AbortSignal): Promise<Page<WorkRow>>
  needs(cursor: string | null, signal?: AbortSignal): Promise<Page<NeedItem>>
  workDetail(id: string, signal?: AbortSignal): Promise<WorkDetail>
  taskDetail(id: string, signal?: AbortSignal): Promise<TaskDetail>
  evidence(id: string): Promise<CardEvidence>
  search(q: string, signal?: AbortSignal): Promise<Page<SearchHit>>
  hold(id: string): Promise<CommandResult>
  lift(id: string): Promise<CommandResult>
  stop(id: string): Promise<CommandResult>
  resolve(id: string, answer: ResolveAnswer): Promise<ResolveResult>
  answer(id: string, answer: string): Promise<void>
}

export interface Selected<T> {
  id: string | null
  read: Read<T>
}

export interface CommandNotice {
  kind: 'done' | 'failed'
  text: string
}

export interface InspectionState {
  work: Read<Page<WorkRow>>
  needs: Read<Page<NeedItem>>
  delivery: Selected<WorkDetail>
  task: Selected<TaskDetail>
  /** Evidence by card. An id with no entry has not loaded, which is not the same as absent. */
  evidence: Readonly<Record<string, CardEvidence>>
  outcomes: Readonly<Record<string, ApprovalOutcome>>
  answers: Readonly<Record<string, AnswerOutcome>>
  query: string
  search: Read<Page<SearchHit>>
  notice: CommandNotice | null
}

const EMPTY_SEARCH: Page<SearchHit> = { items: [], nextCursor: null, observedAt: '' }

/** Words for a read that failed. An over-large record answers the same on retry, and says so. */
export function readFailure(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.reason === 'response_too_large') {
      return 'This record is too large to show here. The work itself is not affected.'
    }
    return `The workbench answered with an error (${error.status}).`
  }
  if (error instanceof DecodeError) return 'The answer could not be read by this version of the page.'
  return 'The workbench did not answer.'
}

/** describeApproval reads an approve click; a deny settled with nothing run has its own words. */
const outcomeOf = (result: ResolveResult): ApprovalOutcome =>
  result.status === 'denied' ? DENIED : describeApproval(result)

function failedOutcome(error: unknown): ApprovalOutcome {
  if (error instanceof AlreadyHandledError) {
    return {
      closes: true,
      note: 'Already handled',
      toast: 'Someone answered this card first. Yours was not used.',
    }
  }
  const why = error instanceof HttpError && error.reason !== undefined ? ` (${error.reason})` : ''
  return {
    closes: false,
    note: 'Not confirmed',
    toast: `The answer may not have reached the workbench${why}. Check this card before answering again.`,
  }
}

const COMMAND_WORDS: Record<string, string> = {
  held: 'Held. A running turn finishes, and nothing new starts until you lift it.',
  lifted: 'Hold lifted.',
  free: 'This work was not held.',
  stopped: 'Stopped.',
}

function commandFailure(error: unknown): string {
  const reason = error instanceof HttpError ? error.reason : undefined
  return reason === undefined
    ? 'The workbench did not answer, so this may not have happened. Check the delivery.'
    : `The workbench refused this: ${reason}.`
}

function failedRead<T>(previous: Read<T>, error: unknown): Read<T> {
  return {
    status: 'failed',
    message: readFailure(error),
    data: previous.status === 'loading' ? null : previous.data,
    readAt: previous.status === 'loading' ? null : previous.readAt,
  }
}

function within<T>(read: (signal: AbortSignal) => Promise<T>, outer: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  outer.addEventListener('abort', abort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('timed out'))
    }, READ_TIMEOUT_MS)
  })
  return Promise.race([read(controller.signal), late]).finally(() => {
    clearTimeout(timer)
    outer.removeEventListener('abort', abort)
  })
}

async function walk<T>(
  read: (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>,
  signal: AbortSignal,
): Promise<Page<T>> {
  const items: T[] = []
  let cursor: string | null = null
  let observedAt = ''
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const answer: Page<T> = await within((inner) => read(cursor, inner), signal)
    items.push(...answer.items)
    observedAt = answer.observedAt
    cursor = answer.nextCursor
    if (cursor === null) break
  }
  return { items, nextCursor: cursor, observedAt }
}

export function createInspection(client: InspectionClient) {
  let state: InspectionState = {
    work: { status: 'loading' },
    needs: { status: 'loading' },
    delivery: { id: null, read: { status: 'loading' } },
    task: { id: null, read: { status: 'loading' } },
    evidence: {},
    outcomes: {},
    answers: {},
    query: '',
    search: { status: 'ready', data: EMPTY_SEARCH, readAt: '' },
    notice: null,
  }
  const watchers = new Set<() => void>()
  /** Anything answering under an older controller is out of date. */
  let reading: AbortController | null = null
  let readingDelivery: AbortController | null = null
  let readingTask: AbortController | null = null
  let searching: AbortController | null = null
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  const settling = new Set<string>()

  const set = (patch: Partial<InspectionState>) => {
    state = { ...state, ...patch }
    for (const watcher of watchers) watcher()
  }

  const now = () => new Date().toISOString()

  const readEvidence = (id: string): Promise<void> =>
    client
      .evidence(id)
      .then((evidence) => set({ evidence: { ...state.evidence, [id]: evidence } }))
      .catch(() => {
        // No entry is what the card shows: nothing to approve on, with a retry.
      })

  /** One at a time: a long list of open cards must not become a burst of reads. */
  const readOpenEvidence = async (items: readonly NeedItem[], live: () => boolean) => {
    for (const item of items) {
      if (!live()) return
      if (item.kind === 'card' && item.status === 'pending') await readEvidence(item.id)
    }
  }

  const readDelivery = (id: string) => {
    readingDelivery?.abort()
    const controller = new AbortController()
    readingDelivery = controller
    const live = () => readingDelivery === controller
    within((signal) => client.workDetail(id, signal), controller.signal)
      .then((data) => {
        if (live()) set({ delivery: { id, read: { status: 'ready', data, readAt: now() } } })
      })
      .catch((error: unknown) => {
        if (live()) set({ delivery: { id, read: failedRead(state.delivery.read, error) } })
      })
  }

  const readTask = (id: string) => {
    readingTask?.abort()
    const controller = new AbortController()
    readingTask = controller
    const live = () => readingTask === controller
    within((signal) => client.taskDetail(id, signal), controller.signal)
      .then((data) => {
        if (live()) set({ task: { id, read: { status: 'ready', data, readAt: now() } } })
      })
      .catch((error: unknown) => {
        if (live()) set({ task: { id, read: failedRead(state.task.read, error) } })
      })
  }

  const refresh = () => {
    reading?.abort()
    const controller = new AbortController()
    reading = controller
    const live = () => reading === controller
    walk(client.work, controller.signal)
      .then((data) => {
        if (live()) set({ work: { status: 'ready', data, readAt: now() } })
      })
      .catch((error: unknown) => {
        if (live()) set({ work: failedRead(state.work, error) })
      })
    walk(client.needs, controller.signal)
      .then((data) => {
        if (!live()) return
        set({ needs: { status: 'ready', data, readAt: now() } })
        void readOpenEvidence(data.items, live)
      })
      .catch((error: unknown) => {
        if (live()) set({ needs: failedRead(state.needs, error) })
      })
    if (state.delivery.id !== null) readDelivery(state.delivery.id)
    if (state.task.id !== null) readTask(state.task.id)
  }

  const runSearch = (q: string) => {
    searching?.abort()
    const controller = new AbortController()
    searching = controller
    const live = () => searching === controller
    set({ search: { status: 'loading' } })
    within((signal) => client.search(q, signal), controller.signal)
      .then((data) => {
        if (live()) set({ search: { status: 'ready', data, readAt: now() } })
      })
      .catch((error: unknown) => {
        if (live()) {
          set({ search: { status: 'failed', message: readFailure(error), data: null, readAt: null } })
        }
      })
  }

  return {
    getState: () => state,

    subscribe(watcher: () => void): () => void {
      watchers.add(watcher)
      return () => {
        watchers.delete(watcher)
      }
    },

    refresh,
    readEvidence,

    selectWork(id: string | null): void {
      if (id === state.delivery.id) return
      readingDelivery?.abort()
      readingDelivery = null
      set({ delivery: { id, read: { status: 'loading' } } })
      if (id !== null) readDelivery(id)
    },

    selectTask(id: string | null): void {
      if (id === state.task.id) return
      readingTask?.abort()
      readingTask = null
      set({ task: { id, read: { status: 'loading' } } })
      if (id !== null) readTask(id)
    },

    /** The card's own id, once. The answer is whatever the server said, in describeApproval's words. */
    settle(id: string, answer: ResolveAnswer): void {
      if (settling.has(id)) return
      settling.add(id)
      client
        .resolve(id, answer)
        .then(outcomeOf)
        .catch(failedOutcome)
        .then((outcome) => {
          settling.delete(id)
          set({ outcomes: { ...state.outcomes, [id]: outcome } })
          refresh()
        })
    },

    answer(id: string, text: string): void {
      if (settling.has(id)) return
      settling.add(id)
      client
        .answer(id, text)
        .then(
          (): AnswerOutcome => ({ kind: 'answered', answer: text }),
          (error: unknown): AnswerOutcome =>
            error instanceof HttpError && error.status === 409
              ? { kind: 'already-answered' }
              : { kind: 'failed', message: commandFailure(error) },
        )
        .then((outcome) => {
          settling.delete(id)
          set({ answers: { ...state.answers, [id]: outcome } })
          if (outcome.kind !== 'failed') refresh()
        })
    },

    /** Hold, lift and stop act on the item's own id, whatever is selected or filtered. */
    act(action: WorkAction): void {
      const key = `${action.kind}:${action.workItemId}`
      if (settling.has(key)) return
      settling.add(key)
      client[action.kind](action.workItemId)
        .then(
          ({ status }): CommandNotice => ({ kind: 'done', text: COMMAND_WORDS[status] ?? status }),
          (error: unknown): CommandNotice => ({ kind: 'failed', text: commandFailure(error) }),
        )
        .then((notice) => {
          settling.delete(key)
          set({ notice })
          refresh()
        })
    },

    clearNotice(): void {
      if (state.notice !== null) set({ notice: null })
    },

    setQuery(raw: string): void {
      const query = raw.slice(0, SEARCH_MAX)
      clearTimeout(searchTimer)
      searching?.abort()
      searching = null
      set({ query })
      const typed = query.trim()
      if (typed === '') {
        set({ search: { status: 'ready', data: EMPTY_SEARCH, readAt: now() } })
        return
      }
      searchTimer = setTimeout(() => runSearch(typed), SEARCH_DEBOUNCE_MS)
    },

    retrySearch(): void {
      const typed = state.query.trim()
      if (typed !== '') runSearch(typed)
    },
  }
}

export type Inspection = ReturnType<typeof createInspection>

export const liveInspectionClient: InspectionClient = inspectApi
