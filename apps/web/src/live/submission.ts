import type { ChatIntent } from '../api'
import type { Drafts, Frozen } from './drafts'

export type { Frozen } from './drafts'

/**
 * One submission at a time per repository (Internal design 8). A Send freezes the exact payload
 * and its key; the draft stays separate, so typing during a send is never lost and only a
 * confirmed success removes the sent text. A failed or uncertain send keeps the object: Retry
 * resends it with the same key, and any edit to the text, target or intent gets a new one.
 *
 * This object is the guard. It changes synchronously inside the keydown, where React state
 * would still show the last render and let a double Enter through.
 */

export interface SubmissionTarget {
  repoId: string
  intent: ChatIntent
  referencesWorkItem?: string
}

export interface Submission {
  frozen: Frozen
  state: 'pending' | 'failed'
  /** Absent when a reload interrupted the send, so the outcome is unknown. */
  error?: unknown
}

export const draftScope = (target: { referencesWorkItem?: string }): string =>
  target.referencesWorkItem === undefined ? 'new' : `work:${target.referencesWorkItem}`

/** A success removes only what was sent: anything typed since stays, and a rewrite is left alone. */
export function withoutSent(draft: string, sent: string): string {
  const rest = draft.trimStart()
  return rest.startsWith(sent) ? rest.slice(sent.length).trimStart() : draft
}

const samePayload = (a: Frozen, b: Omit<Frozen, 'key'>): boolean =>
  a.repoId === b.repoId &&
  a.intent === b.intent &&
  a.referencesWorkItem === b.referencesWorkItem &&
  a.text === b.text

export function createSubmissions(deps: {
  drafts: Pick<Drafts, 'read' | 'write' | 'pending' | 'holdPending' | 'releasePending'>
  newKey: () => string
  send: (frozen: Frozen) => Promise<void>
}) {
  const current = new Map<string, Submission>()
  const watchers = new Set<() => void>()
  const changed = () => {
    for (const watcher of watchers) watcher()
  }

  const view = (repoId: string): Submission | null => {
    const known = current.get(repoId)
    if (known !== undefined) return known
    const restored = deps.drafts.pending(repoId)
    return restored === null ? null : { frozen: restored, state: 'failed' }
  }

  const launch = async (frozen: Frozen): Promise<void> => {
    current.set(frozen.repoId, { frozen, state: 'pending' })
    deps.drafts.holdPending(frozen)
    changed()
    try {
      await deps.send(frozen)
    } catch (error) {
      current.set(frozen.repoId, { frozen, state: 'failed', error })
      changed()
      return
    }
    current.delete(frozen.repoId)
    deps.drafts.releasePending(frozen.repoId)
    const scope = draftScope(frozen)
    deps.drafts.write(frozen.repoId, scope, withoutSent(deps.drafts.read(frozen.repoId, scope), frozen.text))
    changed()
  }

  return {
    view,

    /** False when nothing was sent: blank text, or one already in flight for this repository. */
    submit(target: SubmissionTarget, draft: string): boolean {
      const text = draft.trim()
      if (text === '') return false
      const held = view(target.repoId)
      if (held?.state === 'pending') return false
      const payload = { ...target, text }
      const key = held !== null && samePayload(held.frozen, payload) ? held.frozen.key : deps.newKey()
      void launch({ ...payload, key })
      return true
    },

    retry(repoId: string): boolean {
      const held = view(repoId)
      if (held === null || held.state === 'pending') return false
      void launch(held.frozen)
      return true
    },

    subscribe(watcher: () => void): () => void {
      watchers.add(watcher)
      return () => {
        watchers.delete(watcher)
      }
    },
  }
}

export type Submissions = ReturnType<typeof createSubmissions>
