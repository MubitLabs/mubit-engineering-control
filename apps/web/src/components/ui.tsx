import type { ReactNode } from 'react'

export type BadgeState = 'ok' | 'degraded' | 'error'

export function Card({ children }: { children: ReactNode }) {
  return <section className="card">{children}</section>
}

export function Badge({ label, state }: { label: string; state: BadgeState }) {
  return <span className={`badge badge-${state}`}>{label}</span>
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

export function Button({
  children,
  disabled = false,
  onClick,
  variant = 'default',
}: {
  children: ReactNode
  disabled?: boolean
  onClick?: () => void
  variant?: 'default' | 'primary'
}) {
  return (
    <button
      type="button"
      className={variant === 'primary' ? 'btn btn-primary' : 'btn'}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
