import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type ChatMessage, newIdempotencyKey } from '../api'
import { Button, Card, EmptyState } from '../components/ui'
import { routeToHash } from '../router'
import { useWorkItemContext, workItemContext } from '../state'
import { usePolling } from '../usePolling'

/** A server message, or an optimistic row still waiting on its POST. */
type ChatRow = ChatMessage & { pending?: boolean }

function formatClock(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour12: false })
}

/** Clicking a message's work-item chip points the next reply at that item. */
function WorkItemChip({ workItemId }: { workItemId: string }) {
  return (
    <button className="chip" onClick={() => workItemContext.set(workItemId)} type="button">
      {workItemId}
    </button>
  )
}

export function ChatView() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [pendingRows, setPendingRows] = useState<ChatRow[]>([])
  const [inboxCount, setInboxCount] = useState(0)
  const [draft, setDraft] = useState('')
  const [idemKey, setIdemKey] = useState(() => newIdempotencyKey())
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const replyTo = useWorkItemContext()
  const listRef = useRef<HTMLUListElement | null>(null)

  const refresh = useCallback(async () => {
    const [freshMessages, inbox] = await Promise.all([api.chat(), api.inbox()])
    setMessages(freshMessages)
    setInboxCount(inbox.length)
  }, [])

  const poll = useCallback(() => {
    refresh().catch(() => {})
  }, [refresh])
  usePolling(poll, 3000)

  const rows: ChatRow[] = [...messages, ...pendingRows]

  useEffect(() => {
    const list = listRef.current
    if (list !== null && rows.length > 0) list.scrollTop = list.scrollHeight
  }, [rows.length])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (text === '' || sending) return
    const optimistic: ChatRow = {
      id: `pending:${idemKey}`,
      text,
      at: new Date().toISOString(),
      pending: true,
      ...(replyTo === null ? {} : { workItemId: replyTo }),
    }
    setSending(true)
    setSendError(null)
    setDraft('')
    setPendingRows((current) => [...current, optimistic])
    try {
      await api.sendChat(text, replyTo === null ? undefined : replyTo, idemKey)
      setPendingRows((current) => current.filter((row) => row.id !== optimistic.id))
      setIdemKey(newIdempotencyKey())
      setSending(false)
      await refresh().catch(() => {})
    } catch {
      // Keep the draft and its idempotency key so a retry stays idempotent.
      setPendingRows((current) => current.filter((row) => row.id !== optimistic.id))
      setDraft(text)
      setSendError('send failed — try again')
      setSending(false)
    }
  }, [draft, idemKey, refresh, replyTo, sending])

  return (
    <div className="chat">
      <Card>
        {inboxCount > 0 ? (
          <a className="inbox-strip" href={routeToHash('inbox')}>
            {inboxCount} {inboxCount === 1 ? 'decision' : 'decisions'} waiting — open the inbox
          </a>
        ) : (
          <EmptyState>No decisions waiting</EmptyState>
        )}
      </Card>
      <div className="messages">
        {rows.length === 0 ? (
          <EmptyState>No messages yet — the meta agent will answer here</EmptyState>
        ) : (
          <ul className="message-list" ref={listRef}>
            {rows.map((row) => (
              <li className={row.pending === true ? 'msg msg-pending' : 'msg'} key={row.id}>
                <div className="msg-text">{row.text}</div>
                <div className="msg-meta">
                  <span className="mono">{formatClock(row.at)}</span>
                  {row.workItemId === undefined ? null : <WorkItemChip workItemId={row.workItemId} />}
                  {row.pending === true ? <span className="mono">sending…</span> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="composer-aux">
        {replyTo === null ? null : (
          <button className="chip" onClick={() => workItemContext.set(null)} type="button">
            reply-to: {replyTo} ×
          </button>
        )}
        {sendError === null ? null : <span className="error-note">{sendError}</span>}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <input
          aria-label="message"
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
          placeholder="message the meta agent"
          type="text"
          value={draft}
        />
        <Button disabled={sending} type="submit" variant="primary">
          Send
        </Button>
      </form>
    </div>
  )
}
