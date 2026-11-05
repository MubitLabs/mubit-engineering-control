import { type KeyboardEvent, type ReactNode, type RefObject, useId, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { layers } from './keyboard'
import { CloseIcon, IconButton } from './primitives'

export type SheetVariant = 'dialog' | 'drawer' | 'sheet' | 'palette'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'

/** Makes the page and every modal but the top one inert. Inert already blocks pointer and AT. */
function syncInert(): void {
  const modals = layers.entries().filter((layer) => layer.modal)
  const top = modals[modals.length - 1]
  const page = document.getElementById('root')
  if (page) page.inert = modals.length > 0
  for (const layer of modals) {
    if (layer.element) layer.element.inert = layer !== top
  }
}

/** Focus goes back where it came from, or to the page if that was nowhere or has since gone. */
export function restoreFocus(opener: HTMLElement | null): void {
  if (opener?.isConnected && opener !== document.body && !opener.closest('[inert]')) {
    opener.focus()
    return
  }
  document.querySelector<HTMLElement>('[data-focus-fallback]')?.focus()
}

interface SheetProps {
  variant: SheetVariant
  /** Rendered as the dialog's heading, with a close button beside it. */
  title?: string
  /** The accessible name when the content supplies its own heading. */
  labelledBy?: string
  onClose: () => void
  /** Where focus returns. Defaults to whatever held focus when this opened. */
  returnFocus?: RefObject<HTMLElement | null>
  /** Receives focus on open. Defaults to the first focusable control. */
  initialFocus?: RefObject<HTMLElement | null>
  palette?: boolean
  children: ReactNode
}

/** Every overlay in the shell: scrim, inert page, trapped Tab, Escape and focus return. */
export function Sheet({
  variant,
  title,
  labelledBy,
  onClose,
  returnFocus,
  initialFocus,
  palette = false,
  children,
}: SheetProps) {
  const overlay = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const returnRef = useRef(returnFocus)
  returnRef.current = returnFocus
  const titleId = useId()

  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const remove = layers.push({
      modal: true,
      palette,
      element: overlay.current,
      onEscape: () => onCloseRef.current(),
    })
    syncInert()
    const first = initialFocus?.current ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? panel.current)?.focus()
    return () => {
      remove()
      syncInert()
      restoreFocus(returnRef.current?.current ?? opener)
    }
  }, [palette, initialFocus])

  const trapTab = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !panel.current) return
    const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first || !last) {
      event.preventDefault()
      return
    }
    const active = document.activeElement
    if (event.shiftKey && (active === first || active === panel.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div ref={overlay} className={`overlay overlay-${variant}`}>
      {/* A pointer convenience: keyboard users close with Escape or the close button. */}
      <div className="scrim" data-scrim aria-hidden="true" onClick={() => onClose()} />
      <div
        ref={panel}
        className="panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? titleId}
        tabIndex={-1}
        onKeyDown={trapTab}
      >
        {title !== undefined && (
          <header className="panel-head">
            <h2 id={titleId}>{title}</h2>
            <IconButton label="Close" onClick={() => onClose()}>
              <CloseIcon />
            </IconButton>
          </header>
        )}
        {children}
      </div>
    </div>,
    document.body,
  )
}
