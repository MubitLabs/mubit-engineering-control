import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Approval, type ApprovalProps } from '../src/next/Decision'
import { approvalProps } from '../src/next/work-model'
import { CARD_HEAD, cardEvidence, needs } from './fixtures/inspection-fixtures'

/** The card's markup, with no browser: the clicks themselves are in work.screens.playwright.ts. */

const ignore = () => {}

const card = (over: Partial<ApprovalProps> = {}): string => {
  const {
    id: _id,
    canApprove: _c,
    actionable: _a,
    hold: _h,
    retryEvidence: _r,
    ...view
  } = approvalProps(needs.pending, cardEvidence.card_pending, null)
  return renderToStaticMarkup(
    createElement(Approval, { ...view, onConfirm: ignore, onDeny: ignore, ...over }),
  )
}

/** Each button's markup, in order. */
const buttons = (html: string): string[] => html.match(/<button[^>]*>.*?<\/button>/g) ?? []

describe('the approval card', () => {
  it('a release card asks for a second click on Deny too, naming what it denies', () => {
    const view = approvalProps(needs.pending, cardEvidence.card_pending, null)
    expect(view.denyConfirmLabel).toBe('Confirm: deny in sample-console')
  })

  it('both buttons hold their armed label from the start, so arming moves nothing', () => {
    const [approve, deny] = buttons(card())
    expect(approve).toContain('Approve')
    expect(approve).toContain('Confirm: push in sample-console')
    expect(deny).toContain('Deny')
    expect(deny).toContain('Confirm: deny in sample-console')
    // The label not in force is laid out, unseen and unread.
    for (const button of [approve, deny]) {
      expect(button?.match(/aria-hidden="true"/g)).toHaveLength(1)
    }
    expect(approve).toMatch(
      /<span class="two-label" aria-hidden="true">Confirm: push in sample-console<\/span>/,
    )
  })

  it('a cancel with no confirm label keeps one label and one click', () => {
    const [, deny] = buttons(card({ denyLabel: 'Keep it', denyConfirmLabel: undefined }))
    expect(deny).not.toContain('aria-hidden')
    expect(deny).toContain('Keep it')
  })

  it('the card face shows the short commit it is bound to', () => {
    const view = approvalProps(needs.pending, cardEvidence.card_pending, null)
    expect(view.evidence).toContainEqual({ label: 'Commit', value: CARD_HEAD.slice(0, 7), mono: true })
    expect(card()).toContain(CARD_HEAD.slice(0, 7))
  })

  it('a multi-line fact keeps its lines, so a PR body reads as written', () => {
    const body = 'Summary\n\n| Task | SHA |\n| --- | --- |\n| a | 1234567 |'
    const html = card({ evidence: [{ label: 'Body', value: body }] })
    expect(html).toMatch(/<dd class="fact-text">Summary\n\n\| Task \| SHA \|/)
    const oneLine = card({ evidence: [{ label: 'Title', value: 'One line' }] })
    expect(oneLine).not.toContain('fact-text')
  })

  it('the multi-line fact style keeps line breaks (no markdown renderer: the text as written)', () => {
    const css = readFileSync(new URL('../src/next/shell.css', import.meta.url), 'utf8')
    const rule = css.match(/\.facts dd\.fact-text \{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toContain('white-space: pre-wrap')
  })
})
