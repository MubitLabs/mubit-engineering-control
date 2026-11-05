import type { ServerEvent } from '../api'

/**
 * One merged SSE connection that survives a failure. Native reconnect replays the `after` in the
 * URL it was opened with, so on `error` this closes the source and opens a new one from the
 * cursors it has applied. `event: reset` means the server no longer has that history; the
 * connection closes and the caller takes a snapshot and subscribes again.
 */

const REOPEN_MIN_MS = 1_000
const REOPEN_MAX_MS = 30_000

export interface StreamHooks {
  onReset?: () => void
  /** A connection came back after a failure, so anything missed needs reading. */
  onReopen?: () => void
}

export function subscribeResumable(
  subscriptions: ReadonlyArray<{ stream: string; after: number }>,
  onEvent: (event: ServerEvent) => void,
  hooks: StreamHooks = {},
): () => void {
  if (subscriptions.length === 0) return () => {}
  const cursors = new Map(subscriptions.map(({ stream, after }) => [stream, after]))
  let source: EventSource | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let delay = REOPEN_MIN_MS
  let failed = false

  const closeSource = () => {
    source?.close()
    source = null
  }

  const open = () => {
    const streams = [...cursors.keys()]
    const after = [...cursors.values()]
    const current = new EventSource(
      `/api/events?stream=${encodeURIComponent(streams.join(','))}&after=${after.join(',')}`,
    )
    source = current
    current.onopen = () => {
      delay = REOPEN_MIN_MS
      if (failed) {
        failed = false
        hooks.onReopen?.()
      }
    }
    current.onmessage = (message) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(message.data)
      } catch {
        return
      }
      if (typeof parsed !== 'object' || parsed === null) return
      const event = parsed as ServerEvent
      if (typeof event.seq !== 'number') return
      const stream = typeof event.stream === 'string' ? event.stream : null
      if (stream !== null) {
        if (event.seq <= (cursors.get(stream) ?? 0)) return
        cursors.set(stream, event.seq)
      }
      onEvent(event)
    }
    current.onerror = () => {
      closeSource()
      failed = true
      timer = setTimeout(open, delay)
      delay = Math.min(delay * 2, REOPEN_MAX_MS)
    }
    current.addEventListener('reset', () => {
      closeSource()
      hooks.onReset?.()
    })
  }

  open()
  return () => {
    clearTimeout(timer)
    closeSource()
  }
}
