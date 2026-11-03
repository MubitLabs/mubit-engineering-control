import { useCallback, useState } from 'react'
import { api, type WorkItem } from '../api'
import { EmptyState } from '../components/ui'
import { routeToHash } from '../router'
import { workItemContext } from '../state'
import { usePolling } from '../usePolling'

const COLUMNS = ['ready', 'active', 'awaiting_review'] as const

function formatWhen(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString([], { hour12: false })
}

/** Clicking a card points the chat's next message at that work item. */
function WorkCard({ item, onOpen }: { item: WorkItem; onOpen: (id: string) => void }) {
  const counts = item.taskCounts
  return (
    <button className="work-card" onClick={() => onOpen(item.id)} type="button">
      <span className="work-card-title mono">{item.id}</span>
      <span className="work-card-meta">
        <span>{formatWhen(item.createdAt)}</span>
        <span className="mono">
          {counts.ready}/{counts.active}/{counts.awaiting_review}/{counts.integrated}
        </span>
      </span>
    </button>
  )
}

export function WorkView() {
  const [items, setItems] = useState<WorkItem[]>([])

  const refresh = useCallback(() => {
    api
      .work()
      .then(setItems)
      .catch(() => {})
  }, [])
  usePolling(refresh, 5000)

  const openInChat = (id: string) => {
    workItemContext.set(id)
    window.location.hash = routeToHash('chat')
  }

  return (
    <div className="view">
      <h2 className="view-title">Work</h2>
      {items.length === 0 ? <EmptyState>No work items</EmptyState> : null}
      <div className="board">
        {COLUMNS.map((column) => {
          const columnItems = items.filter((item) => item.stage === column)
          return (
            <section className="board-col" key={column}>
              <h3 className="board-col-title">
                {column.replace('_', ' ')} · {columnItems.length}
              </h3>
              {columnItems.map((item) => (
                <WorkCard item={item} key={item.id} onOpen={openInChat} />
              ))}
            </section>
          )
        })}
      </div>
    </div>
  )
}
