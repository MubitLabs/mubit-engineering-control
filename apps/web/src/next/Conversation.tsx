import type { ReactNode } from 'react'
import { Button, ChevronIcon, Status, type StatusTone } from './primitives'

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
  footnote: string
  action?: { label: string; onClick: () => void }
}

export function DeliveryPlan({
  title,
  subtitle,
  stateLabel,
  stateTone,
  tasks,
  footnote,
  action,
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
      <ul className="task-list">
        {tasks.map((task) => (
          <TaskRow key={task.id} {...task} />
        ))}
      </ul>
      <footer className="delivery-foot">
        <span>{footnote}</span>
        {action && (
          <Button variant="text" onClick={action.onClick}>
            {action.label}
          </Button>
        )}
      </footer>
    </article>
  )
}
