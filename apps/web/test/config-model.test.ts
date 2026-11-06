import { describe, expect, it } from 'vitest'
import {
  type Capabilities,
  type ConnectionRow,
  canRetire,
  capabilityGate,
  checksText,
  connectionActions,
  draftsFor,
  type Editor,
  editDraft,
  foldDiff,
  impactLines,
  lineDiff,
  loadEditor,
  metaChoices,
  openStage,
  parseChecks,
  parseLines,
  proposalBase,
  rebaseDraft,
  roleOfPart,
  saveBar,
  saveFailed,
  saveStarted,
  saveSucceeded,
} from '../src/next/config-model'

const editor = (over: Partial<Editor> = {}): Editor => ({
  base: 'saved',
  version: 'v1',
  draft: null,
  save: { kind: 'idle' },
  ...over,
})

const NONE: Capabilities = {
  switchWork: false,
  drain: false,
  backups: false,
  isolationEdit: false,
  pause: false,
}

const row = (over: Partial<ConnectionRow> = {}): ConnectionRow => ({
  id: 'slot_a',
  label: 'a',
  engine: 'claude',
  kind: 'claude-sub',
  provider: 'anthropic',
  state: 'healthy',
  linked: false,
  credential: 'sign_in',
  usage: null,
  pin: null,
  pair: null,
  ...over,
})

describe('the save state of one block', () => {
  it('409 keeps the draft', () => {
    const edited = editDraft(editor(), 'mine')
    const failed = saveFailed(saveStarted(edited), { message: 'newer', stale: true })
    expect(failed.draft).toBe('mine')
    expect(failed.version).toBe('v1')
    expect(failed.save).toEqual({ kind: 'failed', message: 'newer', stale: true })
  })

  it('a read of a newer version never moves a draft onto it silently', () => {
    const edited = editDraft(editor(), 'mine')
    const reread = loadEditor(edited, 'theirs', 'v2')
    expect(reread).toEqual(edited)
    expect(loadEditor(editor(), 'theirs', 'v2')).toMatchObject({ base: 'theirs', version: 'v2' })
    expect(loadEditor(undefined, 'first', 'v1')).toMatchObject({ base: 'first', draft: null })
  })

  it('moves a kept draft onto the newest version only when asked', () => {
    const failed = saveFailed(editDraft(editor(), 'mine'), { message: 'newer', stale: true })
    expect(rebaseDraft(failed, 'theirs', 'v2')).toMatchObject({
      base: 'theirs',
      version: 'v2',
      draft: 'mine',
      save: { kind: 'idle' },
    })
  })

  it('typing back to the saved text is no draft', () => {
    expect(editDraft(editDraft(editor(), 'mine'), 'saved').draft).toBeNull()
  })

  it('only a confirmed save moves the base', () => {
    const saving = saveStarted(editDraft(editor(), 'mine'))
    expect(saving.base).toBe('saved')
    expect(saving.draft).toBe('mine')
    expect(saveSucceeded(saving, 'mine', 'v2')).toMatchObject({
      base: 'mine',
      version: 'v2',
      draft: null,
      save: { kind: 'saved' },
    })
  })
})

describe('the save bar', () => {
  it('save bar appears only for a draft, a save or a failure', () => {
    expect(saveBar(editor()).visible).toBe(false)
    expect(saveBar(editor({ save: { kind: 'saved' } })).visible).toBe(false)
    expect(saveBar(editDraft(editor(), 'mine')).visible).toBe(true)
    expect(saveBar(saveStarted(editDraft(editor(), 'mine'))).visible).toBe(true)
    expect(saveBar(editor({ save: { kind: 'failed', message: 'x', stale: false } })).visible).toBe(true)
  })

  it('cannot save twice or while nothing is drafted', () => {
    expect(saveBar(saveStarted(editDraft(editor(), 'mine'))).canSave).toBe(false)
    expect(saveBar(editDraft(editor(), 'mine')).canSave).toBe(true)
  })

  it('a stale failure says the draft is kept and offers the newest version', () => {
    const view = saveBar(saveFailed(editDraft(editor(), 'mine'), { message: 'newer', stale: true }))
    expect(view.message).toMatch(/kept/i)
    expect(view.stale).toBe(true)
    expect(view.canSave).toBe(false)
  })

  it('a validation failure shows the server’s words and can be saved again', () => {
    const view = saveBar(saveFailed(editDraft(editor(), 'mine'), { message: 'bad field', stale: false }))
    expect(view.message).toContain('bad field')
    expect(view.canSave).toBe(true)
  })
})

