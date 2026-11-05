import { type DependencyList, useCallback, useEffect, useState } from 'react'
import { isNotServed } from '../api'
import { Btn } from './base'

/**
 * A read with a finite life: loading, then ready or failed — never "Loading…" forever. A failure
 * says what happened in words and offers Retry, and leaves the rest of the shell untouched.
 */
export type Load<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; message: string }

export function failureMessage(error: unknown): string {
  if (isNotServed(error)) return 'The server does not serve this yet.'
  if (error instanceof Error) return error.message
  return 'The request failed.'
}

/** Runs `load` on mount and whenever `deps` change; `retry` runs it again. Stale answers are dropped. */
export function useLoad<T>(load: () => Promise<T>, deps: DependencyList): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` is the caller's dependency list by contract; `attempt` re-runs on Retry.
  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    load().then(
      (value) => {
        if (alive) setState({ status: 'ready', value })
      },
      (error: unknown) => {
        if (alive) setState({ status: 'error', message: failureMessage(error) })
      },
    )
    return () => {
      alive = false
    }
  }, [...deps, attempt])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return [state, retry]
}

/** The failed state: the reason, and Retry. `role="alert"` so it is announced where it appears. */
export function LoadFailed({
  what,
  message,
  onRetry,
}: {
  what: string
  message: string
  onRetry: () => void
}) {
  return (
    <div className="empty" role="alert" data-load-failed>
      <p>
        Could not load {what}. {message}
      </p>
      <p>
        <Btn variant="quiet" onClick={onRetry}>
          Try again
        </Btn>
      </p>
    </div>
  )
}
