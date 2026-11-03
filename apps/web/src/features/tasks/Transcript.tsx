import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { Empty } from '../../components/ui'

interface AttemptEvent {
  id: number
  type: string
  actorKind: string
  payload: Record<string, unknown>
  occurredAt: string
  sourceSequence: number | null
  sourceGeneration: number | null
}

/** The attempt's durable event log rendered as a terminal-style transcript. */
export function Transcript({ attemptId }: { attemptId: string }) {
  const q = useQuery({
    queryKey: ['attempt', attemptId, 'events'],
    queryFn: () => api.get<{ events: AttemptEvent[] }>(`/api/attempts/${attemptId}/events`),
  })
  const [everything, setEverything] = useState(false)
  const feed = useRef<HTMLDivElement>(null)
  const events = q.data?.events ?? []
  const shown = everything ? events : events.filter((e) => !isBookkeeping(e))
  // Follow new events inside the feed only; scrollIntoView would also scroll the page.
  useEffect(() => {
    const el = feed.current
    if (el && shown.length > 0) el.scrollTop = el.scrollHeight
  }, [shown.length])

  if (!q.data) return null
  if (events.length === 0) return <Empty>No events yet.</Empty>
  const hidden = events.length - shown.length
  return (
    <div>
      <div className="spread small faint" style={{ padding: '4px 12px' }}>
        <span>{everything ? 'all events' : 'agent, decisions and checks'}</span>
        {(hidden > 0 || everything) && (
          <button type="button" className="linklike" onClick={() => setEverything(!everything)}>
            {everything ? 'hide bookkeeping' : `show ${hidden} bookkeeping events`}
          </button>
        )}
      </div>
      <div className="feed" ref={feed} style={{ maxHeight: 520 }}>
        {shown.map((e) => (
          <div className="feed-row" key={e.id}>
            <span className="faint">{e.sourceSequence ?? '·'}</span>
            <Line event={e} />
          </div>
        ))}
      </div>
    </div>
  )
}

const BOOKKEEPING = new Set([
  'attempt.created',
  'attempt.preparing',
  'attempt.started',
  'attempt.input_resolved',
  'attempt.message_requested',
  'attempt.interrupt_requested',
  'attempt.checks_started',
  'decision.received',
  'agent.log',
])

/** Lease, workspace and delivery plumbing: useful when debugging, noise when reviewing. */
function isBookkeeping(e: AttemptEvent): boolean {
  if (e.type === 'workspace.push_failed') return false
  if (BOOKKEEPING.has(e.type) || e.type.startsWith('workspace.') || e.type.startsWith('command.')) return true
  if (e.type === 'attempt.state_changed') {
    const to = String(e.payload.to)
    return ['leased', 'preparing', 'running', 'checking', 'work_complete'].includes(to)
  }
  return false
}

function Line({ event: e }: { event: AttemptEvent }) {
  const p = e.payload
  switch (e.type) {
    case 'agent.message':
      return (
        <span>
          <span className={p.role === 'user' ? 'feed-type' : 'muted'}>
            {p.role === 'user' ? 'you ›' : 'agent ›'}
          </span>{' '}
          <span style={{ whiteSpace: 'pre-wrap' }}>{String(p.text ?? '')}</span>
        </span>
      )
    case 'agent.tool_use':
      return (
        <span>
          <span className="feed-type">▸ {String(p.name)}</span>{' '}
          <span className="muted">{JSON.stringify(p.input ?? {}).slice(0, 300)}</span>
        </span>
      )
    case 'agent.tool_result':
      return (
        <span className="muted">
          ◂ {String(p.name ?? 'tool')} {p.ok === false ? 'failed' : 'ok'}
        </span>
      )
    case 'agent.log':
      return <span className="faint">{String(p.line ?? '')}</span>
    case 'attempt.state_changed':
      return (
        <span className="faint">
          state {String(p.from)} → <strong>{String(p.to)}</strong> ({String(p.event)})
        </span>
      )
    default:
      return (
        <span>
          <span className="feed-type">{e.type}</span> <span className="muted">{summarise(p)}</span>
          {p.fenced ? <span className="status err"> fenced</span> : null}
        </span>
      )
  }
}

function summarise(p: Record<string, unknown>): string {
  return Object.entries(p)
    .filter(([, v]) => v !== null && typeof v !== 'object')
    .slice(0, 5)
    .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
    .join(' ')
}
