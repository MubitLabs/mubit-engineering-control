import type { ReactNode } from 'react'
import { Button } from './primitives'

export type NoticeKind = 'working' | 'blocked' | 'error' | 'completed' | 'resolved' | 'expired'

/** A failed or blocked state sits above the kept content; it never replaces the work. */
export function StateNotice({
  kind,
  title,
  body,
  action,
}: {
  kind: NoticeKind
  title: string
  body: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      <h3>{title}</h3>
      <p>{body}</p>
      {action && <Button onClick={action.onClick}>{action.label}</Button>}
    </div>
  )
}

/** Empty invites one useful action. */
export function EmptyState({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p>{body}</p>
      {children}
    </div>
  )
}

/** Plain navigation back: the classic shell owns the live work and needs no state from here. */
export function ReturnToClassic() {
  return (
    <a className="btn btn-default" href={`?ui=classic${window.location.hash}`}>
      Return to the classic workbench
    </a>
  )
}
