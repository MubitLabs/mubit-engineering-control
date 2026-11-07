import { describe, expect, it } from 'vitest'
import { createDrafts, type DraftBin } from '../src/live/drafts'
import { createSubmissions, draftScope, type Frozen, withoutSent } from '../src/live/submission'

interface Call {
  frozen: Frozen
  ok: () => void
  fail: () => void
}

function rig() {
  const items = new Map<string, string>()
  const bin: DraftBin = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  }
  const drafts = createDrafts(() => bin)
  const calls: Call[] = []
  let counter = 0
  const submissions = createSubmissions({
    drafts,
    newKey: () => `key-${++counter}`,
    send: (frozen) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ frozen, ok: resolve, fail: () => reject(new Error('offline')) })
      }),
  })
  return { drafts, submissions, calls, bin, settle: () => new Promise((done) => setTimeout(done)) }
}

const NEW = { repoId: 'repo_a', intent: 'new' as const }
const FOLLOW = { repoId: 'repo_a', intent: 'follow_up' as const, referencesWorkItem: 'wi_1' }

describe('submission', () => {
  it('double Enter sends once', () => {
    const { submissions, calls } = rig()
    expect(submissions.submit(NEW, 'hello')).toBe(true)
    expect(submissions.submit(NEW, 'hello')).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('two repositories send at the same time', () => {
    const { submissions, calls } = rig()
    submissions.submit(NEW, 'in a')
    submissions.submit({ repoId: 'repo_b', intent: 'new' }, 'in b')
    expect(calls.map((call) => call.frozen.repoId)).toEqual(['repo_a', 'repo_b'])
  })

  it('blank text sends nothing', () => {
    const { submissions, calls } = rig()
    expect(submissions.submit(NEW, '   ')).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('retry reuses key and frozen payload', async () => {
    const { submissions, calls, settle } = rig()
    submissions.submit(FOLLOW, ' hello ')
    calls[0]?.fail()
    await settle()
    expect(submissions.view('repo_a')?.state).toBe('failed')

    expect(submissions.retry('repo_a')).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.frozen).toEqual(calls[0]?.frozen)
    expect(calls[1]?.frozen).toMatchObject({ ...FOLLOW, text: 'hello' })
  })

  it('sending the same text again after a failure reuses the key', async () => {
    const { submissions, calls, settle } = rig()
    submissions.submit(NEW, 'hello')
    calls[0]?.fail()
    await settle()
    submissions.submit(NEW, 'hello ')
    expect(calls[1]?.frozen.key).toBe(calls[0]?.frozen.key)
  })

  it('retry while one is pending does nothing', () => {
    const { submissions, calls } = rig()
    submissions.submit(NEW, 'hello')
    expect(submissions.retry('repo_a')).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('editing while failed rotates the key', async () => {
    const { submissions, calls, settle } = rig()
    submissions.submit(NEW, 'hello')
    calls[0]?.fail()
    await settle()
    submissions.submit(NEW, 'hello there')
    expect(calls[1]?.frozen.key).not.toBe(calls[0]?.frozen.key)
    expect(calls[1]?.frozen.text).toBe('hello there')
  })

  it('changing target rotates the key', async () => {
    const { submissions, calls, settle } = rig()
    submissions.submit(NEW, 'hello')
    calls[0]?.fail()
    await settle()
    submissions.submit(FOLLOW, 'hello')
    expect(calls[1]?.frozen.key).not.toBe(calls[0]?.frozen.key)
    calls[1]?.fail()
    await settle()
    submissions.submit({ ...FOLLOW, referencesWorkItem: 'wi_2' }, 'hello')
    expect(calls[2]?.frozen.key).not.toBe(calls[1]?.frozen.key)
  })

  it('a success spends the key', async () => {
    const { submissions, calls, settle } = rig()
    submissions.submit(NEW, 'hello')
    calls[0]?.ok()
    await settle()
    expect(submissions.view('repo_a')).toBeNull()
    submissions.submit(NEW, 'hello')
    expect(calls[1]?.frozen.key).not.toBe(calls[0]?.frozen.key)
  })

  it('typing during a pending send survives success', async () => {
    const { drafts, submissions, calls, settle } = rig()
    drafts.write('repo_a', 'new', 'hello')
    submissions.submit(NEW, 'hello')
    drafts.write('repo_a', 'new', 'and more')
    calls[0]?.ok()
    await settle()
    expect(drafts.read('repo_a', 'new')).toBe('and more')
  })

  it('a draft rewritten during a pending send is left alone', async () => {
    const { drafts, submissions, calls, settle } = rig()
    drafts.write('repo_a', 'new', 'hello')
    submissions.submit(NEW, 'hello')
    drafts.write('repo_a', 'new', 'something else')
    calls[0]?.ok()
    await settle()
    expect(drafts.read('repo_a', 'new')).toBe('something else')
  })

  it('typing during a pending send survives failure', async () => {
    const { drafts, submissions, calls, settle } = rig()
    drafts.write('repo_a', 'new', 'hello')
    submissions.submit(NEW, 'hello')
    drafts.write('repo_a', 'new', 'hello and more')
    calls[0]?.fail()
    await settle()
    expect(drafts.read('repo_a', 'new')).toBe('hello and more')
    expect(submissions.view('repo_a')?.frozen.text).toBe('hello')
  })

  it('anything typed after the send goes back behind a failed one', async () => {
    const { drafts, submissions, calls, settle } = rig()
    drafts.write('repo_a', 'new', 'hello')
    submissions.submit(NEW, 'hello')
    drafts.write('repo_a', 'new', 'and more')
    calls[0]?.fail()
    await settle()
    expect(drafts.read('repo_a', 'new')).toBe('hello\nand more')
  })

  it('a reload mid-send puts the text back in the box', () => {
    const { bin, drafts, submissions } = rig()
    drafts.write('repo_a', 'new', 'hello')
    submissions.submit(NEW, 'hello')
    const reopened = createDrafts(() => bin)
    const reloaded = createSubmissions({
      drafts: reopened,
      newKey: () => 'never',
      send: async () => {},
    })
    expect(reloaded.view('repo_a')?.state).toBe('failed')
    expect(reopened.read('repo_a', 'new')).toBe('hello')
  })

  it('the box clears on send, and a failed send puts the text back', async () => {
    const { drafts, submissions, calls, settle } = rig()
    drafts.write('repo_a', 'new', 'hello')
    submissions.submit(NEW, 'hello')
    await settle()
    expect(drafts.read('repo_a', 'new')).toBe('')
    calls[0]?.fail()
    await settle()
    expect(drafts.read('repo_a', 'new')).toBe('hello')
    submissions.retry('repo_a')
    calls[1]?.ok()
    await settle()
    expect(drafts.read('repo_a', 'new')).toBe('')
  })

  it('a success clears the draft it was sent from, wherever the owner has gone', async () => {
    const { drafts, submissions, calls, settle } = rig()
    drafts.write('repo_a', draftScope(FOLLOW), 'hello')
    drafts.write('repo_a', 'new', 'a different draft')
    submissions.submit(FOLLOW, 'hello')
    calls[0]?.ok()
    await settle()
    expect(drafts.read('repo_a', draftScope(FOLLOW))).toBe('')
    expect(drafts.read('repo_a', 'new')).toBe('a different draft')
  })

  it('a reload mid-send keeps the key', async () => {
    const { bin, submissions, calls, settle } = rig()
    submissions.submit(NEW, 'hello')
    const sent: Frozen[] = []
    const reloaded = createSubmissions({
      drafts: createDrafts(() => bin),
      newKey: () => 'never',
      send: async (frozen) => void sent.push(frozen),
    })
    expect(reloaded.view('repo_a')?.state).toBe('failed')
    expect(reloaded.submit(NEW, 'hello')).toBe(true)
    expect(sent[0]?.key).toBe(calls[0]?.frozen.key)
    await settle()
    expect(createDrafts(() => bin).pending('repo_a')).toBeNull()
  })

  it('tells a watcher when anything changes', async () => {
    const { submissions, calls, settle } = rig()
    let told = 0
    const stop = submissions.subscribe(() => {
      told += 1
    })
    submissions.submit(NEW, 'hello')
    expect(told).toBe(1)
    calls[0]?.ok()
    await settle()
    expect(told).toBe(2)
    stop()
  })
})

describe('withoutSent', () => {
  it.each([
    ['hello', 'hello', ''],
    ['hello more', 'hello', 'more'],
    ['  hello\n\nmore', 'hello', 'more'],
    ['other', 'hello', 'other'],
  ])('%j less %j is %j', (draft, sent, rest) => {
    expect(withoutSent(draft, sent)).toBe(rest)
  })
})
