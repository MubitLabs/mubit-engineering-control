import type { ReactNode } from 'react'
import { Button, ChevronIcon, Status, type StatusTone } from './primitives'
import type { MetaStatusView, OpenWorkView } from './work-model'

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        <h1 tabIndex={-1}>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </header>
  )
}

export function UserMessage({ children }: { children: ReactNode }) {
  return (
    <div className="message message-user">
      <span className="sr-only">You said: </span>
      <p>{children}</p>
    </div>
  )
}

export function AgentMessage({ children }: { children: ReactNode }) {
  return (
    <div className="message message-agent">
      <span className="byline">Meta agent</span>
      <p>{children}</p>
    </div>
  )
}

export function ActivityNote({ children }: { children: ReactNode }) {
  return <p className="activity-note">{children}</p>
}

/** What the meta agent is doing. Text only: nothing here animates, so nothing can fake progress. */
export function MetaLine({ view }: { view: MetaStatusView }) {
  return (
    <section className="meta-line" aria-label="Meta agent status" aria-live="polite">
      <Status tone={view.tone}>{view.headline}</Status>
      <small>{[view.connection, view.when].filter((part) => part !== '').join(' · ')}</small>
    </section>
  )
}

/** Every open delivery stays in sight here, whatever was asked last. */
export function OpenWork({ rows, onOpen }: { rows: readonly OpenWorkView[]; onOpen: (id: string) => void }) {
  return (
    <section className="open-work" aria-label="Open work">
      <h2>Open work</h2>
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            <button type="button" className="open-work-row" onClick={() => onOpen(row.id)}>
              <span>
                <strong>{row.title}</strong>
                {row.reason && <small>{row.reason}</small>}
              </span>
              <Status tone={row.tone}>{row.stageLabel}</Status>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

export type TaskProgress = 'done' | 'running' | 'waiting' | 'blocked' | 'failed'

export interface TaskRowProps {
  id: string
  title: string
  detail: string
  stateLabel: string
  progress: TaskProgress
  selected: boolean
  onOpen: () => void
}

const PROGRESS_TEXT: Record<TaskProgress, string> = {
  done: 'Done',
  running: 'Running',
  waiting: 'Waiting',
  blocked: 'Blocked',
  failed: 'Failed',
}

function TaskRow({ title, detail, stateLabel, progress, selected, onOpen }: TaskRowProps) {
  return (
    <li>
      <button
        type="button"
        className="task-row"
        aria-current={selected ? 'true' : undefined}
        onClick={onOpen}
      >
        <span className={`task-indicator task-${progress}`} role="img" aria-label={PROGRESS_TEXT[progress]} />
        <span className="task-body">
          <strong>{title}</strong>
          <small>{detail}</small>
        </span>
        <span className="task-state">{stateLabel}</span>
        <ChevronIcon />
      </button>
    </li>
  )
}

export interface DeliveryPlanProps {
  title: string
  subtitle: string
  stateLabel: string
  stateTone?: StatusTone
  tasks: readonly TaskRowProps[]
  /** Empty when delivery cannot apply. */
  footnote: string
  actions?: readonly { label: string; onClick: () => void }[]
}

export function DeliveryPlan({
  title,
  subtitle,
  stateLabel,
  stateTone,
  tasks,
  footnote,
  actions = [],
}: DeliveryPlanProps) {
  return (
    <article className="delivery">
      <header className="delivery-head">
        <div>
          <h2>{title}</h2>
          <small>{subtitle}</small>
        </div>
        <Status tone={stateTone}>{stateLabel}</Status>
      </header>
      {tasks.length > 0 && (
        <ul className="task-list">
          {tasks.map((task) => (
            <TaskRow key={task.id} {...task} />
          ))}
        </ul>
      )}
      {(footnote !== '' || actions.length > 0) && (
        <footer className="delivery-foot">
          <span>{footnote}</span>
          {actions.length > 0 && (
            <span className="delivery-actions">
              {actions.map((action) => (
                <Button key={action.label} variant="text" onClick={action.onClick}>
                  {action.label}
                </Button>
              ))}
            </span>
          )}
        </footer>
      )}
    </article>
  )
}
