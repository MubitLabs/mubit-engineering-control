import type { ReactNode } from 'react'

export type BadgeState = 'ok' | 'degraded' | 'error'

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={className ? `card ${className}` : 'card'}>{children}</section>
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
  type = 'button',
  variant = 'default',
}: {
  children: ReactNode
  disabled?: boolean
  onClick?: () => void
  type?: 'button' | 'submit'
  variant?: 'default' | 'primary'
}) {
  return (
    <button
      type={type}
      className={variant === 'primary' ? 'btn btn-primary' : 'btn'}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
