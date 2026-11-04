import { useEffect, useState } from 'react'
import { api, type WorkItem, type WorkItemDetail } from '../api'
import { useWorkbench } from '../workbench'
import { formatClock } from './base'
import type { StateKind } from './StateLabel'

/**
 * The Work board: every open piece of work grouped by whom it waits for
 * (§4). Rows open the work item in the context pane.
 */

export type WorkGroupKey = 'needs' | 'working' | 'waiting' | 'done'

const GROUPS: Array<{ key: WorkGroupKey; label: string }> = [
  { key: 'needs', label: 'Needs you' },
  { key: 'working', label: 'Working' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'done', label: 'Done today' },
]

/** Whom the item waits for, from the state the server serves. Unknown states land in Working, shown verbatim. */
export function groupOf(item: WorkItem): WorkGroupKey {
  if (item.state === 'blocked' || item.state === 'proposed') return 'needs'
  if (item.state === 'parked') return 'waiting'
  if (item.state === 'done' || item.state === 'stopped') return 'done'
  return 'working'
}

export function stateKindOf(state: string): { kind: StateKind; label: string } {
  switch (state) {
    case 'healthy':
      return { kind: 'ok', label: 'Healthy' }
    case 'near_window':
      return { kind: 'warn', label: 'Near its window' }
    case 'parked':
      return { kind: 'warn', label: 'Parked' }
    case 'degraded':
      return { kind: 'warn', label: 'Degraded' }
    case 'login_expired':
      return { kind: 'attn', label: 'Login expired' }
    case 'key_rejected':
      return { kind: 'bad', label: 'Key rejected' }
    case 'unsupported':
      return { kind: 'bad', label: 'Engine unsupported' }
    case 'retired':
      return { kind: 'done', label: 'Retired' }
    default:
      return { kind: 'none', label: state }
  }
}

function rowStateOf(item: WorkItem): { kind: StateKind; label: string } {
  if (item.state === 'blocked') return { kind: 'attn', label: 'Needs your approval' }
  if (item.state === 'parked') return { kind: 'warn', label: 'Waiting for quota' }
  if (item.state === 'done') return { kind: 'done', label: 'Done' }
  if (item.state === 'stopped') return { kind: 'done', label: 'Stopped by you' }
  if (item.state === 'executing') return { kind: 'none', label: 'Working' }
  if (item.state === 'planning') return { kind: 'none', label: 'Planning' }
  if (item.state === 'reviewing') return { kind: 'none', label: 'In review' }
  if (item.state === 'integrating') return { kind: 'none', label: 'Integrating' }
  return { kind: 'none', label: item.state }
}

export function WorkBoard({ items }: { items: WorkItem[] }) {
  const groups = GROUPS.map((group) => ({
    ...group,
    rows: items.filter((item) => groupOf(item) === group.key),
  })).filter((group) => group.rows.length > 0)
  if (groups.length === 0) {
    return (
      <div className="empty">
        <p>No work yet. Send the first request from Chat — it becomes a work item with a plan.</p>
      </div>
    )
  }
  return (
    <>
      {groups.map((group) => (
        <section className="group" key={group.key}>
          <h2 className="group-title">
            {group.label}{' '}
            <span className={`count${group.key === 'needs' ? ' count-attention' : ''}`}>
              {group.rows.length}
            </span>
          </h2>
          <ul className={`rows${group.key === 'done' ? ' rows-quiet' : ''}`}>
            {group.rows.map((item) => (
              <WorkRow item={item} key={item.id} />
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

export function WorkRow({ item }: { item: WorkItem }) {
  const wb = useWorkbench()
  const [detail, setDetail] = useState<WorkItemDetail | null>(null)
  const known = detail !== null && detail.absent !== true
  const state = rowStateOf(item)

  useEffect(() => {
    let alive = true
    api
      .workItemDetail(item.id)
      .then((d) => {
        if (alive) setDetail(d)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [item.id])

  const open = () => wb.openContext({ kind: 'work', id: item.id })

  const active = item.taskCounts.byStatus.active ?? 0
  const sub = known
    ? (detail?.tasks.length ?? 0) > 0
      ? `${state.label} · ${active} of ${item.taskCounts.total} tasks running`
      : state.label
    : `${state.label} · ${item.taskCounts.total} task${item.taskCounts.total === 1 ? '' : 's'}`

  return (
    <li
      className="row"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: design spec §6 — a work row is focusable and opens the work item in the pane on Enter.
      tabIndex={0}
      onClick={() => open()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.target as HTMLElement).closest('button') === null) {
          event.preventDefault()
          open()
        }
      }}
    >
      <div className="row-main">
        <p className="row-title">{known ? detail?.title : <span className="mono">{item.id}</span>}</p>
        <p className="row-sub">{sub}</p>
      </div>
      <div className="row-side">
        <span className={`state${state.kind === 'none' ? '' : ` state-${state.kind}`}`}>{state.label}</span>
        <p className="row-meta">
          {formatClock(item.updatedAt)}
          {item.state === 'parked' ? (
            <>
              {' '}
              <button
                type="button"
                className="link"
                onClick={(event) => {
                  event.stopPropagation()
                  wb.openSheet({ kind: 'switch', itemId: item.id })
                }}
              >
                Switch slot
              </button>
            </>
          ) : null}
        </p>
      </div>
    </li>
  )
}
