import { useEffect } from 'react'

/**
 * One keyboard layer for the shell. A layer is anything Escape can dismiss: a modal, the
 * wide inspector, an armed approval. The most recent layer is the topmost surface.
 */
export interface Layer {
  modal: boolean
  onEscape: () => void
  /** The overlay root of a modal layer, so everything beneath it can go inert. */
  element?: HTMLElement | null
  palette?: boolean
}

export interface LayerStack {
  push(layer: Layer): () => void
  escape(): boolean
  modalOpen(): boolean
  paletteOpen(): boolean
  entries(): readonly Layer[]
}

export function createLayerStack(): LayerStack {
  let layers: Layer[] = []
  return {
    push(layer) {
      layers = [...layers, layer]
      return () => {
        layers = layers.filter((entry) => entry !== layer)
      }
    },
    escape() {
      const top = layers[layers.length - 1]
      top?.onEscape()
      return top !== undefined
    },
    modalOpen: () => layers.some((layer) => layer.modal),
    paletteOpen: () => layers.some((layer) => layer.palette === true),
    entries: () => layers,
  }
}

/** The shell's single stack: every surface shares one Escape order. */
export const layers = createLayerStack()

export interface KeyInput {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing: boolean
  keyCode: number
  typing: boolean
}

export type KeyAction =
  | 'escape'
  | 'palette'
  | 'focus-composer'
  | 'next-card'
  | 'approve-card'
  | 'go-prefix'
  | 'go-work'
  | null

/** keyCode 229 is the IME's processing key: Safari reports it without `isComposing`. */
const composing = (event: { isComposing: boolean; keyCode: number }) =>
  event.isComposing || event.keyCode === 229

export function keyAction(
  event: KeyInput,
  state: { modalOpen: boolean; paletteOpen: boolean; pendingGo?: boolean },
): KeyAction {
  if (composing(event)) return null
  if (event.key === 'Escape') return 'escape'
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    return state.modalOpen && !state.paletteOpen ? null : 'palette'
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  if (event.key === '/') return state.modalOpen || event.typing ? null : 'focus-composer'
  // The single-key shortcuts: never in a field, under a modal or with Shift.
  if (event.shiftKey || event.typing || state.modalOpen) return null
  const letter = event.key.toLowerCase()
  if (state.pendingGo) return letter === 'w' ? 'go-work' : null
  if (letter === 'j') return 'next-card'
  if (letter === 'a') return 'approve-card'
  if (letter === 'g') return 'go-prefix'
  return null
}

/** How long a G waits for its second key. */
export const GO_WINDOW_MS = 800

/** Open, on screen and not behind an inert or hidden ancestor: a stale card is none of these. */
function openCards(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.decision[data-state="open"]')).filter(
    (card) => card.offsetParent !== null && card.closest('[inert], [aria-hidden="true"]') === null,
  )
}

function focusedCard(cards: readonly HTMLElement[]): HTMLElement | undefined {
  const active = document.activeElement
  return cards.find((card) => active instanceof Node && card.contains(active))
}

/** J: the card after the focused one, or the first. Lands on its heading, which takes focus. */
export function focusNextCard(): boolean {
  const cards = openCards()
  const at = focusedCard(cards)
  const next = cards[at === undefined ? 0 : Math.min(cards.length - 1, cards.indexOf(at) + 1)]
  const heading = next?.querySelector<HTMLElement>('h2')
  heading?.focus()
  return heading !== undefined && heading !== null
}

/**
 * A: the same first step as the pointer. It presses the card's own Approve button, which only
 * arms, and leaves focus on the armed button so Enter or a click is the confirm. A card that is
 * already armed, disabled or settled is left alone: A never confirms.
 */
export function armFocusedCard(): boolean {
  const card = focusedCard(openCards())
  // The Approve button by name, never "the first unarmed button": once Approve is armed that
  // would be Deny, and a second A must not deny.
  const approve = card?.querySelector<HTMLButtonElement>('button[data-approve]')
  if (approve === null || approve === undefined || approve.disabled) return false
  if (approve.getAttribute('data-armed') !== 'false') return false
  if (approve.getAttribute('aria-disabled') === 'true') return false
  approve.click()
  approve.focus()
  return true
}

export function isSubmitEnter(event: {
  key: string
  shiftKey: boolean
  isComposing: boolean
  keyCode: number
}): boolean {
  return event.key === 'Enter' && !event.shiftKey && !composing(event)
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export function useGlobalKeys(handlers: {
  onPalette: () => void
  onFocusComposer: () => void
  onGoWork: () => void
}): void {
  useEffect(() => {
    let pendingGo = false
    let goTimer: ReturnType<typeof setTimeout> | undefined
    const endGo = () => {
      pendingGo = false
      clearTimeout(goTimer)
    }
    const onKeydown = (event: KeyboardEvent) => {
      const action = keyAction(
        {
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          isComposing: event.isComposing,
          keyCode: event.keyCode,
          typing: isTyping(event.target),
        },
        { modalOpen: layers.modalOpen(), paletteOpen: layers.paletteOpen(), pendingGo },
      )
      // Any key that is not the second half of a go-to ends it.
      if (action !== 'go-prefix') endGo()
      if (action === null) return
      if (action === 'go-prefix') {
        pendingGo = true
        goTimer = setTimeout(endGo, GO_WINDOW_MS)
        return
      }
      if (action === 'next-card') {
        if (focusNextCard()) event.preventDefault()
        return
      }
      if (action === 'approve-card') {
        if (armFocusedCard()) event.preventDefault()
        return
      }
      event.preventDefault()
      if (action === 'escape') layers.escape()
      else if (action === 'palette') handlers.onPalette()
      else if (action === 'go-work') handlers.onGoWork()
      else handlers.onFocusComposer()
    }
    window.addEventListener('keydown', onKeydown)
    return () => {
      endGo()
      window.removeEventListener('keydown', onKeydown)
    }
  }, [handlers])
}
