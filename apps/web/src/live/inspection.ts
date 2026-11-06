import { AlreadyHandledError, HttpError, type ResolveAnswer, type ResolveResult } from '../api'
import { DecodeError } from '../api-decode'
import { inspectApi } from '../api-inspect'
import type {
  ActivityItem,
  ArtifactPage,
  CardEvidence,
  MetaAnswer,
  NeedItem,
  Page,
  SearchHit,
  TaskDetail,
  WorkDetail,
  WorkRow,
} from '../next/inspection-wire'
import {
  type ActivityPages,
  type AnswerOutcome,
  type ApprovalOutcome,
  DENIED,
  latestAttempt,
  type OpenArtifact,
  type Read,
  readData,
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
  meta(signal?: AbortSignal): Promise<MetaAnswer>
  workDetail(id: string, signal?: AbortSignal): Promise<WorkDetail>
  taskDetail(id: string, signal?: AbortSignal): Promise<TaskDetail>
  evidence(id: string): Promise<CardEvidence>
  search(q: string, signal?: AbortSignal): Promise<Page<SearchHit>>
  hold(id: string): Promise<CommandResult>
  lift(id: string): Promise<CommandResult>
  stop(id: string): Promise<CommandResult>
  retry(id: string): Promise<CommandResult>
  resolve(id: string, answer: ResolveAnswer): Promise<ResolveResult>
  answer(id: string, answer: string): Promise<void>
  activity(id: string, cursor: string | null, signal?: AbortSignal): Promise<Page<ActivityItem>>
  artifact(id: string, ref: string, cursor: string | null, signal?: AbortSignal): Promise<ArtifactPage>
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
  /** What the meta agent is doing, per repository. */
  meta: Read<MetaAnswer>
  delivery: Selected<WorkDetail>
  task: Selected<TaskDetail>
  /** The attempt on the Activity tab, read in pages. Null when the task has none to show. */
  activity: { attemptId: string | null; read: Read<ActivityPages> }
  artifact: OpenArtifact | null
  /** Evidence by card. An id with no entry has not loaded, which is not the same as absent. */
  evidence: Readonly<Record<string, CardEvidence>>
  outcomes: Readonly<Record<string, ApprovalOutcome>>
  answers: Readonly<Record<string, AnswerOutcome>>
  query: string
  search: Read<Page<SearchHit>>
  notice: CommandNotice | null
}

const NO_ACTIVITY: InspectionState['activity'] = { attemptId: null, read: { status: 'loading' } }

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

