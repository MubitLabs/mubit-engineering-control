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

export type KeyAction = 'escape' | 'palette' | 'focus-composer' | null

/** keyCode 229 is the IME's processing key: Safari reports it without `isComposing`. */
const composing = (event: { isComposing: boolean; keyCode: number }) =>
  event.isComposing || event.keyCode === 229

export function keyAction(event: KeyInput, state: { modalOpen: boolean; paletteOpen: boolean }): KeyAction {
  if (composing(event)) return null
  if (event.key === 'Escape') return 'escape'
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    return state.modalOpen && !state.paletteOpen ? null : 'palette'
  }
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return null
  return state.modalOpen || event.typing ? null : 'focus-composer'
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

export function useGlobalKeys(handlers: { onPalette: () => void; onFocusComposer: () => void }): void {
  useEffect(() => {
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
        { modalOpen: layers.modalOpen(), paletteOpen: layers.paletteOpen() },
      )
      if (action === null) return
      event.preventDefault()
      if (action === 'escape') layers.escape()
      else if (action === 'palette') handlers.onPalette()
      else handlers.onFocusComposer()
    }
    window.addEventListener('keydown', onKeydown)
    return () => window.removeEventListener('keydown', onKeydown)
  }, [handlers])
}
