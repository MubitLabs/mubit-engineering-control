import type { ReactNode } from 'react'

/** The setup wizard's one-column steps (§5 First run): done, current (expanded), pending. */

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="steps">{children}</ol>
}

export function Step({
  state,
  title,
  sub,
  children,
}: {
  state: 'done' | 'current' | 'pending'
  title: string
  sub?: ReactNode
  children?: ReactNode
}) {
  return (
    <li className={`step ${state === 'done' ? 'is-done' : state === 'current' ? 'is-current' : ''}`.trim()}>
      <div className="step-mark" aria-hidden="true" />
      <div className="step-body">
        <h2 className="step-title">{title}</h2>
        {sub === undefined ? null : <p className="step-sub">{sub}</p>}
        {children}
      </div>
    </li>
  )
}

export function Option({
  title,
  sub,
  selected = false,
  onClick,
}: {
  title: string
  sub: string
  selected?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className={`option${selected ? ' is-selected' : ''}`} onClick={onClick}>
      <span className="option-title">{title}</span>
      <span className="option-sub">{sub}</span>
    </button>
  )
}

export function StepActions({ children }: { children: ReactNode }) {
  return <div className="step-actions">{children}</div>
}
