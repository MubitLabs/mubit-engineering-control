import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { api } from '../../api/client'
import { useProjectEvents } from '../../api/events'
import type { Approval, Task } from '../../api/types'
import { Empty, ErrorBox, Loading, Panel, Short, Status, Time } from '../../components/ui'
import { useMe } from '../auth/useMe'
import { DecisionCard } from '../inbox/InboxPage'
import { Transcript } from './Transcript'

export interface AttemptView {
  id: string
  number: number
  kind: string
  state: string
  agentKind: string
  runnerId: string | null
  runnerName: string | null
  generation: number
  branch: string | null
  baseSha: string | null
  headSha: string | null
  blocker: { kind: string; detail: string } | null
  result: Record<string, unknown> | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

interface TaskDetail {
  task: Task & { projectId: string; deliveryTitle: string }
  attempts: AttemptView[]
  dependencies: { id: string; key: string; title: string; state: string }[]
  approvals: Approval[]
  canPrompt: boolean
}

const LIVE = new Set([
  'leased',
  'preparing',
  'running',
  'awaiting_input',
  'work_complete',
  'checking',
  'stalled',
])

/** Task workbench (PDF §12): conversation, checks, diff and the controls for the current attempt. */
export function TaskPage() {
  const { projectId, taskId } = useParams()
  useProjectEvents(projectId)
  const q = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.get<TaskDetail>(`/api/tasks/${taskId}`),
  })
  const [selected, setSelected] = useState<string | null>(null)
  if (!q.data) return q.error ? <ErrorBox error={q.error} /> : <Loading />
  const { task, attempts, dependencies, approvals, canPrompt } = q.data
  const attempt = attempts.find((a) => a.id === selected) ?? attempts[0]
  const pending = approvals.filter((a) => a.status === 'pending')

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="crumbs">
            <Link to={`/projects/${projectId}`}>project</Link> /{' '}
            <Link to={`/projects/${projectId}/deliveries/${task.deliveryId}`}>{task.deliveryTitle}</Link> /
            task
          </div>
          <h1>
            <code>{task.key}</code> {task.title} <Status value={task.state} />
          </h1>
          {task.blocker && <div className="muted small">waiting: {task.blocker.detail}</div>}
        </div>
      </div>
      <div className="grid-2">
        <div className="stack">
          {pending.map((a) => (
            <DecisionCard key={a.id} approval={a} />
          ))}
          {attempt ? (
            <AttemptPanel attempt={attempt} canPrompt={canPrompt} />
          ) : (
            <Panel title="Attempts">
              <Empty>No attempts yet.</Empty>
            </Panel>
          )}
        </div>
        <div className="stack">
          <Panel title="Task">
            <div className="stack small">
              <div>{task.spec.objective}</div>
              <div>
                <div className="faint">acceptance checks</div>
                {task.spec.acceptanceChecks.join(', ')}
              </div>
              {task.spec.ownedPaths.length > 0 && (
                <div>
                  <div className="faint">owned paths</div>
                  {task.spec.ownedPaths.map((p) => (
                    <div key={p}>
                      <code>{p}</code>
                    </div>
                  ))}
                </div>
              )}
              {dependencies.length > 0 && (
                <div>
                  <div className="faint">depends on ({task.spec.basePolicy})</div>
                  {dependencies.map((d) => (
                    <div key={d.id} className="row">
                      <Link to={`/projects/${projectId}/tasks/${d.id}`}>{d.key}</Link>{' '}
                      <Status value={d.state} />
                    </div>
                  ))}
                </div>
              )}
              <div className="faint">
                attempts used {task.attemptsUsed} / {task.spec.maxAttempts}
              </div>
            </div>
          </Panel>
          {canPrompt && task.state === 'ready' && <StartAttempt taskId={task.id} />}
          <Panel title="Attempts" flush>
            <table className="table">
              <tbody>
                {attempts.map((a) => (
                  <tr key={a.id} className="clickable" onClick={() => setSelected(a.id)}>
                    <td>#{a.number}</td>
                    <td>
                      <Status value={a.state} />
                    </td>
                    <td className="small muted">
                      {a.agentKind} · {a.runnerName ?? '—'} · g{a.generation}
                    </td>
                    <td>
                      <Time value={a.createdAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>
    </div>
  )
}

const PARKED = new Set(['interrupted', 'quota_wait', 'auth_required'])

function AttemptPanel({ attempt, canPrompt }: { attempt: AttemptView; canPrompt: boolean }) {
  const qc = useQueryClient()
  const me = useMe()
  const control = useMutation({
    mutationFn: (action: 'interrupt' | 'cancel' | 'resume' | 'abandon' | 'confirm-stopped') =>
      api.post(`/api/attempts/${attempt.id}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['task'] }),
  })
  const button = (action: Parameters<typeof control.mutate>[0], label: string, tone = '') => (
    <button
      type="button"
      className={`btn small ${tone}`}
      disabled={control.isPending}
      onClick={() => control.mutate(action)}
    >
      {label}
    </button>
  )
  const stalled = attempt.state === 'stalled'
  return (
    <Panel
      title={
        <h2>
          Attempt #{attempt.number} <Status value={attempt.state} />{' '}
          <span className="faint">
            <Short id={attempt.id} /> g{attempt.generation}
          </span>
        </h2>
      }
      actions={
        <>
          {canPrompt && LIVE.has(attempt.state) && !stalled && (
            <>
              {button('interrupt', 'Interrupt')}
              {button('cancel', 'Cancel', 'danger')}
            </>
          )}
          {canPrompt && PARKED.has(attempt.state) && (
            <>
              {button('resume', 'Resume', 'primary')}
              {button('abandon', 'Abandon', 'danger')}
            </>
          )}
          {stalled && me.data?.user.isAdmin && button('confirm-stopped', 'Confirm process stopped')}
        </>
      }
      flush
    >
      {stalled && (
        <div className="panel-body notice">
          The runner stopped reporting. This attempt keeps its slot until the runner reconnects or an operator
          confirms its process is gone.
        </div>
      )}
      {attempt.blocker && <div className="panel-body notice">{attempt.blocker.detail}</div>}
      <Transcript attemptId={attempt.id} />
      <ErrorBox error={control.error} />
    </Panel>
  )
}

function StartAttempt({ taskId }: { taskId: string }) {
  const qc = useQueryClient()
  const [script, setScript] = useState('')
  const start = useMutation({
    mutationFn: () =>
      api.post(`/api/tasks/${taskId}/attempts`, {
        agentKind: 'fake',
        script: script.trim() ? JSON.parse(script) : undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['task', taskId] }),
  })
  return (
    <Panel title="Start an attempt">
      <div className="form">
        <label className="field">
          Fake agent script (JSON steps, optional)
          <textarea
            rows={4}
            value={script}
            onChange={(e) => setScript(e.target.value)}
            placeholder='[{"say":"hello"},{"sleepMs":1000},{"write":{"path":"a.txt","content":"x"}}]'
          />
        </label>
        <ErrorBox error={start.error} />
        <div>
          <button
            type="button"
            className="btn primary"
            disabled={start.isPending}
            onClick={() => start.mutate()}
          >
            Start fake attempt
          </button>
        </div>
      </div>
    </Panel>
  )
}
