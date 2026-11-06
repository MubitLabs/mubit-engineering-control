import { useCallback, useEffect, useState } from 'react'
import { api, type StatusSnapshot } from '../api'
import { capabilityGate } from '../next/config-model'
import type { PauseControl } from '../next/Sidebar'

const PAUSE_POLL_MS = 10_000

type Processing = { paused: boolean; pausedAt?: string }

/** §20, #21: the state comes from the server at startup and after every press; never assumed. */
export function usePause(): PauseControl {
  const [processing, setProcessing] = useState<Processing | null>(null)
  const [failed, setFailed] = useState(false)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const refresh = useCallback(() => {
    api
      .processing()
      .then((next) => {
        setProcessing(next)
        setFailed(false)
      })
      .catch(() => setFailed(true))
  }, [])

  useEffect(() => {
    refresh()
    api
      .status()
      .then((status: StatusSnapshot & { capabilities?: { pause?: unknown } }) =>
        setAvailable(status.capabilities?.pause === true),
      )
      .catch(() => setAvailable(false))
    const timer = setInterval(refresh, PAUSE_POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const gate = capabilityGate(
    {
      pause: available === true,
      switchWork: false,
      drain: false,
      backups: false,
      isolationEdit: false,
    },
    'pause',
  )
  const paused = processing?.paused === true
  return {
    state: failed || processing === null ? 'unknown' : paused ? 'paused' : 'running',
    busy,
    ...(processing?.pausedAt !== undefined && { pausedAt: processing.pausedAt }),
    ...(!gate.enabled && available !== null && { unavailable: gate.reason }),
    ...(error !== undefined && { error }),
    onToggle: () => {
      setBusy(true)
      setError(undefined)
      ;(paused ? api.resumeProcessing() : api.pauseProcessing())
        .then(refresh)
        .catch(() => setError(paused ? 'Could not resume. Still paused.' : 'Could not pause. Still running.'))
        .finally(() => setBusy(false))
    },
  }
}
