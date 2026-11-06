import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Inspector, type InspectorScope } from '../src/next/Inspector'

/** The tab's markup, with no browser: what `Inspector` does with the evidence it is handed. */

const ignore = () => {}

const scope = (activity: InspectorScope['activity']): InspectorScope => ({
  id: 'task:a',
  kind: 'task',
  context: 'Parent',
  title: 'Task',
  overview: { sections: [], facts: [] },
  checks: { state: 'not-run', heading: 'Not run yet', detail: '' },
  activity,
  diff: { summary: '', files: [] },
})

const activityTab = (activity: InspectorScope['activity']) =>
  renderToStaticMarkup(
    createElement(Inspector, { scope: scope(activity), initialTab: 'activity', onClose: ignore }),
  )

const artifact = (text: string | null, note = 'A note') => ({
  label: 'log: run.log',
  open: true,
  onToggle: ignore,
  panel: { note, text },
})

describe('the Activity tab', () => {
  it('an artifact is plain text, whatever it holds', () => {
    const html = activityTab({
      note: 'Note',
      entries: [
        { key: '1', when: '10:00', text: 'report', artifacts: [artifact('<script>alert(1)</script>')] },
      ],
    })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('a binary artifact has its note and no text block', () => {
    const html = activityTab({
      note: 'Note',
      entries: [
        { key: '1', when: '10:00', text: 'report', artifacts: [artifact(null, 'Binary file, 2.0 KB.')] },
      ],
    })
    expect(html).toContain('Binary file, 2.0 KB.')
    expect(html).not.toContain('<pre')
  })

  it('a line’s detail is folded', () => {
    const html = activityTab({
      note: 'Note',
      entries: [{ key: '1', when: '10:00', text: 'Bash', detail: '{"tool":"Bash"}' }],
    })
    expect(html).toMatch(/<details[^>]*>.*Bash.*<\/details>/)
  })

  it('offers more, retry and the attempts it was given, and nothing else', () => {
    const none = activityTab({ note: 'Note', entries: [] })
    expect(none).not.toContain('Show more')
    expect(none).not.toContain('aria-pressed')
    const html = activityTab({
      note: 'Note',
      entries: [],
      more: { label: 'Show more', onClick: ignore },
      retry: { label: 'Retry', onClick: ignore },
      attempts: [{ id: 'a', label: 'Attempt 1: failed', selected: true, onSelect: ignore }],
    })
    expect(html).toContain('Show more')
    expect(html).toContain('Retry')
    expect(html).toContain('aria-pressed="true"')
  })
})
