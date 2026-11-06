import { useCallback, useEffect, useState } from 'react'
import { HttpError } from '../api'
import { configApi } from '../api-config'
import type { Capabilities, ConnectionRow, ParkedRow } from '../next/config-model'
import { switchRefusal, switchResult } from '../next/config-model'
import { failureText } from './failure'

const PARKED_POLL_MS = 10_000

export interface ParkedRead {
  rows: ParkedRow[]
  connections: ConnectionRow[]
  capabilities: Capabilities | null
  refresh: () => void
}

/** §5.10: a failed read keeps what is shown; a notice appears only from the server's own rows. */
export function useParked(active: boolean): ParkedRead {
  const [read, setRead] = useState<Omit<ParkedRead, 'refresh'>>({
    rows: [],
    connections: [],
    capabilities: null,
  })
  const refresh = useCallback(() => {
    Promise.all([configApi.parked(), configApi.connections(), configApi.capabilities()])
      .then(([rows, connections, capabilities]) =>
        setRead({ rows, connections: connections.rows, capabilities }),
      )
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (!active) return
    refresh()
    const timer = setInterval(refresh, PARKED_POLL_MS)
    return () => clearInterval(timer)
  }, [active, refresh])
  return { ...read, refresh }
}

/** The route's answer in words: a refusal is the server's reason, never a claim that it moved. */
export const switchWork = (row: ParkedRow, target: ConnectionRow): Promise<string> =>
  configApi
    .switchWork(row.workItemId, target.id)
    .then((answer) => switchResult(answer, target))
    .catch((error: unknown) =>
      error instanceof HttpError && error.status === 409 && error.reason !== undefined
        ? switchRefusal(error.reason)
        : failureText(error),
    )
