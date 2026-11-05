import { describe, expect, it, vi } from 'vitest'
import { createLayerStack, isSubmitEnter, type KeyInput, keyAction } from '../src/next/keyboard'

const key = (over: Partial<KeyInput>): KeyInput => ({
  key: 'a',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  keyCode: 65,
  typing: false,
  ...over,
})

const closed = { modalOpen: false, paletteOpen: false }
const modal = { modalOpen: true, paletteOpen: false }
const palette = { modalOpen: true, paletteOpen: true }

describe('the layer stack', () => {
  it('Escape reaches only the topmost layer, then the one beneath', () => {
    const stack = createLayerStack()
    const lower = vi.fn()
    const upper = vi.fn()
    const removeLower = stack.push({ modal: false, onEscape: lower })
    const removeUpper = stack.push({ modal: true, onEscape: upper })

    expect(stack.escape()).toBe(true)
    expect(upper).toHaveBeenCalledOnce()
    expect(lower).not.toHaveBeenCalled()

    removeUpper()
    expect(stack.escape()).toBe(true)
    expect(lower).toHaveBeenCalledOnce()

    removeLower()
    expect(stack.escape()).toBe(false)
  })

  it('removes a layer by identity, not by position', () => {
    const stack = createLayerStack()
    const lower = vi.fn()
    const upper = vi.fn()
    const removeLower = stack.push({ modal: false, onEscape: lower })
    stack.push({ modal: false, onEscape: upper })
    removeLower()
    removeLower()
    stack.escape()
    expect(upper).toHaveBeenCalledOnce()
    expect(lower).not.toHaveBeenCalled()
  })

  it('knows whether a modal is open anywhere on the stack', () => {
    const stack = createLayerStack()
    const removeInspector = stack.push({ modal: false, onEscape: () => {} })
    expect(stack.modalOpen()).toBe(false)
    const removeSheet = stack.push({ modal: true, onEscape: () => {} })
    stack.push({ modal: false, onEscape: () => {} })
    expect(stack.modalOpen()).toBe(true)
    removeSheet()
    removeInspector()
    expect(stack.modalOpen()).toBe(false)
  })
})

describe('keyAction', () => {
  it('Cmd or Ctrl+K opens the palette, and closes it when it is the top surface', () => {
    expect(keyAction(key({ key: 'k', metaKey: true }), closed)).toBe('palette')
    expect(keyAction(key({ key: 'k', ctrlKey: true }), closed)).toBe('palette')
    expect(keyAction(key({ key: 'k', metaKey: true, typing: true }), closed)).toBe('palette')
    expect(keyAction(key({ key: 'k', metaKey: true }), palette)).toBe('palette')
  })

  it('does not stack the palette on another modal', () => {
    expect(keyAction(key({ key: 'k', metaKey: true }), modal)).toBeNull()
  })

  it('slash focuses the composer only when nothing is in the way', () => {
    expect(keyAction(key({ key: '/' }), closed)).toBe('focus-composer')
    expect(keyAction(key({ key: '/', typing: true }), closed)).toBeNull()
    expect(keyAction(key({ key: '/', metaKey: true }), closed)).toBeNull()
  })

  it('slash never escapes a modal', () => {
    expect(keyAction(key({ key: '/' }), modal)).toBeNull()
    expect(keyAction(key({ key: '/' }), palette)).toBeNull()
  })

  it('Escape walks the stack but leaves an IME composition alone', () => {
    expect(keyAction(key({ key: 'Escape' }), closed)).toBe('escape')
    expect(keyAction(key({ key: 'Escape', isComposing: true }), closed)).toBeNull()
    expect(keyAction(key({ key: 'Escape', keyCode: 229 }), closed)).toBeNull()
  })

  it('ignores every shortcut while composing', () => {
    expect(keyAction(key({ key: 'k', metaKey: true, isComposing: true }), closed)).toBeNull()
    expect(keyAction(key({ key: '/', isComposing: true }), closed)).toBeNull()
  })
})

describe('isSubmitEnter', () => {
  const enter = { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 }

  it('plain Enter submits', () => {
    expect(isSubmitEnter(enter)).toBe(true)
  })

  it('Shift+Enter is a new line', () => {
    expect(isSubmitEnter({ ...enter, shiftKey: true })).toBe(false)
  })

  it('Enter that commits an IME candidate does not submit', () => {
    expect(isSubmitEnter({ ...enter, isComposing: true })).toBe(false)
    expect(isSubmitEnter({ ...enter, keyCode: 229 })).toBe(false)
  })

  it('other keys do nothing', () => {
    expect(isSubmitEnter({ ...enter, key: 'a' })).toBe(false)
  })
})
