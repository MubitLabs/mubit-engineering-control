import type { ButtonHTMLAttributes, ReactNode } from 'react'

/** The prototype's controls (workbench.css class names are the component API). */

export type BtnVariant = 'default' | 'primary' | 'quiet' | 'confirm' | 'danger-text'

export function Btn({
  variant = 'default',
  className,
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnVariant
  ref?: React.Ref<HTMLButtonElement>
} & Record<`data-${string}`, string | undefined>) {
  const variantClass =
    variant === 'primary'
      ? 'btn-primary'
      : variant === 'quiet'
        ? 'btn-quiet'
        : variant === 'confirm'
          ? 'btn-confirm'
          : variant === 'danger-text'
            ? 'btn-quiet btn-danger-text'
            : ''
  return (
    <button
      ref={ref}
      className={className ? `btn ${variantClass} ${className}` : `btn ${variantClass}`.trim()}
      {...rest}
    />
  )
}

export function Empty({ children, hint = false }: { children: ReactNode; hint?: boolean }) {
  return <div className={hint ? 'empty-hint' : 'empty'}>{children}</div>
}

export function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}
