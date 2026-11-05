import type { ChatIntent } from '../api'
import { looksLikeSecret } from './secret-shape'

/**
 * What survives navigation and reload, per repository: drafts, the intent and any unconfirmed
 * submission. Memory always holds the truth for this tab and storage is the copy that outlives
 * it, so a storage that throws costs only the reload. Key-shaped text never reaches storage.
 */

export type DraftBin = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** `previous` lets the composer offer the follow-up back after Clear. */
export type Intent = { kind: 'new'; previous?: string } | { kind: 'follow_up'; workId: string }

export type ResolvedIntent = { kind: 'new' } | { kind: 'follow_up'; workId: string; title: string }

/** Frozen at Send: exactly what is sent, and sent again on Retry. */
export interface Frozen {
  key: string
  repoId: string
  intent: ChatIntent
  referencesWorkItem?: string
  text: string
}

const draftKey = (repoId: string, scope: string) => `mec-next-draft:${repoId}:${scope}`
const intentKey = (repoId: string) => `mec-next-intent:${repoId}`
const pendingKey = (repoId: string) => `mec-next-pending:${repoId}`
const REPO_KEY = 'mec-next-repo'

function parseIntent(raw: string | null): Intent | null {
  try {
    const value = JSON.parse(raw ?? 'null') as { kind?: unknown; workId?: unknown; previous?: unknown }
    if (value?.kind === 'follow_up' && typeof value.workId === 'string') {
      return { kind: 'follow_up', workId: value.workId }
    }
    if (value?.kind !== 'new') return null
    return typeof value.previous === 'string' ? { kind: 'new', previous: value.previous } : { kind: 'new' }
  } catch {
    return null
  }
}

function parseFrozen(raw: string | null): Frozen | null {
  try {
    const value = JSON.parse(raw ?? 'null') as Partial<Frozen> | null
    const valid =
      typeof value?.key === 'string' &&
      typeof value.repoId === 'string' &&
      typeof value.text === 'string' &&
      (value.intent === 'new' || value.intent === 'follow_up')
    return valid ? (value as Frozen) : null
  } catch {
    return null
  }
}

export function createDrafts(storage: () => DraftBin) {
  const memory = new Map<string, string>()
  const intents = new Map<string, Intent>()
  const pending = new Map<string, Frozen | null>()

  const stored = (key: string): string | null => {
    try {
      return storage().getItem(key)
    } catch {
      return null
    }
  }
  const put = (key: string, value: string): void => {
    try {
      storage().setItem(key, value)
    } catch {
      // Memory still holds it for this tab.
    }
  }
  const remove = (key: string): void => {
    try {
      storage().removeItem(key)
    } catch {
      // Nothing was kept that could outlive the tab.
    }
  }

  return {
    read(repoId: string, scope: string): string {
      const key = draftKey(repoId, scope)
      return memory.get(key) ?? stored(key) ?? ''
    },

    write(repoId: string, scope: string, text: string): void {
      const key = draftKey(repoId, scope)
      memory.set(key, text)
      if (text === '' || looksLikeSecret(text)) remove(key)
      else put(key, text)
    },

    /** The composer says so: this draft will not survive a reload. */
    heldInMemory(repoId: string, scope: string): boolean {
      return looksLikeSecret(memory.get(draftKey(repoId, scope)) ?? '')
    },

    intent(repoId: string): Intent {
      const known = intents.get(repoId)
      if (known !== undefined) return known
      return parseIntent(stored(intentKey(repoId))) ?? { kind: 'new' }
    },

    setIntent(repoId: string, intent: Intent): void {
      intents.set(repoId, intent)
      put(intentKey(repoId), JSON.stringify(intent))
    },

    pending(repoId: string): Frozen | null {
      const known = pending.get(repoId)
      if (known !== undefined) return known
      return parseFrozen(stored(pendingKey(repoId)))
    },

    holdPending(frozen: Frozen): void {
      pending.set(frozen.repoId, frozen)
      if (looksLikeSecret(frozen.text)) remove(pendingKey(frozen.repoId))
      else put(pendingKey(frozen.repoId), JSON.stringify(frozen))
    },

    releasePending(repoId: string): void {
      pending.set(repoId, null)
      remove(pendingKey(repoId))
    },

    activeRepo(): string | null {
      return stored(REPO_KEY)
    },

    setActiveRepo(repoId: string | null): void {
      if (repoId === null) remove(REPO_KEY)
      else put(REPO_KEY, repoId)
    },
  }
}

export type Drafts = ReturnType<typeof createDrafts>

/**
 * The intent as the composer shows it. Only the owner sets one: live work never selects itself,
 * which is the classic bug this layer must not repeat. A stopped follow-up stays bound, because
 * §12.1 keeps a reference binding and the server refuses it out loud. `work` is null until the
 * list has loaded.
 */
export function resolveIntent(
  intent: Intent,
  work: readonly { id: string; title?: string }[] | null,
): ResolvedIntent {
  if (intent.kind === 'new') return { kind: 'new' }
  const row = work?.find((item) => item.id === intent.workId)
  if (work !== null && row === undefined) return { kind: 'new' }
  return { kind: 'follow_up', workId: intent.workId, title: row?.title ?? 'this work' }
}
