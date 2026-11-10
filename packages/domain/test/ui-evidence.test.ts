// §14, §15: a repository that requires UI evidence holds a user-visible change back from `ready`
// until MEC has before and after screenshots of the same scenario, on the right commits.
import { describe, expect, it } from 'vitest'
import {
  type AcceptanceInput,
  acceptance,
  parseUiEvidence,
  stageOf,
  UI_EVIDENCE_FAILED,
  UI_EVIDENCE_WAITING,
  UI_PATTERNS,
  type UiEvidenceInput,
  uiEvidenceSetting,
  uiEvidenceVerdict,
  userVisible,
  workViewOf,
} from '../src'

const BASE = 'b'.repeat(40)
const HEAD = 'a'.repeat(40)

const input = (over: Partial<AcceptanceInput> = {}): AcceptanceInput => ({
  attemptState: 'succeeded',
  head: HEAD,
  base: BASE,
  changed: ['index.html'],
  required: ['unit'],
  verdicts: [{ name: 'unit', status: 'passed', sha: HEAD }],
  findings: [],
  policy: { sensitive: false },
  ...over,
})

const shot = { path: '/', file: 'before-1.png', bytes: 10, at: '2026-11-10T10:00:00.000Z', status: 200 }
const both = (over: Partial<UiEvidenceInput['captures']> = {}): UiEvidenceInput => ({
  userVisible: true,
  base: BASE,
  captures: {
    before: { sha: BASE, status: 'captured', shots: [shot] },
    after: { sha: HEAD, status: 'captured', shots: [{ ...shot, file: 'after-1.png' }] },
    ...over,
  },
})

describe('which changes users see (§15)', () => {
  it('markup, styles, scripts, components and assets count', () => {
    for (const file of [
      'index.html',
      'style.css',
      'app.js',
      'src/App.tsx',
      'src/Card.jsx',
      'src/Page.vue',
      'src/Nav.svelte',
      'assets/logo.bin',
      'public/favicon.ico',
      'img/horse.png',
    ]) {
      expect(userVisible([file], UI_PATTERNS), file).toBe(true)
    }
  })

  it('docs, config and server code do not', () => {
    expect(userVisible(['README.md', 'package.json', 'server/main.ts', '.github/ci.yml'], UI_PATTERNS)).toBe(
      false,
    )
    expect(userVisible([], UI_PATTERNS)).toBe(false)
  })

  it('a repository’s own globs replace the defaults', () => {
    expect(userVisible(['app.js'], ['web/**'])).toBe(false)
    expect(userVisible(['web/deep/x.ts'], ['web/**'])).toBe(true)
    expect(userVisible(['top.css'], ['*.css'])).toBe(true)
    expect(userVisible(['nested/top.css'], ['*.css'])).toBe(false)
  })

  it('a pattern matches whole paths, not a prefix or a substring', () => {
    expect(userVisible(['index.html.orig'], ['**/*.html'])).toBe(false)
    expect(userVisible(['xassets/a'], ['assets/**'])).toBe(false)
  })
})