describe('capabilities', () => {
  it('unavailable capability disables with a reason', () => {
    const gate = capabilityGate(NONE, 'backups')
    expect(gate.enabled).toBe(false)
    expect(gate.reason).toMatch(/\S/)
    for (const name of ['switchWork', 'drain', 'isolationEdit', 'pause'] as const) {
      expect(capabilityGate(NONE, name).reason).toMatch(/\S/)
    }
    expect(capabilityGate({ ...NONE, backups: true }, 'backups')).toEqual({ enabled: true })
  })

  it('an unread capability is not an available one', () => {
    expect(capabilityGate(null, 'backups').enabled).toBe(false)
  })
})

describe('connection actions', () => {
  it('an expired sign-in offers Sign in again and no key controls', () => {
    const actions = connectionActions(row({ state: 'degraded', stateReason: 'auth_expired' }))
    expect(actions.signIn).toBe('card')
    expect(actions.replaceKey).toBe(false)
  })

  it('a linked login signs in through the vendor’s own terminal, not a card', () => {
    const actions = connectionActions(row({ linked: true, state: 'degraded', stateReason: 'auth_expired' }))
    expect(actions.signIn).toBe('terminal')
  })

  it('an API-key slot validates and replaces, and never offers sign-in', () => {
    const actions = connectionActions(
      row({ credential: 'api_key', kind: 'claude-api', state: 'degraded', stateReason: 'key_rejected' }),
    )
    expect(actions).toMatchObject({ signIn: null, replaceKey: true, validate: true, probe: false })
  })
})

describe('retire', () => {
  it('stays shut until the exact label is typed', () => {
    expect(canRetire('max-1', 'max-1')).toBe(true)
    for (const typed of ['', 'max', 'MAX-1', ' max-1']) expect(canRetire(typed, 'max-1')).toBe(false)
  })

  it('names the loss and the work it touches', () => {
    const lines = impactLines({
      slotId: 'slot_a',
      label: 'a',
      running: 2,
      queued: 1,
      metaSlot: true,
      keyStored: true,
    })
    expect(lines.join(' ')).toMatch(/destroyed/)
    expect(lines.join(' ')).toMatch(/cannot be recovered/)
    expect(lines.join(' ')).toMatch(/2 running/)
    expect(lines.join(' ')).toMatch(/1 queued/)
    expect(lines.join(' ')).toMatch(/meta agent/)
  })

  it('does not claim a key where none is stored', () => {
    const lines = impactLines({
      slotId: 'slot_a',
      label: 'a',
      running: 0,
      queued: 0,
      metaSlot: false,
      keyStored: false,
    })
    expect(lines.join(' ')).not.toMatch(/destroyed/)
    expect(lines.join(' ')).toMatch(/no work/i)
  })
})

describe('setup', () => {
  const stage = (id: string, status: 'done' | 'missing' | 'skipped') => ({
    id,
    title: id,
    status,
    detail: '',
    next: null,
  })

  it('opens the first stage that is neither done nor skipped', () => {
    expect(openStage([stage('a', 'done'), stage('b', 'skipped'), stage('c', 'missing')])).toBe('c')
    expect(openStage([stage('a', 'done')])).toBeNull()
  })

  it('offers only what the server calls usable and says why the rest are not', () => {
    const choices = metaChoices([
      { id: 's1', label: 'one', engine: 'claude', kind: 'claude-sub', state: 'healthy', usable: true },
      {
        id: 's2',
        label: 'two',
        engine: 'codex',
        kind: 'codex-sub',
        state: 'healthy',
        usable: false,
        reason: 'two runs codex',
      },
    ])
    expect(choices.usable.map((slot) => slot.id)).toEqual(['s1'])
    expect(choices.refused).toEqual([{ id: 's2', label: 'two', reason: 'two runs codex' }])
  })
})

