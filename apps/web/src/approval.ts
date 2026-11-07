/**
 * The approval key on this side (apps/desktop/src/approval.ts). It lives in `sessionStorage`, which
 * is this tab's and this origin's and so survives a reload and not another port's page: a cookie
 * would go to every port on 127.0.0.1, a repository's own dev server among them.
 *
 * A key is got from a one-time code in the fragment of a link the server opened, which is scrubbed
 * from the address at once. Other tabs of this origin share it over a channel, so the tab the owner
 * was using carries on after the new one opened. A restart mints a new key: the server refuses the
 * old one with `approval_required`, this forgets it, and the page offers a new link.
 */

export const APPROVAL_HEADER = 'x-mec-approval'
const STORED = 'mec.approval-key'
const CHANNEL = 'mec-approval'
const PAIR = /^#pair=([0-9a-f]{64})$/

const listeners = new Set<() => void>()
const changed = (): void => {
  for (const listener of listeners) listener()
}

/** Storage can throw in a locked-down browser: no key then, and the page says what is missing. */
export function approvalKey(): string | null {
  try {
    return window.sessionStorage.getItem(STORED)
  } catch {
    return null
  }
}

function remember(key: string): void {
  try {
    window.sessionStorage.setItem(STORED, key)
  } catch {
    // Kept nowhere else on purpose. The next answer is refused and the page offers a link.
  }
  changed()
}

export function forgetApprovalKey(): void {
  try {
    window.sessionStorage.removeItem(STORED)
  } catch {
    // Nothing was kept.
  }
  changed()
}

export const onApprovalChange = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const channel = (): BroadcastChannel | undefined =>
  typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(CHANNEL)

/** Runs once, before a shell mounts: takes a code off the address, and joins the other tabs. */
export async function startApproval(): Promise<void> {
  const tabs = channel()
  if (tabs !== undefined) {
    tabs.onmessage = ({ data }: MessageEvent<{ key?: string; ask?: true }>) => {
      const held = approvalKey()
      if (data.ask === true && held !== null) tabs.postMessage({ key: held })
      if (typeof data.key === 'string') remember(data.key)
    }
  }
  const code = PAIR.exec(window.location.hash)?.[1]
  if (code === undefined) {
    if (approvalKey() === null) tabs?.postMessage({ ask: true })
    return
  }
  // Scrubbed first: a failed redeem has spent the code either way.
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  const response = await fetch('/api/approval/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mec-client': '1' },
    body: JSON.stringify({ code }),
  }).catch(() => undefined)
  if (response?.ok !== true) return
  const { key } = (await response.json()) as { key: string }
  remember(key)
  tabs?.postMessage({ key })
}

/** Asks the server to open a link. The answer says nothing of the code, only whether one opened. */
export async function requestApprovalLink(): Promise<boolean> {
  const response = await fetch('/api/approval/link', { method: 'POST', headers: { 'x-mec-client': '1' } })
  return response.ok
}
