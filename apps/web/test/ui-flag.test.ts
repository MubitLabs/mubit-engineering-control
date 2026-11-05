import { describe, expect, it } from 'vitest'
import { resolveShell, UI_SHELL_KEY } from '../src/ui-flag'

function memoryStore(initial?: string) {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set(UI_SHELL_KEY, initial)
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

const throwing = (): never => {
  throw new DOMException('denied', 'SecurityError')
}

describe('resolveShell', () => {
  it('is classic when nothing asks for next', () => {
    expect(resolveShell('', () => memoryStore())).toEqual({ shell: 'classic', search: '' })
  })

  it('is classic for an unknown param and writes nothing', () => {
    const store = memoryStore()
    expect(resolveShell('?ui=experimental', () => store).shell).toBe('classic')
    expect(store.values.size).toBe(0)
  })

  it('is classic for an unknown stored value', () => {
    expect(resolveShell('', () => memoryStore('next-ish')).shell).toBe('classic')
  })

  it('is classic when reading the storage object itself throws', () => {
    expect(resolveShell('', throwing).shell).toBe('classic')
    expect(resolveShell('?ui=next', throwing).shell).toBe('classic')
  })

  it('is classic when storage reads throw', () => {
    const store = { getItem: throwing, setItem: throwing }
    expect(resolveShell('', () => store).shell).toBe('classic')
  })

  it('is classic when ?ui=next cannot be stored: the flag never half-applies', () => {
    const store = { getItem: () => null, setItem: throwing }
    expect(resolveShell('?ui=next', () => store)).toEqual({ shell: 'classic', search: '' })
  })

  it('?ui=next stores the choice and strips the param, keeping the rest of the query', () => {
    const store = memoryStore()
    expect(resolveShell('?a=1&ui=next&b=2', () => store)).toEqual({ shell: 'next', search: '?a=1&b=2' })
    expect(store.values.get(UI_SHELL_KEY)).toBe('next')
  })

  it('a stored next survives a reload with no param', () => {
    expect(resolveShell('', () => memoryStore('next'))).toEqual({ shell: 'next', search: '' })
  })

  it('?ui=classic turns a stored next off', () => {
    const store = memoryStore('next')
    expect(resolveShell('?ui=classic', () => store)).toEqual({ shell: 'classic', search: '' })
    expect(store.values.get(UI_SHELL_KEY)).toBe('classic')
  })

  it('an unknown param does not reach a stored next', () => {
    expect(resolveShell('?ui=nope', () => memoryStore('next')).shell).toBe('classic')
  })
})
