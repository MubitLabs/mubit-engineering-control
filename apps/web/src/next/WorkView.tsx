import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
import { repoScopeApplies, screenshotCaption, stopInView } from './work-model'

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
  if (!repoScopeApplies(options)) return null
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
  stopping,
  setStopping,
}: {
  row: WorkRowView
  detail: DeliveryDetailView
  selectedTaskId: string | null
  onOpenTask: (id: string) => void
  onAction: (action: WorkAction) => void
  onDiscuss: (action: DiscussAction) => void
  /** Held by the view, not here: a read that refiles the row under another group remounts this. */
  stopping: WorkAction | null
  setStopping: (action: WorkAction | null) => void
}) {
  const { openInspector } = useShellActions()
  const { discuss } = detail
  const root = useRef<HTMLDivElement>(null)
  const stopButton = useRef<HTMLButtonElement>(null)
  const wasStopping = useRef(false)
  // The heading, not a button: a held Enter must not walk through the steps of a stop.
  useLayoutEffect(() => {
    if (stopping) root.current?.querySelector<HTMLElement>('.decision h2')?.focus()
    else if (wasStopping.current) stopButton.current?.focus()
    wasStopping.current = stopping !== null
  }, [stopping])
  return (
    <div className="work-detail" ref={root}>
      {detail.lead && !stopping && (
        <div className="work-lead">
          <Button onClick={() => detail.lead && onAction(detail.lead)}>{detail.lead.label}</Button>
        </div>
      )}
      {detail.outcome ? (
        <section className="work-answer">
          <h3>{detail.outcome.kind === 'answered' ? 'Answer' : 'No answer'}</h3>
          <p>{detail.outcome.text}</p>
        </section>
      ) : (
        <DeliveryPlan
          {...detail.plan}
          footnote=""
          tasks={detail.plan.tasks.map((task) => ({
            ...task,
            selected: task.id === selectedTaskId,
            onOpen: () => {
              onOpenTask(task.id)
              openInspector()
            },
          }))}
          {...(discuss && { actions: [{ label: discuss.label, onClick: () => onDiscuss(discuss) }] })}
        />
      )}
      {detail.delegation.length > 0 && (
        <section className="work-links">
          <h3>Delegation</h3>
          <ul className="delegation-list">
            {detail.delegation.map((row) => (
              <li key={row.taskId}>
                <strong>{row.title}</strong>
                <span className="delegation-state">{row.stateLabel}</span>
                <p>{row.who}</p>
                <p>{row.why}</p>
                <p>
                  {row.attempts}
                  {row.activity ? `. ${row.activity}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!detail.outcome && (
        <section className="work-links">
          <h3>Delivery</h3>
          <p className={detail.delivery.failure === null ? undefined : 'tone-bad'}>{detail.delivery.label}</p>
          {detail.delivery.ci && <p>{detail.delivery.ci}</p>}
          {detail.delivery.waiting && <p>{detail.delivery.waiting}</p>}
          {detail.delivery.prUrl && detail.delivery.prLabel && (
            <p>
              <a href={detail.delivery.prUrl} target="_blank" rel="noreferrer">
                {detail.delivery.prLabel}
              </a>
            </p>
          )}
        </section>
      )}
      {detail.screenshots.length > 0 && (
        <section className="work-links work-screenshots" aria-label="Screenshots">
          <h3>Screenshots</h3>
          {detail.screenshots.map((set) => (
            <div key={set.key} className="screenshot-set">
              <p>
                <strong>{set.title}</strong>
                {screenshotCaption(set)}
              </p>
              <div className="screenshot-pair">
                {[set.before, set.after].map((side) => (
                  <figure key={side.label}>
                    <figcaption className="mono">{side.label}</figcaption>
                    {side.images.map((image) => (
                      <a key={image.src} href={image.src} target="_blank" rel="noreferrer">
                        <img src={image.src} alt={image.alt} loading="lazy" />
                      </a>
                    ))}
                    {side.note && <p className="muted">{side.note}</p>}
                  </figure>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}
      {detail.dependencies.length > 0 && (
        <section className="work-links">
          <h3>Dependencies</h3>
          <ul>
            {detail.dependencies.map((link) => (
              <li key={link.task}>
                {link.task} waits for {link.on.join(', ')}
                {link.more ? `, and ${link.more} more not shown` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}
      {detail.actions.length > 0 && !stopping && (
        <div className="actions">
          {detail.actions
            .filter((action) => action !== detail.lead)
            .map((action) => (
              <Button
                key={action.kind}
                ref={action.kind === 'stop' ? stopButton : undefined}
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
  /** §5.10: what is parked on this delivery, always shown, never only behind a selection. */
  parkedNotice?: (workItemId: string) => ReactNode
  /** The server is another build than this page: its answers need a reload (9 November 2026). */
  stale?: boolean
}

/**
 * A delivery read that failed. On a page from an older build the cause is the upgrade, and a reload
 * is the remedy; otherwise the failure says what it was, with Retry.
 */
export function DeliveryReadFailure(props: {
  stale: boolean
  message: string
  kept: boolean
  onRetry: () => void
}) {
  if (props.stale) {
    return (
      <StateNotice
        kind="error"
        title="MEC was updated"
        body="Reload this page to continue."
        action={{ label: 'Reload', onClick: () => window.location.reload() }}
      />
    )
  }
  return (
    <StateNotice
      kind="error"
      title="Could not read this delivery"
      body={props.kept ? `${props.message} What is shown below may be out of date.` : props.message}
      action={{ label: 'Retry', onClick: props.onRetry }}
    />
  )
}

function WorkEntry({
  row,
  props,
  acted,
  stopping,
  setStopping,
}: {
  row: WorkRowView
  props: WorkViewProps
  acted: boolean
  stopping: WorkAction | null
  setStopping: (action: WorkAction | null) => void
}) {
  const selected = row.id === props.selectedId
  const { delivery } = props
  const kept = delivery.status === 'loading' ? null : delivery.data
  const entry = useRef<HTMLLIElement>(null)
  const rowButton = useRef<HTMLButtonElement>(null)
  // A hold or a stop moves the row to another group, and the detail's own read lands apart from
  // the list's, so this runs on every commit until something else takes focus.
  useLayoutEffect(() => {
    if (!acted || document.activeElement !== document.body) return
    const next = entry.current?.querySelector<HTMLElement>('.work-detail > .actions button')
    ;(next ?? rowButton.current)?.focus()
  })
  return (
    <li className="work-entry" ref={entry}>
      <button
        ref={rowButton}
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
      {props.parkedNotice?.(row.id)}
      {selected && delivery.status === 'failed' && (
        <DeliveryReadFailure
          stale={props.stale === true}
          message={delivery.message}
          kept={kept !== null}
          onRetry={props.onRetry}
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
          stopping={stopping}
          setStopping={setStopping}
        />
      )}
      {selected && delivery.status === 'loading' && <p className="freshness">Reading this delivery.</p>}
    </li>
  )
}

export function WorkView(props: WorkViewProps) {
  const { surface, groups } = props
  /** The delivery last acted on. It keeps focus through a regroup until a pointer goes elsewhere. */
  const [acted, setActed] = useState<string | null>(null)
  /** The stop being confirmed. It outlives a regroup, and closes when the selection moves. */
  const [stopping, setStopping] = useState<WorkAction | null>(null)
  const [stopSelection, setStopSelection] = useState(props.selectedId)
  if (stopSelection !== props.selectedId) {
    setStopSelection(props.selectedId)
    setStopping(null)
  }
  const openStop = stopInView(stopping, props.selectedId)
  useEffect(() => {
    if (acted === null) return
    const release = () => setActed(null)
    document.addEventListener('pointerdown', release, true)
    return () => document.removeEventListener('pointerdown', release, true)
  }, [acted])
  const tracked: WorkViewProps = {
    ...props,
    onAction: (action) => {
      setActed(action.workItemId)
      props.onAction(action)
    },
  }
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
                <WorkEntry
                  key={row.id}
                  row={row}
                  props={tracked}
                  acted={row.id === acted}
                  stopping={row.id === openStop?.workItemId ? openStop : null}
                  setStopping={setStopping}
                />
              ))}
            </ul>
          </section>
        ))}
    </div>
  )
}
