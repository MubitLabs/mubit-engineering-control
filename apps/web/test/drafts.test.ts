import { describe, expect, it } from 'vitest'
// Relative on purpose: the web bundle must not depend on @mec/*, so this test is what keeps the
// copy honest.
import { SECRET_PATTERNS } from '../../../packages/contracts/src/secrets'
import { createDrafts, type DraftBin, type Intent, resolveIntent } from '../src/live/drafts'
import { looksLikeSecret, SECRET_SHAPES } from '../src/live/secret-shape'

function memoryBin(): DraftBin & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  }
}

function throwingBin(): DraftBin {
  const deny = () => {
    throw new DOMException('denied', 'SecurityError')
  }
  return { getItem: deny, setItem: deny, removeItem: deny }
}

const SECRET = `sk-ant-${'a'.repeat(40)}`
const row = (id: string, state = 'executing') => ({ id, state, title: `Title of ${id}` })

describe('drafts', () => {
  it('drafts are per repo and intent', () => {
    const bin = memoryBin()
    const drafts = createDrafts(() => bin)
    drafts.write('repo_a', 'new', 'a new')
    drafts.write('repo_a', 'work:wi_1', 'a follow')
    drafts.write('repo_b', 'new', 'b new')

    const reloaded = createDrafts(() => bin)
    expect(reloaded.read('repo_a', 'new')).toBe('a new')
    expect(reloaded.read('repo_a', 'work:wi_1')).toBe('a follow')
    expect(reloaded.read('repo_b', 'new')).toBe('b new')
    expect(reloaded.read('repo_b', 'work:wi_1')).toBe('')
    expect([...bin.items.keys()]).toContain('mec-next-draft:repo_a:work:wi_1')
  })

  it('an emptied draft leaves nothing behind', () => {
    const bin = memoryBin()
    const drafts = createDrafts(() => bin)
    drafts.write('repo_a', 'new', 'x')
    drafts.write('repo_a', 'new', '')
    expect(bin.items.size).toBe(0)
  })

  it('throwing storage keeps the draft in memory', () => {
    const drafts = createDrafts(throwingBin)
    drafts.write('repo_a', 'new', 'still here')
    expect(drafts.read('repo_a', 'new')).toBe('still here')
    drafts.setIntent('repo_a', { kind: 'follow_up', workId: 'wi_1' })
    expect(drafts.intent('repo_a')).toEqual({ kind: 'follow_up', workId: 'wi_1' })
  })

  it('a storage getter that throws keeps the draft in memory', () => {
    const drafts = createDrafts(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    drafts.write('repo_a', 'new', 'still here')
    expect(drafts.read('repo_a', 'new')).toBe('still here')
  })

  it('key-shaped text is never written to storage', () => {
    const bin = memoryBin()
    const drafts = createDrafts(() => bin)
    drafts.write('repo_a', 'new', 'harmless')
    drafts.write('repo_a', 'new', `use ${SECRET} please`)

    expect(drafts.read('repo_a', 'new')).toContain(SECRET)
    expect(drafts.heldInMemory('repo_a', 'new')).toBe(true)
    expect([...bin.items.values()].join('')).not.toContain('sk-ant')
    expect(bin.items.has('mec-next-draft:repo_a:new')).toBe(false)
  })

  it('a key-shaped pending submission is never written to storage', () => {
    const bin = memoryBin()
    const drafts = createDrafts(() => bin)
    drafts.holdPending({ key: 'k1', repoId: 'repo_a', intent: 'new', text: SECRET })
    expect(drafts.pending('repo_a')?.key).toBe('k1')
    expect([...bin.items.values()].join('')).not.toContain('sk-ant')
  })

  it('a pending submission survives reload with its key', () => {
    const bin = memoryBin()
    const frozen = { key: 'k1', repoId: 'repo_a', intent: 'new' as const, text: 'hello' }
    createDrafts(() => bin).holdPending(frozen)
    const reloaded = createDrafts(() => bin)
    expect(reloaded.pending('repo_a')).toEqual(frozen)
    reloaded.releasePending('repo_a')
    expect(createDrafts(() => bin).pending('repo_a')).toBeNull()
  })

  it('a corrupt stored value reads as nothing', () => {
    const bin = memoryBin()
    bin.items.set('mec-next-intent:repo_a', '{not json')
    bin.items.set('mec-next-pending:repo_a', '{"key":1}')
    const drafts = createDrafts(() => bin)
    expect(drafts.intent('repo_a')).toEqual({ kind: 'new' })
    expect(drafts.pending('repo_a')).toBeNull()
  })

  it('secret patterns equal contracts SECRET_PATTERNS', () => {
    const shape = (entries: readonly { name: string; pattern: RegExp }[]) =>
      entries.map(({ name, pattern }) => [name, pattern.source, pattern.flags])
    expect(shape(SECRET_SHAPES)).toEqual(shape(SECRET_PATTERNS))
    expect(looksLikeSecret(SECRET)).toBe(true)
    expect(looksLikeSecret('a plain sentence')).toBe(false)
  })
})

describe('intent', () => {
  it('defaults to a New request', () => {
    expect(createDrafts(memoryBin).intent('repo_a')).toEqual({ kind: 'new' })
  })

  it('Clear intent survives reload', () => {
    const bin = memoryBin()
    const drafts = createDrafts(() => bin)
    drafts.setIntent('repo_a', { kind: 'follow_up', workId: 'wi_1' })
    drafts.setIntent('repo_a', { kind: 'new', previous: 'wi_1' })

    const stored = createDrafts(() => bin).intent('repo_a')
    expect(stored).toEqual({ kind: 'new', previous: 'wi_1' })
    expect(resolveIntent(stored, [row('wi_1')]).kind).toBe('new')
  })

  it('is per repository', () => {
    const drafts = createDrafts(memoryBin)
    drafts.setIntent('repo_a', { kind: 'follow_up', workId: 'wi_1' })
    expect(drafts.intent('repo_b')).toEqual({ kind: 'new' })
  })

  it('live work never selects itself', () => {
    expect(resolveIntent({ kind: 'new' }, [row('wi_1'), row('wi_2')])).toEqual({ kind: 'new' })
  })

  it('a follow-up keeps its own work and reads by title', () => {
    const intent: Intent = { kind: 'follow_up', workId: 'wi_2' }
    expect(resolveIntent(intent, [row('wi_1'), row('wi_2')])).toEqual({
      kind: 'follow_up',
      workId: 'wi_2',
      title: 'Title of wi_2',
    })
  })

  it('a follow-up to stopped work stays bound, for the server to refuse', () => {
    const intent: Intent = { kind: 'follow_up', workId: 'wi_1' }
    expect(resolveIntent(intent, [row('wi_1', 'stopped')]).kind).toBe('follow_up')
  })

  it('a follow-up never shows an id, even before the list has loaded', () => {
    const intent: Intent = { kind: 'follow_up', workId: 'wi_1' }
    expect(resolveIntent(intent, null)).toEqual({ kind: 'follow_up', workId: 'wi_1', title: 'this work' })
  })

  it('a follow-up to work that is gone falls back to a New request', () => {
    expect(resolveIntent({ kind: 'follow_up', workId: 'wi_gone' }, [row('wi_1')])).toEqual({ kind: 'new' })
  })
})
