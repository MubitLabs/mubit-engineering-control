import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ApiError, api } from '../../api/client'
import type { DeliveryDetail, PlanRevision } from '../../api/types'
import { ProjectCrumb, useTitle } from '../../components/Layout'
import {
  decisionStatus,
  Empty,
  ErrorBox,
  Loading,
  Panel,
  Status,
  Time,
  taskStatus,
} from '../../components/ui'
import type { ProfileView } from '../accounts/AccountsPage'
import { useMe } from '../auth/useMe'
import { TaskGraph } from './TaskGraph'

export function DeliveryPage() {
  const { projectId, deliveryId } = useParams()
  const q = useQuery({
    queryKey: ['delivery', deliveryId],
    queryFn: () => api.get<DeliveryDetail>(`/api/deliveries/${deliveryId}`),
  })
  const me = useMe()
  const role = projectId ? me.data?.projectRoles[projectId] : undefined
  const canEdit = role === 'owner' || role === 'member'
  useTitle(q.data?.delivery.title)
  if (!q.data) return q.error ? <ErrorBox error={q.error} /> : <Loading />
  const { delivery, revisions, tasks, approvals, repository, owner, dependencies } = q.data
  const current = revisions[0]
  const work = tasks.filter((t) => t.kind === 'work' && t.state !== 'cancelled')
  const integrationRuns = tasks.filter((t) => t.kind === 'integration')
  const planning = tasks.filter((t) => t.kind === 'planning')
  const byId = new Map(tasks.map((t) => [t.id, t]))

  // Live tasks once a revision is approved; otherwise the proposed graph from the current revision.
  const graph = work.length
    ? {
        nodes: work.map((t) => ({ key: t.key, title: t.title, state: t.state, id: t.id })),
        edges: dependencies
          .filter((d) => byId.get(d.taskId)?.state !== 'cancelled')
          .map(
            (d) =>
              [byId.get(d.dependsOnTaskId)?.key ?? '', byId.get(d.taskId)?.key ?? ''] as [string, string],
          ),
      }
    : {
        nodes: (current?.tasks ?? []).map((t) => ({
          key: t.key,
          title: t.title,
          warn: current?.validation?.warnings.some((w) => w.taskKeys.includes(t.key)) ?? false,
        })),
        edges: (current?.tasks ?? []).flatMap((t) => t.dependsOn.map((d) => [d, t.key] as [string, string])),
      }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="crumbs">
            <ProjectCrumb projectId={projectId} /> / delivery
          </div>
          <h1>
            {delivery.title} <Status value={delivery.state} />
            {q.data.pullRequests[0] && (
              <a
                className="small"
                style={{ marginLeft: 8 }}
                href={q.data.pullRequests[0].url}
                target="_blank"
                rel="noreferrer"
              >
                PR #{q.data.pullRequests[0].number}
              </a>
            )}
          </h1>
          <div className="muted small">
            {repository.name} @ {delivery.baseRef}
            {delivery.baseSha && <> (pinned {delivery.baseSha.slice(0, 10)})</>} · owner {owner.login}
          </div>
        </div>
      </div>
      <div className="grid-2">
        <div className="stack">
          <Panel title="Task graph">
            {graph.nodes.length ? (
              <TaskGraph nodes={graph.nodes} edges={graph.edges} projectId={projectId} />
            ) : (
              <div className="muted">
                No tasks yet. Write them below, or run the coordinator to propose them.
              </div>
            )}
          </Panel>
          <Panel title="Tasks" flush>
            {work.length === 0 && current && current.tasks.length > 0 ? (
              <ProposedTasks revision={current} />
            ) : work.length === 0 ? (
              <Empty>Tasks appear here once a plan revision is approved.</Empty>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Title</th>
                    <th>State</th>
                    <th>Waiting for</th>
                  </tr>
                </thead>
                <tbody>
                  {work.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <Link to={`/projects/${projectId}/tasks/${t.id}`}>
                          <code>{t.key}</code>
                        </Link>
                      </td>
                      <td>{t.title}</td>
                      <td>
                        <Status value={taskStatus(t.state)} />
                      </td>
                      <td className="muted small">{t.blocker?.detail ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
          {current && <Traceability revision={current} />}
          {current && (
            <RevisionEditor
              key={current.id}
              revision={current}
              ownerId={delivery.ownerId}
              canEdit={canEdit}
              deliveryId={delivery.id}
              checks={repository.validationProfile.checks.map((c) => c.name)}
            />
          )}
        </div>
        <div className="stack">
          {delivery.state === 'planning' && canEdit && <Coordinator deliveryId={delivery.id} />}
          {(delivery.integrationSha || q.data.pullRequests.length > 0) && (
            <Panel title="Integration">
              <div className="stack small">
                <div>
                  integration branch <code>mec/{delivery.id.slice(0, 8)}/integration</code> at{' '}
                  <code>{delivery.integrationSha?.slice(0, 12) ?? '—'}</code>{' '}
                  {delivery.integrationSha && delivery.integrationPushedSha === delivery.integrationSha ? (
                    <Status value="pushed" />
                  ) : (
                    <span className="faint">not pushed</span>
                  )}
                </div>
                <div className="muted">
                  {work.filter((t) => t.state === 'integrated').length}/{work.length} tasks integrated
                </div>
                {integrationRuns.map((r) => (
                  <div key={r.id} className="row">
                    <Link to={`/projects/${projectId}/tasks/${r.id}`}>{r.title}</Link>
                    <Status value={r.state === 'accepted' ? 'passed' : r.state} />
                  </div>
                ))}
                {q.data.nextStep && <div className="notice">{q.data.nextStep}</div>}
                {delivery.state === 'awaiting_merge' && (
                  <div className="notice">
                    Waiting for the pull request to be reviewed and merged on GitHub. This delivery records
                    "merged" only when GitHub reports it (checked every 30 seconds).
                  </div>
                )}
                {delivery.state === 'integrating' &&
                  delivery.integrationSha &&
                  delivery.integrationPushedSha !== delivery.integrationSha &&
                  me.data?.user.id === delivery.ownerId && <PushAgain deliveryId={delivery.id} />}
                {q.data.pullRequests.map((pr) => (
                  <div key={pr.id} className="row">
                    <a href={pr.url} target="_blank" rel="noreferrer">
                      PR #{pr.number}
                    </a>
                    <Status value={pr.state} />
                    {pr.checks && <span className="faint">CI {pr.checks.conclusion}</span>}
                  </div>
                ))}
              </div>
            </Panel>
          )}
          {planning.length > 0 && (
            <Panel title="Coordinator runs" flush>
              <table className="table">
                <tbody>
                  {planning.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <Link to={`/projects/${projectId}/tasks/${t.id}`}>{t.title}</Link>
                      </td>
                      <td>
                        <Status value={t.state} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
          <Panel title="Revisions" flush>
            <table className="table">
              <tbody>
                {revisions.map((r) => (
                  <tr key={r.id}>
                    <td>#{r.number}</td>
                    <td>
                      <Status value={r.state} />
                    </td>
                    <td className="muted small">v{r.version}</td>
                    <td>
                      <Time value={r.updatedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="Decisions" flush>
            {approvals.length === 0 ? (
              <Empty>No decisions yet.</Empty>
            ) : (
              <table className="table">
                <tbody>
                  {approvals.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <div>
                          {a.taskId ? (
                            <Link to={`/projects/${projectId}/tasks/${a.taskId}`}>{a.title}</Link>
                          ) : a.status === 'pending' ? (
                            <Link to="/inbox">{a.title}</Link>
                          ) : (
                            a.title
                          )}
                        </div>
                        <div className="faint small">
                          {a.kind}
                          {a.status === 'pending' &&
                            a.kind === 'plan' &&
                            ' · approve in the plan revision panel or the inbox'}
                        </div>
                      </td>
                      <td>
                        <Status value={decisionStatus(a)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      </div>
    </div>
  )
}

/** Requirements traceability (PDF §8): every requirement and the tasks that implement it. */
function Traceability({ revision }: { revision: PlanRevision }) {
  if (revision.requirements.length === 0) return null
  return (
    <Panel title="Requirements" flush>
      <table className="table">
        <tbody>
          {revision.requirements.map((r) => {
            const covering = revision.tasks.filter((t) => t.requirementIds.includes(r.id)).map((t) => t.key)
            return (
              <tr key={r.id}>
                <td>
                  <code>{r.id}</code>
                </td>
                <td>{r.text}</td>
                <td className="small">
                  {covering.length ? covering.join(', ') : <span className="status warn">uncovered</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Panel>
  )
}

/** Run the coordinator: a read-only agent proposes the graph; validation and the owner decide. */
function Coordinator({ deliveryId }: { deliveryId: string }) {
  const qc = useQueryClient()
  const profiles = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.get<{ profiles: ProfileView[] }>('/api/profiles'),
  })
  const [profileId, setProfileId] = useState('')
  const usable = profiles.data?.profiles.filter((p) => p.agentKind === 'claude-code') ?? []
  const chosen = profileId || (usable.find((p) => p.authState !== 'required') ?? usable[0])?.id || ''
  const signedOut = usable.find((p) => p.id === chosen)?.authState === 'required'
  const run = useMutation({
    mutationFn: () => api.post(`/api/deliveries/${deliveryId}/coordinate`, { profileId: chosen }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery', deliveryId] }),
  })
  return (
    <Panel title="Coordinator">
      <div className="form small">
        <div className="muted">
          A coding agent reads the repository at the pinned base (read-only) and proposes requirements and
          tasks. Invalid graphs are sent back for repair; a valid one waits for your approval.
        </div>
        {usable.length === 0 ? (
          <div className="notice">
            No Claude Code account is offered to you yet. A runner owner offers one on the{' '}
            <Link to="/accounts">Accounts</Link> page.
          </div>
        ) : (
          <>
            <select value={chosen} onChange={(e) => setProfileId(e.target.value)}>
              {usable.map((p) => (
                <option key={p.id} value={p.id} disabled={p.authState === 'required'}>
                  {p.label.includes(p.runnerName) ? p.label : `${p.label} on ${p.runnerName}`}
                  {p.authState === 'required' ? ' · sign-in required' : ''}
                </option>
              ))}
            </select>
            <div>
              <button
                type="button"
                className="btn primary"
                disabled={!chosen || signedOut || run.isPending}
                onClick={() => run.mutate()}
              >
                Run coordinator
              </button>
            </div>
            {signedOut && (
              <div className="notice">
                This account's agent is not signed in on its runner. Its owner signs in there, then uses{' '}
                <Link to="/accounts">check again</Link> on the Accounts page.
              </div>
            )}
          </>
        )}
        <ErrorBox error={run.error} />
      </div>
    </Panel>
  )
}

/** Plan text and task list with optimistic version checks: a conflict shows the newer text. */
function RevisionEditor(props: {
  revision: PlanRevision
  ownerId: string
  deliveryId: string
  checks: string[]
  canEdit: boolean
}) {
  const { revision } = props
  const me = useMe()
  const qc = useQueryClient()
  const editable = props.canEdit && (revision.state === 'draft' || revision.state === 'proposed')
  const [plan, setPlan] = useState(revision.planMarkdown)
  const [spec, setSpec] = useState(() => toSpecText(revision))
  const [conflict, setConflict] = useState<PlanRevision | null>(null)
  const [open, setOpen] = useState(editable)

  useEffect(() => {
    setPlan(revision.planMarkdown)
    setSpec(toSpecText(revision))
    setConflict(null)
  }, [revision])

  const refresh = () => qc.invalidateQueries({ queryKey: ['delivery', props.deliveryId] })
  const save = useMutation({
    mutationFn: () => {
      let parsed: { requirements: unknown; tasks: unknown }
      try {
        parsed = JSON.parse(spec)
      } catch (e) {
        throw new Error(`Requirements and tasks are not valid JSON: ${(e as Error).message}`)
      }
      return api.patch(`/api/plans/${revision.id}`, {
        expectedVersion: revision.version,
        planMarkdown: plan,
        requirements: parsed.requirements,
        tasks: parsed.tasks,
      })
    },
    onSuccess: refresh,
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'version_conflict') {
        setConflict((e.details as { current: PlanRevision }).current)
      }
    },
  })
  const submit = useMutation({
    mutationFn: () => api.post(`/api/plans/${revision.id}/submit`, { expectedVersion: revision.version }),
    onSuccess: refresh,
  })
  const approve = useMutation({
    mutationFn: () => api.post(`/api/plans/${revision.id}/approve`, { expectedVersion: revision.version }),
    onSuccess: refresh,
  })
  const newRevision = useMutation({
    mutationFn: () => api.post(`/api/deliveries/${props.deliveryId}/plans`, {}),
    onSuccess: refresh,
  })
  const dirty = plan !== revision.planMarkdown || spec !== toSpecText(revision)
  const start = (m: { mutate: () => void }) => {
    for (const other of [save, submit, approve, newRevision]) other.reset()
    m.mutate()
  }
  const isOwner = me.data?.user.id === props.ownerId

  return (
    <Panel
      title={
        <h2>
          Plan revision #{revision.number} <Status value={revision.state} />{' '}
          <span className="faint">v{revision.version}</span>
        </h2>
      }
      actions={
        <>
          {editable && (
            <button
              type="button"
              className="btn small"
              disabled={!dirty || save.isPending}
              onClick={() => start(save)}
            >
              Save
            </button>
          )}
          {revision.state === 'draft' && props.canEdit && (
            <button type="button" className="btn small" disabled={dirty} onClick={() => start(submit)}>
              Submit for approval
            </button>
          )}
          {revision.state === 'proposed' && isOwner && (
            <button
              type="button"
              className="btn small primary"
              disabled={dirty}
              onClick={() => start(approve)}
            >
              Approve revision
            </button>
          )}
          {!editable && (
            <>
              <button type="button" className="btn small" onClick={() => setOpen(!open)}>
                {open ? 'Hide plan' : 'Show plan'}
              </button>
              <button
                type="button"
                className="btn small"
                hidden={!props.canEdit}
                onClick={() => start(newRevision)}
              >
                New revision
              </button>
            </>
          )}
        </>
      }
    >
      {!open ? (
        <div className="muted small">
          {revision.state} plan with {revision.tasks.length} tasks. Changing it starts a new revision.
          <ErrorBox error={newRevision.error} />
        </div>
      ) : (
        <div className="form">
          {conflict && (
            <div className="error-box">
              Someone else saved version {conflict.version}. Their text:
              <pre className="muted">{conflict.planMarkdown}</pre>
              <button type="button" className="btn small" onClick={refresh}>
                Load their version
              </button>
            </div>
          )}
          <label className="field">
            Plan
            <textarea rows={8} value={plan} readOnly={!editable} onChange={(e) => setPlan(e.target.value)} />
          </label>
          <label className="field">
            <span className="spread">
              <span>Requirements and tasks (JSON)</span>
              {editable && revision.tasks.length === 0 && (
                <button
                  type="button"
                  className="btn small"
                  onClick={() => setSpec(exampleSpec(props.checks))}
                >
                  Insert example
                </button>
              )}
            </span>
            <textarea rows={12} value={spec} readOnly={!editable} onChange={(e) => setSpec(e.target.value)} />
          </label>
          {editable && (
            <div className="faint small">
              Each task needs a <code>key</code>, <code>title</code> and <code>objective</code>.{' '}
              <code>acceptanceChecks</code> names the repository checks that must pass (
              {props.checks.join(', ') || 'none registered'}), <code>dependsOn</code> lists task keys that
              must be integrated first, <code>requirementIds</code> ties tasks to requirements and{' '}
              <code>ownedPaths</code> marks files a task expects to change.
            </div>
          )}
          {revision.impactSummary && (
            <div className="notice small">
              <strong>Impact on the approved plan</strong>
              <pre>{revision.impactSummary}</pre>
            </div>
          )}
          {revision.validation && (
            <div className="small">
              {revision.validation.errors.map((e) => (
                <div key={e.message} className="status err" style={{ display: 'block', marginBottom: 4 }}>
                  {e.message}
                </div>
              ))}
              {revision.validation.warnings.map((w) => (
                <div key={w.message} className="muted">
                  ⚠ {w.message}
                </div>
              ))}
            </div>
          )}
          <ErrorBox error={save.error ?? submit.error ?? approve.error ?? newRevision.error} />
        </div>
      )}
    </Panel>
  )
}

function exampleSpec(checks: string[]): string {
  const acceptanceChecks = checks.slice(0, 2)
  return JSON.stringify(
    {
      requirements: [{ id: 'R1', text: 'What must be true when the delivery is done' }],
      tasks: [
        {
          key: 'first',
          title: 'A small, independently reviewable change',
          objective: 'What the agent should do, in a few sentences.',
          requirementIds: ['R1'],
          acceptanceChecks,
          ownedPaths: ['src/'],
        },
        {
          key: 'second',
          title: 'Work that builds on the first task',
          objective: 'Starts from the integrated result of "first".',
          requirementIds: ['R1'],
          acceptanceChecks,
          dependsOn: ['first'],
        },
      ],
    },
    null,
    2,
  )
}

function toSpecText(r: PlanRevision): string {
  return JSON.stringify({ requirements: r.requirements, tasks: r.tasks }, null, 2)
}

function PushAgain({ deliveryId }: { deliveryId: string }) {
  const qc = useQueryClient()
  const push = useMutation({
    mutationFn: () => api.post(`/api/deliveries/${deliveryId}/push-integration`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery', deliveryId] }),
  })
  return (
    <div>
      <button type="button" className="btn small" disabled={push.isPending} onClick={() => push.mutate()}>
        Push again
      </button>
      <ErrorBox error={push.error} />
    </div>
  )
}

/** The revision's tasks as a reviewer reads them before approving; nothing runs until then. */
function ProposedTasks({ revision }: { revision: PlanRevision }) {
  return (
    <>
      <div className="small faint" style={{ padding: '8px 12px 0' }}>
        Revision #{revision.number} proposes these tasks. Nothing runs until the revision is approved.
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Task</th>
            <th>Needs</th>
            <th>Checks</th>
          </tr>
        </thead>
        <tbody>
          {revision.tasks.map((t) => (
            <tr key={t.key}>
              <td>
                <code>{t.key}</code>
              </td>
              <td>
                <div>{t.title}</div>
                <div className="muted small" style={{ whiteSpace: 'pre-wrap' }}>
                  {t.objective}
                </div>
                {t.ownedPaths.length > 0 && (
                  <div className="faint small">changes {t.ownedPaths.join(', ')}</div>
                )}
              </td>
              <td className="small">{t.dependsOn.join(', ') || <span className="faint">—</span>}</td>
              <td className="small">
                {t.acceptanceChecks.join(', ') || <span className="status warn">none</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
