import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { api, type StatusSnapshot } from '../api'
import { capabilityGate } from '../next/config-model'
import type { PauseControl } from '../next/Sidebar'

const PAUSE_POLL_MS = 10_000

type Processing = { paused: boolean; pausedAt?: string }

export interface PauseClient {
  read(): Promise<Processing>
  pause(): Promise<{ status: string; pausedAt?: string }>
  resume(): Promise<{ status: string }>
}

export interface PauseState {
  processing: Processing | null
  failed: boolean
  busy: boolean
  error: string | undefined
}

/**
 * §20, #21: the state comes from the server at startup and after every press; never assumed. A
 * press's own answer is the server's word, so it shows at once. A read that began before a press
 * knows less than that answer and is dropped. Plain, so that race runs in a test with no browser.
 */
export function createPause(client: PauseClient) {
  let state: PauseState = { processing: null, failed: false, busy: false, error: undefined }
  let presses = 0
  const watchers = new Set<() => void>()
  const set = (patch: Partial<PauseState>) => {
    state = { ...state, ...patch }
    for (const watcher of watchers) watcher()
  }

  const refresh = async (): Promise<void> => {
    const began = presses
    try {
      const processing = await client.read()
      if (began === presses) set({ processing, failed: false })
    } catch {
      if (began === presses) set({ failed: true })
    }
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
    async toggle(paused: boolean): Promise<void> {
      presses += 1
      set({ busy: true, error: undefined })
      try {
        if (paused) {
          await client.resume()
          set({ processing: { paused: false }, failed: false, busy: false })
        } else {
          const { pausedAt } = await client.pause()
          const processing = { paused: true, ...(pausedAt !== undefined && { pausedAt }) }
          set({ processing, failed: false, busy: false })
        }
        void refresh()
      } catch {
        const error = paused ? 'Could not resume. Still paused.' : 'Could not pause. Still running.'
        set({ error, busy: false })
      }
    },
  }
}

const livePause = (): ReturnType<typeof createPause> =>
  createPause({
    read: () => api.processing(),
    pause: () => api.pauseProcessing(),
    resume: () => api.resumeProcessing(),
  })

export function usePause(): PauseControl {
  const pause = useMemo(livePause, [])
  const { processing, failed, busy, error } = useSyncExternalStore(pause.subscribe, pause.getState)
  const [available, setAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    void pause.refresh()
    api
      .status()
      .then((status: StatusSnapshot & { capabilities?: { pause?: unknown } }) =>
        setAvailable(status.capabilities?.pause === true),
      )
      .catch(() => setAvailable(false))
    const timer = setInterval(() => void pause.refresh(), PAUSE_POLL_MS)
    return () => clearInterval(timer)
  }, [pause])

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
    onToggle: () => void pause.toggle(paused),
  }
}
