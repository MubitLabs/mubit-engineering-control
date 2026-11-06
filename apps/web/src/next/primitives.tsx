import { type ButtonHTMLAttributes, type ReactNode, type Ref, useEffect, useRef } from 'react'

export type ButtonVariant = 'default' | 'primary' | 'quiet' | 'text'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  ref?: Ref<HTMLButtonElement>
}

export function Button({ variant = 'default', className, ...rest }: ButtonProps) {
  return <button type="button" className={`btn btn-${variant} ${className ?? ''}`.trim()} {...rest} />
}

/**
 * A button that gives way to the form it opens takes focus with it: into the form on opening, and
 * back to the button on closing, so neither one drops the keyboard on the page.
 */
export function useFormFocus(open: boolean) {
  const opener = useRef<HTMLButtonElement>(null)
  const form = useRef<HTMLDivElement>(null)
  const was = useRef(open)
  useEffect(() => {
    if (was.current === open) return
    was.current = open
    if (open) form.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus()
    else opener.current?.focus()
  }, [open])
  return { opener, form }
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  ref?: Ref<HTMLButtonElement>
}

export function IconButton({ label, className, children, ...rest }: IconButtonProps) {
  return (
    <button type="button" className={`icon-button ${className ?? ''}`.trim()} aria-label={label} {...rest}>
      {children}
    </button>
  )
}

export type StatusTone = 'neutral' | 'attention' | 'good' | 'bad'

/** Words carry the state; the dot only reinforces it. */
export function Status({ tone = 'neutral', children }: { tone?: StatusTone; children: ReactNode }) {
  return (
    <span className="status">
      <span className={`dot dot-${tone}`} aria-hidden="true" />
      {children}
    </span>
  )
}

function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

export const MenuIcon = () => (
  <Icon>
    <path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" />
  </Icon>
)
export const CloseIcon = () => (
  <Icon>
    <path d="M5 5l10 10M15 5L5 15" />
  </Icon>
)
export const CommandIcon = () => (
  <Icon>
    <circle cx="9" cy="9" r="5" />
    <path d="M13 13l3.5 3.5" />
  </Icon>
)
export const PanelIcon = () => (
  <Icon>
    <rect x="3" y="4" width="14" height="12" rx="2" />
    <path d="M12.5 4v12" />
  </Icon>
)
export const ChevronIcon = () => (
  <Icon size={14}>
    <path d="M7.5 5l5 5-5 5" />
  </Icon>
)
export const UpDownIcon = () => (
  <Icon size={14}>
    <path d="M6.5 8l3.5-3.5L13.5 8M6.5 12l3.5 3.5 3.5-3.5" />
  </Icon>
)
export const SendIcon = () => (
  <Icon>
    <path d="M10 16V4M5 9l5-5 5 5" />
  </Icon>
)
export const ThemeIcon = () => (
  <Icon>
    <circle cx="10" cy="10" r="6.5" />
    <path d="M10 3.5a6.5 6.5 0 0 1 0 13z" fill="currentColor" />
  </Icon>
)
export const ConversationIcon = () => (
  <Icon>
    <path d="M4 4h12v9H9l-4 3v-3H4z" />
  </Icon>
)
export const WorkIcon = () => (
  <Icon>
    <rect x="3.5" y="4" width="13" height="12" rx="2" />
    <path d="M7 3v3m6-3v3M6 9h8m-8 4h5" />
  </Icon>
)
export const NeedsIcon = () => (
  <Icon>
    <path d="M10 3l7 13H3zM10 8v3.5m0 2v.5" />
  </Icon>
)
export const ConnectionsIcon = () => (
  <Icon>
    <path d="M8 12l4-4M7.5 9L5 11.5a2.5 2.5 0 0 0 3.5 3.5L11 12.500M9 7.500L11.500 5A2.500 2.500 0 0 1 15 8.500L12.500 11" />
  </Icon>
)
export const SetupIcon = () => (
  <Icon>
    <path d="M4 5.500h1.500l1 1 2-2M4 10.500h1.500l1 1 2-2M11 6h5.500M11 11h5.500M4 15.500h12.500" />
  </Icon>
)
export const SettingsIcon = () => (
  <Icon>
    <path d="M3.500 6h7M14.500 6h2M3.500 14h2M9.500 14h7" />
    <circle cx="12.500" cy="6" r="2" />
    <circle cx="7.500" cy="14" r="2" />
  </Icon>
)
