import { useState } from 'react'
import { DeliveryPlan, PageHeader } from './Conversation'
import { Approval } from './Decision'
import { GlossaryButton } from './GlossarySheet'
import { Button, Status } from './primitives'
import { useShellActions } from './Shell'
import { EmptyState, StateNotice } from './states'
import type {
  DeliveryDetailView,
  DiscussAction,
  Read,
  RepoFilterOption,
  SurfaceState,
  WorkAction,
  WorkGroupView,
  WorkRowView,
} from './work-model'

/** A failed read sits above what is kept, and a loading one always has somewhere to end. */
export function ReadNotice({
  surface,
  noun,
  onRetry,
}: {
  surface: SurfaceState
  noun: string
  onRetry: () => void
}) {
  return (
    <>
      {surface.state === 'loading' && (
        <StateNotice kind="working" title={`Reading ${noun}`} body="This ends in a result or a retry." />
      )}
      {surface.state === 'failed' && (
        <StateNotice
          kind="error"
          title={`Could not read ${noun}`}
          body={
            surface.hasContent
              ? 'What is shown below is the last good read and may be out of date.'
              : (surface.message ?? 'The server did not answer.')
          }
          action={{ label: 'Retry', onClick: onRetry }}
        />
      )}
      {surface.freshness && (
        <p className="freshness" data-stale={surface.state === 'failed'}>
          {surface.freshness}
        </p>
      )}
    </>
  )
}

