import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ApiError, api } from '../../api/client'
import { useProjectEvents } from '../../api/events'
import type { DeliveryDetail, PlanRevision } from '../../api/types'
import { Empty, ErrorBox, Loading, Panel, Status, Time } from '../../components/ui'
import { useMe } from '../auth/useMe'

export function DeliveryPage() {
  const { projectId, deliveryId } = useParams()
  useProjectEvents(projectId)
  const q = useQuery({
    queryKey: ['delivery', deliveryId],
    queryFn: () => api.get<DeliveryDetail>(`/api/deliveries/${deliveryId}`),
  })
  if (!q.data) return q.error ? <ErrorBox error={q.error} /> : <Loading />
  const { delivery, revisions, tasks, approvals, repository, owner } = q.data
  const current = revisions[0]

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="crumbs">
            <Link to={`/projects/${projectId}`}>project</Link> / delivery
          </div>
          <h1>
            {delivery.title} <Status value={delivery.state} />
          </h1>
          <div className="muted small">
            {repository.name} @ {delivery.baseRef}
            {delivery.baseSha && <> ({delivery.baseSha.slice(0, 10)})</>} · owner {owner.login}
          </div>
        </div>
      </div>
      <div className="grid-2">
        <div className="stack">
          {current && (
            <RevisionEditor revision={current} ownerId={delivery.ownerId} deliveryId={delivery.id} />
          )}
          <Panel title="Tasks" flush>
            {tasks.length === 0 ? (
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
                  {tasks
                    .filter((t) => t.state !== 'cancelled')
                    .map((t) => (
                      <tr key={t.id}>
                        <td>
                          <code>{t.key}</code>
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
              onClick={() => save.mutate()}
            >
              Save
            </button>
          )}
          {revision.state === 'draft' && (
            <button type="button" className="btn small" disabled={dirty} onClick={() => submit.mutate()}>
              Submit for approval
            </button>
          )}
          {revision.state === 'proposed' && isOwner && (
            <button
              type="button"
              className="btn small primary"
              disabled={dirty}
              onClick={() => approve.mutate()}
            >
              Approve revision
            </button>
          )}
          {!editable && (
            <button type="button" className="btn small" onClick={() => newRevision.mutate()}>
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
