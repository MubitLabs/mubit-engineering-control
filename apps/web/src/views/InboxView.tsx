import { useCallback, useEffect, useState } from 'react'
import { api, type InboxItem, isAlreadyHandled, type ResolveAnswer } from '../api'
import { Button, Card, EmptyState } from '../components/ui'
import { usePolling } from '../usePolling'

function remainingMsOf(expiresAt: string): number {
  const ms = new Date(expiresAt).getTime() - Date.now()
  return Number.isNaN(ms) ? 0 : ms
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return '0s'
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** Re-computes the time left once per second. */
function useCountdown(expiresAt: string): number {
  const [remainingMs, setRemainingMs] = useState(() => remainingMsOf(expiresAt))

  useEffect(() => {
    setRemainingMs(remainingMsOf(expiresAt))
    const timer = setInterval(() => setRemainingMs(remainingMsOf(expiresAt)), 1000)
    return () => clearInterval(timer)
  }, [expiresAt])

  return remainingMs
}

export type DecisionCardProps = {
  item: InboxItem
  onResolved: (id: string) => void
}

/** §12.6 decision card: Approve/Deny hit POST /api/inbox/:id/resolve. */
export function DecisionCard({ item, onResolved }: DecisionCardProps) {
  const remainingMs = useCountdown(item.expiresAt)
  const [busy, setBusy] = useState<ResolveAnswer | null>(null)
  const [handledElsewhere, setHandledElsewhere] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const expired = remainingMs <= 0

  const resolve = useCallback(
    async (answer: ResolveAnswer) => {
      setBusy(answer)
      setNote(null)
      try {
        await api.resolve(item.id, answer)
        onResolved(item.id)
      } catch (error) {
        if (isAlreadyHandled(error)) {
          setHandledElsewhere(true)
          setNote('already resolved by someone else')
        } else {
          setNote('could not reach the runtime — try again')
        }
      } finally {
        setBusy(null)
      }
    },
    [item.id, onResolved],
  )

  return (
    <Card>
      <h3 className="card-title">{item.cls}</h3>
      <p className="card-detail mono">{item.operationHash}</p>
      <details className="evidence">
        <summary>Evidence</summary>
        <p className="mono">operation {item.operationHash}</p>
      </details>
      <div className="card-actions">
        <Button
          disabled={busy !== null || expired || handledElsewhere}
          onClick={() => void resolve('approve')}
          variant="primary"
        >
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </Button>
        <Button disabled={busy !== null || expired || handledElsewhere} onClick={() => void resolve('deny')}>
          {busy === 'deny' ? 'Denying…' : 'Deny'}
        </Button>
        <span className={expired ? 'countdown countdown-expired' : 'countdown'}>
          {expired ? 'expired' : `expires in ${formatRemaining(remainingMs)}`}
        </span>
        {note === null ? null : <span className="error-note">{note}</span>}
      </div>
    </Card>
  )
}

export function InboxView() {
  const [items, setItems] = useState<InboxItem[]>([])

  const refresh = useCallback(() => {
    api
      .inbox()
      .then(setItems)
      .catch(() => {})
  }, [])
  usePolling(refresh, 5000)

  return (
    <div className="view">
      <h2 className="view-title">Inbox</h2>
      {items.length === 0 ? (
        <EmptyState>Confirmations and questions appear here, newest first</EmptyState>
      ) : (
        items.map((item) => (
          <DecisionCard
            item={item}
            key={item.id}
            onResolved={(id) => setItems((current) => current.filter((entry) => entry.id !== id))}
          />
        ))
      )}
    </div>
  )
}
