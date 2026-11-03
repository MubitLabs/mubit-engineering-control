import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { StoredEvent } from './types'

/**
 * Subscribes to a project's event stream. The browser's EventSource resends Last-Event-ID on
 * reconnect, so the server replays exactly what was missed. Every event invalidates cached queries
 * for the affected resources; the server stays the source of truth. `fromNow` skips history for
 * listeners that only need to hear about changes.
 */
export function useProjectEvents(
  projectId: string | undefined,
  onEvent?: (e: StoredEvent) => void,
  opts: { fromNow?: boolean } = {},
) {
  const { fromNow = false } = opts
  const qc = useQueryClient()
  const [connected, setConnected] = useState(false)
  const handler = useRef(onEvent)
  handler.current = onEvent

  useEffect(() => {
    if (!projectId) return
    const source = new EventSource(`/api/projects/${projectId}/events${fromNow ? '?from=now' : ''}`)
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    source.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as StoredEvent
      handler.current?.(event)
      invalidateFor(qc, event, projectId)
    }
    return () => {
      source.close()
      setConnected(false)
    }
  }, [projectId, fromNow, qc])

  return { connected }
}

function invalidateFor(qc: QueryClient, event: StoredEvent, projectId: string | null) {
  if (projectId) qc.invalidateQueries({ queryKey: ['project', projectId] })
  if (event.deliveryId) qc.invalidateQueries({ queryKey: ['delivery', event.deliveryId] })
  if (event.taskId) qc.invalidateQueries({ queryKey: ['task', event.taskId] })
  if (event.attemptId) qc.invalidateQueries({ queryKey: ['attempt', event.attemptId] })
  if (event.type.startsWith('approval.')) qc.invalidateQueries({ queryKey: ['approvals'] })
  if (event.type.startsWith('runner.')) qc.invalidateQueries({ queryKey: ['fleet'] })
}

/**
 * One connection for every project the user can see, keeping the inbox and open pages current.
 * `scope` changes (projects joined or created) reopen it; the server resumes from Last-Event-ID.
 */
export function useLiveEvents(scope: string | null): { connected: boolean } {
  const qc = useQueryClient()
  const [connected, setConnected] = useState(true)
  useEffect(() => {
    if (scope === null) return
    const source = new EventSource('/api/events/live')
    let lost = false
    source.onopen = () => {
      setConnected(true)
      // Anything may have changed while the stream was down.
      if (lost) qc.invalidateQueries()
      lost = false
    }
    source.onerror = () => {
      lost = true
      setConnected(false)
    }
    source.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as StoredEvent
      invalidateFor(qc, event, event.projectId)
    }
    return () => source.close()
  }, [scope, qc])
  return { connected }
}
