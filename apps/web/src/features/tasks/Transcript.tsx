import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
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
  const feed = useRef<HTMLDivElement>(null)
  const count = q.data?.events.length ?? 0
  // Follow new events inside the feed only; scrollIntoView would also scroll the page.
  useEffect(() => {
    const el = feed.current
    if (el && count > 0) el.scrollTop = el.scrollHeight
  }, [count])

  if (!q.data) return null
  if (q.data.events.length === 0) return <Empty>No events yet.</Empty>
  return (
    <div className="feed" ref={feed} style={{ maxHeight: 520 }}>
      {q.data.events.map((e) => (
        <div className="feed-row" key={e.id}>
          <span className="faint">{e.sourceSequence ?? '·'}</span>
          <Line event={e} />
        </div>
      ))}
    </div>
  )
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