export function RepoScope({
  options,
  value,
  onChange,
}: {
  options: readonly RepoFilterOption[]
  value: string
  onChange: (option: RepoFilterOption) => void
}) {
  if (options.length < 2) return null
  return (
    <label className="repo-scope">
      <span>Repository</span>
      <select
        value={value}
        onChange={(event) => {
          const chosen = options.find((option) => option.value === event.target.value)
          if (chosen) onChange(chosen)
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function StopConfirm({
  action,
  title,
  repository,
  taskCount,
  onConfirm,
  onCancel,
}: {
  action: WorkAction
  title: string
  repository: string
  taskCount: number
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Approval
      label="Stop this delivery"
      title={`Stop ${title}`}
      summary="A stopped delivery does not resume on its own. Going on takes a new request."
      evidence={[
        { label: 'Repository', value: repository },
        { label: 'Tasks', value: String(taskCount) },
      ]}
      status={{ state: 'open', expires: 'Nothing stops until you confirm' }}
      approveLabel={action.label}
      confirmLabel={`Confirm: stop this delivery in ${repository}`}
      denyLabel="Keep it"
      consequences={[]}
      onConfirm={onConfirm}
      onDeny={onCancel}
    />
  )
}

function DeliveryDetail({
  row,
  detail,
  selectedTaskId,
  onOpenTask,
  onAction,
  onDiscuss,
}: {
  row: WorkRowView
  detail: DeliveryDetailView
  selectedTaskId: string | null
  onOpenTask: (id: string) => void
  onAction: (action: WorkAction) => void
  onDiscuss: (action: DiscussAction) => void
}) {
  const { openInspector } = useShellActions()
  const [stopping, setStopping] = useState<WorkAction | null>(null)
  const { discuss } = detail
  return (
    <div className="work-detail">
      <DeliveryPlan
        {...detail.plan}
        tasks={detail.plan.tasks.map((task) => ({
          ...task,
          selected: task.id === selectedTaskId,
          onOpen: () => {
            onOpenTask(task.id)
            openInspector()
          },
        }))}
        {...(discuss && { action: { label: discuss.label, onClick: () => onDiscuss(discuss) } })}
      />
      <section className="work-links">
        <h3>Dependencies</h3>
        {detail.dependencies.length === 0 ? (
          <p>No task here depends on another.</p>
        ) : (
          <ul>
            {detail.dependencies.map((link) => (
              <li key={link.task}>
                {link.task} waits for {link.on.join(', ')}
                {link.more ? `, and ${link.more} more not shown` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="work-links">
        <h3>Delegation</h3>
        {detail.delegation.length === 0 ? (
          <p>No delegation recorded yet.</p>
        ) : (
          <ul>
            {detail.delegation.map((link) => (
              <li key={link.child}>
                {link.parent} started {link.child}
              </li>
            ))}
          </ul>
        )}
      </section>
      {detail.actions.length > 0 && !stopping && (
        <div className="actions">
          {detail.actions.map((action) => (
            <Button
              key={action.kind}
              variant="quiet"
              onClick={() => (action.kind === 'stop' ? setStopping(action) : onAction(action))}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
      {stopping && (
        <StopConfirm
          action={stopping}
          title={row.title}
          repository={row.repository}
          taskCount={detail.plan.tasks.length}
          onConfirm={() => {
            setStopping(null)
            onAction(stopping)
          }}
          onCancel={() => setStopping(null)}
        />
      )}
    </div>
  )
}

export interface WorkViewProps {
  surface: SurfaceState
  groups: readonly WorkGroupView[]
  repoOptions: readonly RepoFilterOption[]
  repoValue: string
  onRepo: (option: RepoFilterOption) => void
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Only the selected delivery reads its detail: rows never fetch their own. */
  delivery: Read<DeliveryDetailView>
  selectedTaskId: string | null
  onOpenTask: (id: string) => void
  onAction: (action: WorkAction) => void
  onDiscuss: (action: DiscussAction) => void
  onRetry: () => void
  /** Set when the list stops short of what the server holds. */
  partialNote?: string | null
}

function WorkEntry({ row, props }: { row: WorkRowView; props: WorkViewProps }) {
  const selected = row.id === props.selectedId
  const { delivery } = props
  const kept = delivery.status === 'loading' ? null : delivery.data
  return (
    <li className="work-entry">
      <button
        type="button"
        className="work-row"
        aria-current={selected ? 'true' : undefined}
        aria-expanded={selected}
        onClick={() => props.onSelect(selected ? null : row.id)}
      >
        <span className="work-row-body">
          <strong>{row.title}</strong>
          <small>{row.repository}</small>
          {row.reason && <small>{row.reason}</small>}
          {row.nextStep && <small>Next: {row.nextStep}</small>}
        </span>
        <Status tone={row.tone}>{row.stageLabel}</Status>
      </button>
      {selected && delivery.status === 'failed' && (
        <StateNotice
          kind="error"
          title="Could not read this delivery"
          body={kept ? `${delivery.message} What is shown below may be out of date.` : delivery.message}
          action={{ label: 'Retry', onClick: props.onRetry }}
        />
      )}
      {selected && kept && (
        <DeliveryDetail
          row={row}
          detail={kept}
          selectedTaskId={props.selectedTaskId}
          onOpenTask={props.onOpenTask}
          onAction={props.onAction}
          onDiscuss={props.onDiscuss}
        />
      )}
      {selected && delivery.status === 'loading' && <p className="freshness">Reading this delivery.</p>}
    </li>
  )
}

export function WorkView(props: WorkViewProps) {
  const { surface, groups } = props
  return (
    <div className="page">
      <PageHeader title="Work" subtitle="Every delivery, by stage." action={<GlossaryButton />} />
      <RepoScope options={props.repoOptions} value={props.repoValue} onChange={props.onRepo} />
      <ReadNotice surface={surface} noun="work" onRetry={props.onRetry} />
      {props.partialNote && <p className="freshness">{props.partialNote}</p>}
      {surface.state === 'empty' && (
        <EmptyState
          title="No deliveries yet"
          body="Ask for an outcome in Conversation and it shows up here."
        />
      )}
      {groups
        .filter((group) => group.count > 0)
        .map((group) => (
          <section key={group.key} className="work-group" aria-label={group.label}>
            <h2>
              {group.label} <span>{group.count}</span>
            </h2>
            <ul>
              {group.rows.map((row) => (
                <WorkEntry key={row.id} row={row} props={props} />
              ))}
            </ul>
          </section>
        ))}
    </div>
  )
}
