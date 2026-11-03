import { useSyncExternalStore } from 'react'

type ContextListener = () => void

const listeners = new Set<ContextListener>()
let current: string | null = null

/**
 * The chat 'reply-to' context: the work item the next message refers to. Set
 * from a Work board card or a message chip; the Chat composer reads it and
 * sends it as `referencesWorkItem`.
 */
export const workItemContext = {
  get current(): string | null {
    return current
  },
  set(value: string | null): void {
    if (current === value) return
    current = value
    for (const listener of listeners) listener()
  },
  subscribe(listener: ContextListener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

/** React binding: the current reply-to work item, re-rendered on change. */
export function useWorkItemContext(): string | null {
  return useSyncExternalStore(
    (listener) => workItemContext.subscribe(listener),
    () => workItemContext.current,
    () => null,
  )
}
