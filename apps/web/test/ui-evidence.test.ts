// §14, §15 in the workbench: the repository setting saves as the API takes it, the work view shows
// the before and after screenshots labelled with their short revisions, and a capture that could not
// be taken offers "Take the screenshots again" through the same retry as every other.
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { decodeRepositories } from '../src/config-decode'
import { decodeWorkDetail } from '../src/inspection-decode'
import { UiEvidenceControl, uiEvidencePatch } from '../src/next/SettingsView'
import { deliveryDetail } from '../src/next/work-model'
import { workDetails } from './fixtures/inspection-fixtures'

const BASE = 'b'.repeat(40)
const HEAD = 'a'.repeat(40)
const OFF = { required: false, paths: ['/'], patterns: [] }

const shot = (side: string) => ({
  path: '/',
  url: `/api/work/work_working/screenshots/att_1/${side}-1.png`,
  at: '2026-11-10T12:00:00.000Z',
  status: 200,
})

const wire = (extra: Record<string, unknown>) =>
  JSON.parse(JSON.stringify({ ...workDetails.work_working, ...extra }))

describe('the repository setting (§14)', () => {
  it('a server from before the setting reads as off', () => {
    const [repo] = decodeRepositories([
      {
        id: 'repo_a',
        url: '/r',
        bootstrap: [],
        checks: [],
        trust: false,
        revision: 'r1',
        hostRunAgreedAt: null,
      },
    ])
    expect(repo?.uiEvidence).toEqual(OFF)
  })

  it('reads what the server holds', () => {
    const [repo] = decodeRepositories([
      {
        id: 'repo_a',
        url: '/r',
        bootstrap: [],
        checks: [],
        trust: false,
        revision: 'r1',
        hostRunAgreedAt: null,
        uiEvidence: {
          required: true,
          start: { argv: ['npm', 'start'], port: 3000 },
          paths: ['/', '/a'],
          patterns: ['web/**'],
        },
      },
    ])
    expect(repo?.uiEvidence).toEqual({
      required: true,
      start: { argv: ['npm', 'start'], port: 3000 },
      paths: ['/', '/a'],
      patterns: ['web/**'],
    })
  })

  it('a save sends argv, the port, the pages, and keeps the globs', () => {
    const current = { required: false, paths: ['/'], patterns: ['web/**'] }
    expect(
      uiEvidencePatch(
        { required: true, start: ' npm  start ', port: '4100', paths: '/ /about.html' },
        current,
      ),
    ).toEqual({
      required: true,
      start: { argv: ['npm', 'start'], port: 4100 },
      paths: ['/', '/about.html'],
      patterns: ['web/**'],
    })
  })

  it('with no start command it serves the files; no globs means the defaults', () => {
    expect(uiEvidencePatch({ required: true, start: '', port: '', paths: '' }, OFF)).toEqual({
      required: true,
      paths: ['/'],
    })
  })

  it('the checkbox sits on its label’s line at checkbox size, not as a full-width field', () => {
    // `.field input` makes every field input a full-width, 36 px tall box on its own grid row; the
    // checkbox row is a flex line with a 16 px box, like the radio rows (the layout itself is in
    // config.screens.playwright.ts).
    const css = readFileSync(new URL('../src/next/shell.css', import.meta.url), 'utf8')
    const row = css.match(/\n\.field-check \{([^}]*)\}/)?.[1] ?? ''
    const box = css.match(/\n\.field-check input \{([^}]*)\}/)?.[1] ?? ''
    expect(row).toContain('display: flex')
    expect(row).toContain('align-items: center')
    expect(box).toContain('width: 16px')
    expect(box).toContain('height: 16px')
    expect(box).toContain('min-height: 0')
    expect(css.indexOf('\n.field-check input {')).toBeGreaterThan(css.indexOf('\n.field input,'))
    const [repository] = decodeRepositories([
      {
        id: 'repo_a',
        url: '/r',
        bootstrap: [],
        checks: [],
        trust: false,
        revision: 'r1',
        hostRunAgreedAt: null,
      },
    ])
    const html = renderToStaticMarkup(
      createElement(UiEvidenceControl, {
        repository: repository as NonNullable<typeof repository>,
        busy: false,
        error: null,
        onSave: () => {},
      }),
    )
    expect(html).toMatch(/<label class="field field-check"[^>]*><input [^>]*type="checkbox"/)
  })

  it('says what is wrong instead of saving it', () => {
    expect(uiEvidencePatch({ required: true, start: 'npm start', port: 'x', paths: '/' }, OFF)).toMatch(
      /port/,
    )
    expect(uiEvidencePatch({ required: true, start: '', port: '3000', paths: '/' }, OFF)).toMatch(
      /start command/,
    )
    expect(uiEvidencePatch({ required: true, start: '', port: '', paths: 'about' }, OFF)).toMatch(
      /starts with \//,
    )
  })
})

