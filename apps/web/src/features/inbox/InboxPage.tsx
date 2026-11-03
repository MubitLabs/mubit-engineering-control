import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '../../api/client'
import type { Approval } from '../../api/types'
import { useTitle } from '../../components/Layout'
import { decisionStatus, Empty, ErrorBox, Panel, Status, Time } from '../../components/ui'

/**
 * Decision inbox (PDF §12): the exact question or operation, its evidence, and plain choices.
 * The first authorised answer wins; a late answer is shown the recorded result.
 */
export function InboxPage() {
  const [scope, setScope] = useState<'pending' | 'all'>('pending')
  useTitle('Inbox')
  const q = useQuery({
    queryKey: ['approvals', 'mine', scope],
    queryFn: () => api.get<{ approvals: Approval[] }>(`/api/approvals?status=${scope}`),
    refetchInterval: 10_000,
  })
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Decision inbox</h1>
        <div className="row">
          <button
            type="button"
            className={`btn small ${scope === 'pending' ? 'primary' : ''}`}
            onClick={() => setScope('pending')}
          >
            Pending
          </button>
          <button
            type="button"
            className={`btn small ${scope === 'all' ? 'primary' : ''}`}
            onClick={() => setScope('all')}
          >
            History
          </button>
        </div>
      </div>
      {q.data?.approvals.length === 0 && (
        <Panel>
          <Empty>Nothing needs your decision.</Empty>
        </Panel>
      )}
      {q.data?.approvals.map((a) => (
        <DecisionCard key={a.id} approval={a} />
      ))}
    </div>
  )
}

export function DecisionCard({ approval }: { approval: Approval }) {
  const qc = useQueryClient()
  const [answer, setAnswer] = useState('')
  const [reason, setReason] = useState('')
  const resolve = useMutation({
    mutationFn: (decision: unknown) => api.post(`/api/approvals/${approval.id}/resolve`, { decision }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['approvals'] })
      if (approval.deliveryId) qc.invalidateQueries({ queryKey: ['delivery', approval.deliveryId] })
    },
  })
  const detail = approval.detail as {
    question?: string
    command?: string
    toolName?: string
    input?: unknown
    diff?: string
    options?: string[]
    requester?: string
    profileOwner?: string
    consequence?: string
  }
  const pending = approval.status === 'pending'

  return (
    <Panel
      title={
        <div className="row">
          <Status value={approval.kind} />
          <h3>{approval.title}</h3>
        </div>
      }
      actions={<Status value={decisionStatus(approval)} />}
    >
      <div className="stack">
        <div className="small muted row">
          {approval.deliveryTitle && (
            <Link to={`/projects/${approval.projectId}/deliveries/${approval.deliveryId}`}>
              {approval.deliveryTitle}
            </Link>
          )}
          {approval.taskKey && approval.taskId && (
            <span>
              task{' '}
              <Link to={`/projects/${approval.projectId}/tasks/${approval.taskId}`}>{approval.taskKey}</Link>
            </span>
          )}
          <span>requested by {detail.requester ?? approval.requestedByKind}</span>
          {detail.profileOwner && <span>on {detail.profileOwner}'s account</span>}
          <Time value={approval.createdAt} />
          {approval.expiresAt && pending && (
            <span>
              expires <Time value={approval.expiresAt} />
            </span>
          )}
        </div>
        {detail.question && <pre>{detail.question}</pre>}
        {detail.toolName && (
          <div>
            <div className="faint small">tool</div>
            <code>{detail.toolName}</code>
          </div>
        )}
        {detail.command && <pre className="panel panel-body">{detail.command}</pre>}
        {detail.input !== undefined && !detail.command && (
          <pre className="panel panel-body small">{JSON.stringify(detail.input, null, 2)}</pre>
        )}
        {detail.diff && <pre className="panel panel-body small">{detail.diff}</pre>}
        {detail.consequence && <div className="notice">{detail.consequence}</div>}
        {!pending && approval.answer && (
          <div className="muted small">
            {approval.resolvedByLogin ? `${approval.resolvedByLogin}: ` : ''}
            {String(approval.answer.answer ?? approval.answer.reason ?? '')}
          </div>
        )}
        {pending && approval.kind === 'question' && (
          <div className="form">
            {detail.options && (
              <div className="row">
                {detail.options.map((o) => (
                  <button key={o} type="button" className="btn small" onClick={() => setAnswer(o)}>
                    {o}
                  </button>
                ))}
              </div>
            )}
            <textarea
              rows={3}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Your answer"
            />
            <div className="row">
              <button
                type="button"
                className="btn primary"
                disabled={!answer.trim() || resolve.isPending}
                onClick={() => resolve.mutate({ kind: 'answer', answer })}
              >
                Send answer
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => resolve.mutate({ kind: 'reject', reason: 'declined' })}
              >
                Decline
              </button>
            </div>
          </div>
        )}
        {approval.kind === 'result' && (
          <div className="small muted">
            commit <code>{String(approval.detail.headSha ?? '').slice(0, 12)}</code> ·{' '}
            {String(approval.detail.files ?? 0)} files · checks passed:{' '}
            {((approval.detail.checksPassed as string[] | undefined) ?? []).join(', ') || 'none'}
            {approval.taskId && (
              <>
                {' '}
                · <Link to={`/projects/${approval.projectId}/tasks/${approval.taskId}`}>open the diff</Link>
              </>
            )}
          </div>
        )}
        {pending && approval.kind !== 'question' && (
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate({ kind: 'approve' })}
            >
              {approval.kind === 'result' ? 'Accept result' : 'Approve'}
            </button>
            <input
              style={{ flex: 1 }}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                approval.kind === 'result'
                  ? 'What should the repair attempt change?'
                  : 'Reason (optional, sent with a rejection)'
              }
            />
            <button
              type="button"
              className="btn danger"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate({ kind: 'reject', reason })}
            >
              {approval.kind === 'result' ? 'Send back' : 'Reject'}
            </button>
          </div>
        )}
        <ErrorBox error={resolve.error} />
      </div>
    </Panel>
  )
}
