import { useEffect, useRef, useState } from 'react'
import type { Approval } from '../../api/types'

const KEY = 'mec.notify'

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on'
  } catch {
    return false
  }
}

/** Opt-in desktop notifications; the browser asks for permission only when the user turns them on. */
export function useNotificationSetting() {
  const supported = typeof window !== 'undefined' && 'Notification' in window
  const [on, setOn] = useState(() => supported && stored() && Notification.permission === 'granted')
  const set = async (next: boolean) => {
    if (
      next &&
      Notification.permission !== 'granted' &&
      (await Notification.requestPermission()) !== 'granted'
    )
      return
    try {
      localStorage.setItem(KEY, next ? 'on' : 'off')
    } catch {}
    setOn(next)
  }
  return { supported, denied: supported && Notification.permission === 'denied', on, set }
}

/** Notifies about decisions that arrive while this tab is in the background. */
export function useDecisionNotifications(approvals: Approval[] | undefined, open: () => void) {
  const seen = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!approvals) return
    const ids = new Set(approvals.map((a) => a.id))
    const fresh = seen.current ? approvals.filter((a) => !seen.current!.has(a.id)) : []
    seen.current = ids
    if (fresh.length === 0 || !document.hidden || !('Notification' in window)) return
    if (Notification.permission !== 'granted' || !stored()) return
    const first = fresh[0]!
    const n = new Notification(
      fresh.length === 1 ? 'A decision is waiting' : `${fresh.length} decisions are waiting`,
      {
        body: first.title,
        tag: first.id,
      },
    )
    n.onclick = () => {
      window.focus()
      open()
      n.close()
    }
  }, [approvals, open])
}
