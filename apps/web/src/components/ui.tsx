import type { ReactNode } from 'react'
import { errorMessage } from '../api/client'

const TONES: Record<string, string> = {
  // delivery
  planning: 'neutral',
  approved: 'info',
  executing: 'active',
  integrating: 'active',
  awaiting_merge: 'warn',
  merged: 'ok',
  cancelled: 'neutral',
  // plan revision
  draft: 'neutral',
  proposed: 'warn',
  rejected: 'err',
  superseded: 'neutral',
  // task
  ready: 'info',
  active: 'active',
  awaiting_review: 'warn',
  accepted: 'ok',
  integrated: 'ok',
  failed: 'err',
  // attempt
  queued: 'neutral',
  leased: 'active',
  preparing: 'active',
  running: 'active',
  awaiting_input: 'warn',
  work_complete: 'info',
  checking: 'active',
  succeeded: 'ok',
  checks_failed: 'err',
  interrupted: 'warn',
  quota_wait: 'warn',
  auth_required: 'warn',
  stalled: 'err',
  // approvals
  pending: 'warn',
  answered: 'ok',
  expired: 'neutral',
  stale: 'neutral',
  // runners
  online: 'ok',
  offline: 'neutral',
  draining: 'warn',
  revoked: 'err',
  passed: 'ok',
  pushed: 'ok',
  open: 'warn',
  closed: 'neutral',
  repair: 'warn',
  error: 'err',
}

export function Status({ value }: { value: string | null | undefined }) {
  if (!value) return null
  return <span className={`status ${TONES[value] ?? 'neutral'}`}>{value.replace(/_/g, ' ')}</span>
}

export function Panel(props: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  flush?: boolean
}) {
  return (
    <section className="panel">
      {(props.title || props.actions) && (
        <div className="panel-head">
          {typeof props.title === 'string' ? <h2>{props.title}</h2> : props.title}
          {props.actions && <div className="row">{props.actions}</div>}
        </div>
      )}
      {props.flush ? props.children : <div className="panel-body">{props.children}</div>}
    </section>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null
  return <div className="error-box">{errorMessage(error)}</div>
}

export function Loading() {
  return <div className="muted">loading…</div>
}

export function Time({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="faint">—</span>
  const d = new Date(value)
  return <time title={d.toISOString()}>{relative(d)}</time>
}

function relative(d: Date): string {
  const s = Math.round((Date.now() - d.getTime()) / 1000)
  const a = Math.abs(s)
  if (a < 5) return 'just now'
  const span =
    a < 60 ? `${a}s` : a < 3600 ? `${Math.floor(a / 60)}m` : a < 86400 ? `${Math.floor(a / 3600)}h` : null
  if (!span) return d.toISOString().slice(0, 10)
  return s < 0 ? `in ${span}` : `${span} ago`
}

export function Short({ id }: { id: string | null | undefined }) {
  if (!id) return <span className="faint">—</span>
  return <code title={id}>{id.slice(0, 8)}</code>
}