/** The artifact route refuses by design, so those answers are not a fault to report. */
function artifactFailure(error: unknown): string {
  if (error instanceof HttpError && error.status === 403) return 'The workbench does not serve this file.'
  if (error instanceof HttpError && error.status === 404) return 'This file is not there any more.'
  return readFailure(error)
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
  retrying: 'Asked once more. Anything that would leave this machine still comes to you as a card.',
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
    meta: { status: 'loading' },
    delivery: { id: null, read: { status: 'loading' } },
    task: { id: null, read: { status: 'loading' } },
    activity: NO_ACTIVITY,
    artifact: null,
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
  let readingActivity: AbortController | null = null
  let readingMeta: AbortController | null = null
  /** A frame landed during a read: one more read of the last page once that one ends. */
  let activityAgain = false
  /** The owner's choice of attempt. Null follows the latest. */
  let chosenAttempt: string | null = null
  let readingArtifact: AbortController | null = null
  let searching: AbortController | null = null
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  const settling = new Set<string>()
  const settledAsked = new Set<string>()

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
        // Evidence that cannot be confirmed is not kept as if current. No entry is what the card
        // shows: nothing to approve on, with a retry.
        const { [id]: _dropped, ...rest } = state.evidence
        set({ evidence: rest })
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

  const stopActivity = () => {
    readingActivity?.abort()
    readingActivity = null
    activityAgain = false
  }

  /** The last page read, which is where anything new lands: a stream's end has no next cursor. */
  const activityTail = (): string | null => readData(state.activity.read)?.tail ?? null

  const readActivity = (id: string, cursor: string | null) => {
    stopActivity()
    const controller = new AbortController()
    readingActivity = controller
    const live = () => readingActivity === controller
    within((signal) => client.activity(id, cursor, signal), controller.signal)
      .then((page) => {
        if (!live()) return
        const kept = readData(state.activity.read)?.items ?? []
        const seen = new Set(kept.map((item) => item.seq))
        const items = [...kept, ...page.items.filter((item) => !seen.has(item.seq))]
        const data = { items, tail: cursor, nextCursor: page.nextCursor }
        set({ activity: { attemptId: id, read: { status: 'ready', data, readAt: now() } } })
      })
      .catch((error: unknown) => {
        if (live()) set({ activity: { attemptId: id, read: failedRead(state.activity.read, error) } })
      })
      .then(() => {
        if (!live()) return
        readingActivity = null
        if (!activityAgain) return
        activityAgain = false
        readActivity(id, activityTail())
      })
  }

  /** Moves on from the last page, or leaves a read in flight to finish first. */
  const rereadActivity = (id: string) => {
    if (readingActivity !== null) activityAgain = true
    else readActivity(id, activityTail())
  }

  const showAttempt = (id: string | null) => {
    stopActivity()
    set({ activity: { attemptId: id, read: { status: 'loading' } } })
    if (id !== null) readActivity(id, null)
  }

  /** `coverage.activity` false means nothing is stored, so there is nothing to ask for. */
  const syncActivity = (detail: TaskDetail) => {
    const chosen = detail.attempts.find((attempt) => attempt.id === chosenAttempt)
    const shown = chosen ?? latestAttempt(detail.attempts)
    const id = detail.coverage.activity ? (shown?.id ?? null) : null
    if (id !== state.activity.attemptId) showAttempt(id)
    else if (id !== null) rereadActivity(id)
  }

  const closeArtifact = () => {
    readingArtifact?.abort()
    readingArtifact = null
    if (state.artifact !== null) set({ artifact: null })
  }

  const readArtifact = (attemptId: string, ref: string, cursor: string | null) => {
    readingArtifact?.abort()
    const controller = new AbortController()
    readingArtifact = controller
    const live = () => readingArtifact === controller
    within((signal) => client.artifact(attemptId, ref, cursor, signal), controller.signal)
      .then((page) => {
        if (!live()) return
        const kept = state.artifact === null ? null : readData(state.artifact.read)
        const data =
          page.kind === 'text' && cursor !== null && kept?.kind === 'text'
            ? { ...page, text: kept.text + page.text }
            : page
        set({ artifact: { attemptId, ref, read: { status: 'ready', data, readAt: now() } } })
      })
      .catch((error: unknown) => {
        if (!live()) return
        const previous = state.artifact?.read ?? { status: 'loading' as const }
        const kept = readData(previous)
        const readAt = previous.status === 'loading' ? null : previous.readAt
        const read = { status: 'failed' as const, message: artifactFailure(error), data: kept, readAt }
        set({ artifact: { attemptId, ref, read } })
      })
  }

  const readTask = (id: string) => {
    readingTask?.abort()
    const controller = new AbortController()
    readingTask = controller
    const live = () => readingTask === controller
    within((signal) => client.taskDetail(id, signal), controller.signal)
      .then((data) => {
        if (!live()) return
        set({ task: { id, read: { status: 'ready', data, readAt: now() } } })
        syncActivity(data)
      })
      .catch((error: unknown) => {
        if (live()) set({ task: { id, read: failedRead(state.task.read, error) } })
      })
  }

  const refreshMeta = () => {
    readingMeta?.abort()
    const controller = new AbortController()
    readingMeta = controller
    const live = () => readingMeta === controller
    within((signal) => client.meta(signal), controller.signal)
      .then((data) => {
        if (live()) set({ meta: { status: 'ready', data, readAt: now() } })
      })
      .catch((error: unknown) => {
        if (live()) set({ meta: failedRead(state.meta, error) })
      })
  }

  const refresh = () => {
    refreshMeta()
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
    refreshMeta,
    readEvidence,

    /**
     * Settled cards on show, each read once and one at a time: their evidence cannot change, and
     * a refresh only rereads the open ones. A read that fails waits for the card's own Retry.
     */
    async readSettledEvidence(ids: readonly string[]): Promise<void> {
      for (const id of ids) {
        if (settledAsked.has(id) || state.evidence[id] !== undefined) continue
        settledAsked.add(id)
        await readEvidence(id)
      }
    },

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
      stopActivity()
      chosenAttempt = null
      readingArtifact?.abort()
      readingArtifact = null
      set({ task: { id, read: { status: 'loading' } }, activity: NO_ACTIVITY, artifact: null })
      if (id !== null) readTask(id)
    },

    selectAttempt(id: string): void {
      chosenAttempt = id
      if (id === state.activity.attemptId) return
      closeArtifact()
      showAttempt(id)
    },

    moreActivity(): void {
      const { attemptId, read } = state.activity
      const next = readData(read)?.nextCursor ?? null
      if (attemptId !== null && next !== null) readActivity(attemptId, next)
    },

    retryActivity(): void {
      const { attemptId } = state.activity
      if (attemptId !== null) readActivity(attemptId, activityTail())
    },

    /** One compact frame's worth of work: the read it names, if that read is on show. */
    invalidate(stream: string): void {
      const { attemptId } = state.activity
      if (attemptId !== null && stream === `attempt:${attemptId}`) rereadActivity(attemptId)
    },

    /** The same file again closes it, so the link reads as a disclosure. */
    openArtifact(attemptId: string, ref: string): void {
      const open = state.artifact
      closeArtifact()
      if (open?.attemptId === attemptId && open.ref === ref) return
      set({ artifact: { attemptId, ref, read: { status: 'loading' } } })
      readArtifact(attemptId, ref, null)
    },

    moreArtifact(): void {
      const open = state.artifact
      const kept = open === null ? null : readData(open.read)
      if (open !== null && kept?.kind === 'text' && kept.nextCursor !== null) {
        readArtifact(open.attemptId, open.ref, kept.nextCursor)
      }
    },

    retryArtifact(): void {
      const open = state.artifact
      if (open === null) return
      const kept = readData(open.read)
      readArtifact(open.attemptId, open.ref, kept?.kind === 'text' ? kept.nextCursor : null)
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

    /** Retry, hold, lift and stop act on the item's own id, whatever is selected or filtered. */
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
