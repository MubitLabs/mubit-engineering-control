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
  it('no choice gives next', () => {
    expect(resolveShell('', () => memoryStore())).toEqual({ shell: 'next', search: '' })
  })

  it('stored classic wins', () => {
    expect(resolveShell('', () => memoryStore('classic'))).toEqual({ shell: 'classic', search: '' })
  })

  it('is next for an unknown param and writes nothing', () => {
    const store = memoryStore()
    expect(resolveShell('?ui=experimental', () => store).shell).toBe('next')
    expect(store.values.size).toBe(0)
  })

  it('an unknown param leaves a stored classic in charge', () => {
    expect(resolveShell('?ui=nope', () => memoryStore('classic')).shell).toBe('classic')
  })

  it('is next for an unknown stored value', () => {
    expect(resolveShell('', () => memoryStore('classic-ish')).shell).toBe('next')
  })

  it('is next when reading the storage object itself throws', () => {
    expect(resolveShell('', throwing).shell).toBe('next')
    expect(resolveShell('?ui=next', throwing).shell).toBe('next')
  })

  it('is next when storage reads throw', () => {
    const store = { getItem: throwing, setItem: throwing }
    expect(resolveShell('', () => store).shell).toBe('next')
  })

  it('is next when ?ui=classic cannot be stored: the choice never half-applies', () => {
    const store = { getItem: () => null, setItem: throwing }
    expect(resolveShell('?ui=classic', () => store)).toEqual({ shell: 'next', search: '' })
    expect(resolveShell('?ui=classic', throwing)).toEqual({ shell: 'next', search: '' })
  })

  it('?ui=next turns a stored classic off, keeping the rest of the query', () => {
    const store = memoryStore('classic')
    expect(resolveShell('?a=1&ui=next&b=2', () => store)).toEqual({ shell: 'next', search: '?a=1&b=2' })
    expect(store.values.get(UI_SHELL_KEY)).toBe('next')
  })

  it('a stored next survives a reload with no param', () => {
    expect(resolveShell('', () => memoryStore('next'))).toEqual({ shell: 'next', search: '' })
  })

  it('?ui=classic stores the choice and strips the param, so it survives a reload', () => {
    const store = memoryStore()
    expect(resolveShell('?ui=classic', () => store)).toEqual({ shell: 'classic', search: '' })
    expect(store.values.get(UI_SHELL_KEY)).toBe('classic')
    expect(resolveShell('', () => store)).toEqual({ shell: 'classic', search: '' })
  })
})
