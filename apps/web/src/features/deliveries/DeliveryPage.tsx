import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ApiError, api } from '../../api/client'
import type { DeliveryDetail, PlanRevision } from '../../api/types'
import { ProjectCrumb } from '../../components/Layout'
import { Empty, ErrorBox, Loading, Panel, Status, Time } from '../../components/ui'
import type { ProfileView } from '../accounts/AccountsPage'
import { useMe } from '../auth/useMe'
import { TaskGraph } from './TaskGraph'

export function DeliveryPage() {
  const { projectId, deliveryId } = useParams()
  const q = useQuery({
    queryKey: ['delivery', deliveryId],
    queryFn: () => api.get<DeliveryDetail>(`/api/deliveries/${deliveryId}`),
  })
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
          {current && <Traceability revision={current} />}
          {current && (
            <RevisionEditor revision={current} ownerId={delivery.ownerId} deliveryId={delivery.id} />
          )}
          <Panel title="Tasks" flush>
            {work.length === 0 ? (
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
                        <Status value={t.state} />
                      </td>
                      <td className="muted small">{t.blocker?.detail ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
        <div className="stack">
          {delivery.state === 'planning' && <Coordinator deliveryId={delivery.id} />}
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
                        <div>{a.title}</div>
                        <div className="faint small">{a.kind}</div>
                      </td>
                      <td>
                        <Status value={a.status} />
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
  const chosen = profileId || usable[0]?.id || ''
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
                  {p.label} on {p.runnerName}
                  {p.authState === 'required' ? ' · sign-in required' : ''}
                </option>
              ))}
            </select>
            <div>
              <button
                type="button"
                className="btn primary"
                disabled={!chosen || run.isPending}
                onClick={() => run.mutate()}
              >
                Run coordinator
              </button>
            </div>
          </>
        )}
        <ErrorBox error={run.error} />
      </div>
    </Panel>
  )
}

/** Plan text and task list with optimistic version checks: a conflict shows the newer text. */
function RevisionEditor(props: { revision: PlanRevision; ownerId: string; deliveryId: string }) {
  const { revision } = props
  const me = useMe()
  const qc = useQueryClient()
  const editable = revision.state === 'draft' || revision.state === 'proposed'
  const [plan, setPlan] = useState(revision.planMarkdown)
  const [spec, setSpec] = useState(() => toSpecText(revision))
  const [conflict, setConflict] = useState<PlanRevision | null>(null)

  useEffect(() => {
    setPlan(revision.planMarkdown)
    setSpec(toSpecText(revision))
    setConflict(null)
  }, [revision])

  const refresh = () => qc.invalidateQueries({ queryKey: ['delivery', props.deliveryId] })
  const save = useMutation({
    mutationFn: () => {
      const parsed = JSON.parse(spec) as { requirements: unknown; tasks: unknown }
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
          {revision.state === 'draft' && (
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
            <button type="button" className="btn small" onClick={() => start(newRevision)}>
              New revision
            </button>
          )}
        </>
      }
    >
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
          Requirements and tasks (JSON)
          <textarea rows={12} value={spec} readOnly={!editable} onChange={(e) => setSpec(e.target.value)} />
        </label>
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
    </Panel>
  )
}

function toSpecText(r: PlanRevision): string {
  return JSON.stringify({ requirements: r.requirements, tasks: r.tasks }, null, 2)
}