describe('the screenshots on the work view (§15)', () => {
  it('shows before and after, each labelled with its short revision', () => {
    const detail = decodeWorkDetail(
      wire({
        screenshots: [
          {
            taskId: 'task_done',
            attemptId: 'att_1',
            state: 'taken',
            viewport: { width: 1280, height: 800 },
            before: {
              sha: BASE,
              short: BASE.slice(0, 7),
              status: 'captured',
              reason: null,
              shots: [shot('before')],
            },
            after: {
              sha: HEAD,
              short: HEAD.slice(0, 7),
              status: 'captured',
              reason: null,
              shots: [shot('after')],
            },
          },
        ],
      }),
    )
    const [set] = deliveryDetail(detail, null).screenshots
    expect(set?.before.label).toBe(`Before, ${BASE.slice(0, 7)}`)
    expect(set?.after.label).toBe(`After, ${HEAD.slice(0, 7)}`)
    expect(set?.after.images).toEqual([
      { src: shot('after').url, alt: `After at ${HEAD.slice(0, 7)}: /`, path: '/' },
    ])
    expect(set?.note).toBe('Taken by MEC from the real application at 1280x800.')
  })

  it('a capture that could not be taken says why, with no image', () => {
    const detail = decodeWorkDetail(
      wire({
        retry: { kind: 'screenshots', reason: "Couldn't take the after screenshot: the app did not start" },
        screenshots: [
          {
            taskId: 'task_done',
            attemptId: 'att_1',
            state: 'could_not',
            viewport: null,
            before: null,
            after: {
              sha: HEAD,
              short: HEAD.slice(0, 7),
              status: 'could_not',
              reason: 'the app did not start',
              shots: [],
            },
          },
        ],
      }),
    )
    const view = deliveryDetail(detail, null)
    expect(view.screenshots[0]?.after).toEqual({
      label: `After, ${HEAD.slice(0, 7)}`,
      images: [],
      note: "Couldn't take it: the app did not start",
    })
    expect(view.screenshots[0]?.before.note).toBe('Not taken yet')
    expect(view.lead?.label).toMatch(/^Take the screenshots again/)
  })

  it('an image from anywhere but MEC’s own route is refused', () => {
    const bad = { ...shot('after'), url: 'https://example.com/x.png' }
    expect(() =>
      decodeWorkDetail(
        wire({
          screenshots: [
            {
              taskId: 't',
              attemptId: 'att_1',
              state: 'taken',
              viewport: null,
              before: null,
              after: { sha: HEAD, short: 'aaaaaaa', status: 'captured', reason: null, shots: [bad] },
            },
          ],
        }),
      ),
    ).toThrow(/screenshot route/)
  })

  it('a server from before UI evidence sends none, and nothing is shown', () => {
    const { screenshots: _none, ...older } = wire({})
    expect(deliveryDetail(decodeWorkDetail(older), null).screenshots).toEqual([])
  })
})