describe('the repository setting (§14)', () => {
  it('is off unless the record says required', () => {
    expect(uiEvidenceSetting(undefined).required).toBe(false)
    expect(uiEvidenceSetting({ required: 'yes' }).required).toBe(false)
    expect(uiEvidenceSetting({ required: true })).toEqual({
      required: true,
      paths: ['/'],
      patterns: UI_PATTERNS,
    })
  })

  it('parses a start command, scenario paths and globs', () => {
    expect(
      parseUiEvidence({
        required: true,
        start: { argv: ['npm', 'start'], port: 3000 },
        paths: ['/', '/about.html'],
        patterns: ['web/**'],
      }),
    ).toEqual({
      required: true,
      start: { argv: ['npm', 'start'], port: 3000 },
      paths: ['/', '/about.html'],
      patterns: ['web/**'],
    })
    expect(parseUiEvidence({ required: false })).toEqual({
      required: false,
      paths: ['/'],
      patterns: UI_PATTERNS,
    })
  })

  it('refuses what it cannot run or reach, in words', () => {
    expect(() => parseUiEvidence({ required: 1 })).toThrow(/required/)
    expect(() => parseUiEvidence({ required: true, start: { argv: [] } })).toThrow(/argv/)
    expect(() => parseUiEvidence({ required: true, start: { argv: ['x'], port: 70000 } })).toThrow(/port/)
    expect(() =>
      parseUiEvidence({ required: true, start: { argv: ['x'], url: 'https://example.com/' } }),
    ).toThrow(/loopback/)
    expect(() => parseUiEvidence({ required: true, paths: ['about'] })).toThrow(/start with \//)
    expect(() => parseUiEvidence({ required: true, paths: ['//evil.test/'] })).toThrow(/start with \//)
    expect(() => parseUiEvidence({ required: true, paths: ['/1', '/2', '/3', '/4', '/5', '/6'] })).toThrow(
      /at most 5/,
    )
    expect(() => parseUiEvidence({ required: true, extra: 1 })).toThrow(/extra/)
  })
})

describe('the evidence verdict', () => {
  it('a change users do not see needs nothing', () => {
    expect(uiEvidenceVerdict({ userVisible: false, base: BASE, captures: {} }, HEAD)).toEqual({
      status: 'not_needed',
    })
  })

  it('both captures on the right commits complete it', () => {
    expect(uiEvidenceVerdict(both(), HEAD)).toEqual({ status: 'complete' })
  })

  it('after-only is not evidence', () => {
    expect(uiEvidenceVerdict(both({ before: undefined }), HEAD)).toEqual({ status: 'waiting' })
  })

  it('a capture of another commit is not evidence for this one', () => {
    const older = both({ after: { sha: BASE, status: 'captured', shots: [shot] } })
    expect(uiEvidenceVerdict(older, HEAD)).toEqual({ status: 'waiting' })
    const moved = both({ before: { sha: HEAD, status: 'captured', shots: [shot] } })
    expect(uiEvidenceVerdict(moved, HEAD)).toEqual({ status: 'waiting' })
  })

  it('a capture with no shots is no capture', () => {
    expect(uiEvidenceVerdict(both({ after: { sha: HEAD, status: 'captured', shots: [] } }), HEAD)).toEqual({
      status: 'waiting',
    })
  })

  it('could not capture is never a pass, and says which side and why', () => {
    const failed = both({ after: { sha: HEAD, status: 'could_not', reason: 'the app did not start' } })
    expect(uiEvidenceVerdict(failed, HEAD)).toEqual({
      status: 'could_not',
      side: 'after',
      reason: 'the app did not start',
    })
  })

  it('no base commit is a capture that cannot be taken', () => {
    const { base: _base, ...rest } = both()
    expect(uiEvidenceVerdict(rest, HEAD)).toMatchObject({ status: 'could_not', side: 'before' })
  })
})

describe('acceptance with UI evidence (§15)', () => {
  it('flag off: the same verdict as before, whatever was captured', () => {
    expect(acceptance(input())).toEqual({ verdict: 'accepted', head: HEAD })
    expect(acceptance(input({ changed: ['README.md'] }))).toEqual({ verdict: 'accepted', head: HEAD })
  })

  it('flag on, user-visible, nothing captured: pending, waiting for screenshots', () => {
    expect(acceptance(input({ uiEvidence: both({ before: undefined, after: undefined }) }))).toEqual({
      verdict: 'pending',
      reason: UI_EVIDENCE_WAITING,
    })
  })

  it('flag on, both captures: accepted', () => {
    expect(acceptance(input({ uiEvidence: both() }))).toEqual({ verdict: 'accepted', head: HEAD })
  })

  it('flag on, a change users do not see: accepted without captures', () => {
    const none = { userVisible: false, base: BASE, captures: {} }
    expect(acceptance(input({ uiEvidence: none }))).toEqual({ verdict: 'accepted', head: HEAD })
  })

  it('could not capture keeps it pending with the reason, never accepted', () => {
    const failed = both({ before: { sha: BASE, status: 'could_not', reason: 'Chromium is not installed' } })
    expect(acceptance(input({ uiEvidence: failed }))).toEqual({
      verdict: 'pending',
      reason: `${UI_EVIDENCE_FAILED}: Couldn't take the before screenshot: Chromium is not installed`,
    })
  })

  it('red checks still go to a repair first: screenshots are taken of work that passed', () => {
    const decided = acceptance(
      input({
        attemptState: 'checks_failed',
        verdicts: [{ name: 'unit', status: 'failed', sha: HEAD }],
        uiEvidence: both({ after: undefined }),
      }),
    )
    expect(decided.verdict).toBe('repair')
  })
})

describe('the stage says what it waits for (§10)', () => {
  const view = (screenshots?: Parameters<typeof workViewOf>[1]['screenshots']) =>
    workViewOf(
      { state: 'executing' },
      {
        openQuestions: 0,
        awaitingConfirmation: false,
        attempts: [],
        merged: false,
        tasksOpen: true,
        ...(screenshots !== undefined && { screenshots }),
      },
    )

  it('waiting for the captures is the system’s wait', () => {
    expect(stageOf(view({ state: 'waiting' }))).toEqual({
      key: 'waiting/screenshots',
      label: 'Waiting for before and after screenshots',
      waitingOn: 'system',
    })
  })

  it('a capture that could not be taken is the person’s, naming the side', () => {
    expect(stageOf(view({ state: 'could_not', side: 'after' }))).toEqual({
      key: 'person/screenshots',
      label: "Couldn't take the after screenshot",
      waitingOn: 'person',
    })
  })

  it('without the fact the stage is what it was', () => {
    expect(stageOf(view())).toEqual({ key: 'working', label: 'Working', waitingOn: 'none' })
  })
})
