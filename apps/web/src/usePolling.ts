import { useEffect } from 'react'

/**
 * Runs `task` immediately and then every `intervalMs`. Pass a stable callback
 * (useCallback) so the interval is not reset on every render.
 */
export function usePolling(task: () => void, intervalMs: number): void {
  useEffect(() => {
    task()
    const timer = setInterval(task, intervalMs)
    return () => clearInterval(timer)
  }, [task, intervalMs])
}