describe('repository forms', () => {
  it('reads one command a line', () => {
    expect(parseLines('pnpm install\n\n  pnpm build  \n')).toEqual(['pnpm install', 'pnpm build'])
  })

  it('reads a check as name: command, naming one that has no name', () => {
    expect(parseChecks('test: pnpm test\npnpm lint')).toEqual([
      { name: 'test', cmd: 'pnpm test' },
      { name: 'check_2', cmd: 'pnpm lint' },
    ])
  })

  it('writes checks back as it reads them', () => {
    const checks = [{ name: 'test', cmd: 'pnpm test' }]
    expect(parseChecks(checksText(checks))).toEqual(checks)
  })
})

describe('proposals', () => {
  it('shows pending drafts for this section only', () => {
    const draft = (id: string, target: string, status: string) => ({
      id,
      target,
      reason: 'r',
      diff: 'd',
      status,
      createdAt: '',
    })
    const drafts = [
      draft('a', 'policy', 'pending'),
      draft('b', 'models', 'pending'),
      draft('c', 'policy', 'applied'),
    ]
    expect(draftsFor(drafts, 'policy').map((entry) => entry.id)).toEqual(['a'])
  })

  it('applies against the version its comparison was drawn from, not the newest read', () => {
    const shown = {
      id: 'a',
      target: 'policy',
      reason: 'r',
      diff: 'd',
      status: 'pending',
      createdAt: '',
      preview: { base: 'shown', changes: [] },
    }
    expect(proposalBase(shown, 'newest')).toBe('shown')
    const { preview: _none, ...plain } = shown
    expect(proposalBase(plain, 'newest')).toBe('newest')
    expect(proposalBase({ ...plain, preview: { base: 0, changes: [] } }, 7)).toBe(0)
  })
})

describe('a part’s role', () => {
  it('reads flat and nested role parts, and nothing else', () => {
    expect(roleOfPart('roles/reviewer.md')).toBe('reviewer')
    expect(roleOfPart('roles/meta_agent/protocol.md')).toBe('meta_agent')
    expect(roleOfPart('shared/rules.md')).toBeNull()
  })
})

describe('compare', () => {
  it('marks added and removed lines and keeps the rest', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
    ])
  })

  const table = Array.from({ length: 88 }, (_, index) => `line ${index}`)
  const edited = (...at: number[]) => table.map((line, index) => (at.includes(index) ? `${line} new` : line))
  const shown = (before: string[], after: string[]) => foldDiff(lineDiff(before.join('\n'), after.join('\n')))
  const isFold = (row: ReturnType<typeof shown>[number]) => row.kind === 'fold'

  it('folds the unchanged run before a change, so the change is near the top', () => {
    const rows = shown(table, edited(80))
    expect(rows.findIndex((row) => row.kind === 'removed')).toBe(4)
    expect(rows.slice(0, 4).map((row) => row.kind)).toEqual(['fold', 'same', 'same', 'same'])
    expect(rows.filter(isFold)).toHaveLength(2)
  })

  it('keeps every line: a fold holds what it hides, in order', () => {
    const lines = lineDiff(table.join('\n'), edited(5, 60).join('\n'))
    const unfolded = foldDiff(lines).flatMap((row) => (row.kind === 'fold' ? row.lines : [row]))
    expect(unfolded).toEqual(lines)
  })

  it('never folds a changed line, and keeps context on both sides of each change', () => {
    const rows = shown(table, edited(20, 60))
    for (const row of rows) {
      if (row.kind === 'fold') expect(row.lines.every((line) => line.kind === 'same')).toBe(true)
    }
    expect(rows.map((row) => row.kind)).toEqual([
      'fold',
      ...['same', 'same', 'same', 'removed', 'added', 'same', 'same', 'same'],
      'fold',
      ...['same', 'same', 'same', 'removed', 'added', 'same', 'same', 'same'],
      'fold',
    ])
  })

  it('leaves a short comparison whole: folding one line saves nothing', () => {
    expect(shown(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd', 'x']).some(isFold)).toBe(false)
    expect(shown(['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'b', 'c', 'd', 'e', 'x']).some(isFold)).toBe(true)
  })

  it('folds a comparison with no change into one row', () => {
    const rows = shown(table, table)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('fold')
  })
})
