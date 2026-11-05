import { useCallback, useEffect, useState } from 'react'
import { api, type DecisionDetail, type InboxItem, type Question } from '../api'
import { canApprove } from '../release-cards'
import { useWorkbench } from '../workbench'
import { Btn } from './base'

/**
 * The needs-you tray: the only amber on the page. A decision card answers what
 * will happen, why it is asked, and what a click does (§2.2); a question card
 * offers the specialist's choices. Both render here and on the Needs-you page
 * from the same list.
 */

export type TrayCard = { kind: 'decision'; item: InboxItem } | { kind: 'question'; question: Question }

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'expired'
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  return `${minutes} min`
}

function humanClass(cls: string): string {
  if (cls === '') return 'A confirmation waits for you'
  return cls
    .split(/[-_]/)
    .map((word) => (word === 'pr' ? 'PR' : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
}

export function DecisionCard({ item }: { item: InboxItem }) {
  const wb = useWorkbench()
  const [detail, setDetail] = useState<DecisionDetail | null>(null)
  const [detailFailed, setDetailFailed] = useState(false)
  const resolution = wb.resolutions[item.id]
  const remaining = new Date(item.expiresAt).getTime() - wb.now
  const expired = remaining <= 0
  const dead = resolution !== undefined || expired
  const armed = wb.armedId === item.id

  const readDetail = useCallback(
    (live: () => boolean) =>
      api
        .decisionDetail(item.id)
        .then((d) => {
          if (live()) setDetail(d)
        })
        .catch(() => {
          if (live()) setDetailFailed(true)
        }),
    [item.id],
  )

  useEffect(() => {
    let alive = true
    void readDetail(() => alive)
    return () => {
      alive = false
    }
  }, [readDetail])

  // The retry button leaves with the failure, so focus moves to the card first.
  const readDetailAgain = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.closest<HTMLElement>('.decision')?.focus()
    setDetailFailed(false)
    void readDetail(() => true)
  }

  // Enter on the card opens the evidence — but never when focus is on one of the
  // card's own buttons: those keep their native Enter behaviour.
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter') return
    if ((event.target as HTMLElement).closest('button') !== null) return
    event.preventDefault()
    wb.openContext({ kind: 'decision', id: item.id })
  }

  const what =
    detail === null ? humanClass(item.cls) : detail.absent === true ? humanClass(item.cls) : detail.what
  const facts =
    detail !== null && detail.absent !== true
      ? detail.facts
      : [
          { label: 'Operation', value: item.operationHash, mono: true },
          {
            label: 'Evidence',
            value:
              detail !== null
                ? 'not served by the server yet'
                : detailFailed
                  ? 'could not be read, so this card cannot be approved yet'
                  : 'loading',
          },
        ]

  return (
    <li
      className={`decision${dead ? ' is-resolved' : ''}`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: design spec §8 — a decision card is focusable and opens its evidence on Enter; the prototype's interaction model, kept verbatim.
      tabIndex={0}
      data-decision={item.id}
      onKeyDown={onKeyDown}
    >
      <div className="decision-main">
        <p className="decision-what">{what}</p>
        {detail !== null && detail.absent !== true ? <p className="decision-why">{detail.why}</p> : null}
        <dl className="decision-facts">
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd className={fact.mono === true ? 'mono' : ''}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="decision-side">
        {resolution !== undefined ? (
          <p className="expires muted">{resolution.note}</p>
        ) : expired ? (
          <p className="expires muted">Expired — the agent was told it was not approved</p>
        ) : (
          <p className="expires">
            Expires in <time>{formatRemaining(remaining)}</time>
          </p>
        )}
        <div className="decision-actions">
          <Btn
            variant={armed ? 'confirm' : 'primary'}
            disabled={dead || wb.busyAnswer === item.id || !canApprove(detail)}
            data-approve={item.id}
            onClick={() => void wb.approveDecision(item)}
          >
            {wb.busyAnswer === item.id
              ? 'Approving…'
              : armed
                ? `Confirm: ${detail !== null && detail.absent !== true ? confirmVerb(detail) : 'approve'}`
                : 'Approve'}
          </Btn>
          <Btn
            variant="quiet"
            disabled={dead || wb.busyAnswer === item.id}
            onClick={() => void wb.denyDecision(item)}
          >
            Deny
          </Btn>
        </div>
        {detailFailed ? (
          <button type="button" className="link" onClick={readDetailAgain}>
            Read the evidence again
          </button>
        ) : null}
        <button
          type="button"
          className="link"
          onClick={() => wb.openContext({ kind: 'decision', id: item.id })}
        >
          See the diff and checks
        </button>
        {wb.actionErrors[item.id] ? <p className="expires muted">{wb.actionErrors[item.id]}</p> : null}
      </div>
    </li>
  )
}

/** The confirm button names the effect in words (§2.7). */
function confirmVerb(detail: DecisionDetail): string {
  if (detail.verb !== undefined) return detail.verb
  const branch = detail.facts.find((fact) => fact.label === 'Branch')
  return branch === undefined || detail.what.toLowerCase().includes('push')
    ? 'push and open PR'
    : detail.what.toLowerCase()
}

export function QuestionCard({ question }: { question: Question }) {
  const wb = useWorkbench()
  const resolution = wb.resolutions[question.id]
  const dead = resolution !== undefined

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter') return
    if ((event.target as HTMLElement).closest('button') !== null) return
    event.preventDefault()
    wb.openContext({ kind: 'question', id: question.id })
  }

  return (
    <li
      className={`decision decision-question${dead ? ' is-resolved' : ''}`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: design spec §8 — a question card is focusable and opens its evidence on Enter.
      tabIndex={0}
      data-decision={question.id}
      onKeyDown={onKeyDown}
    >
      <div className="decision-main">
        <p className="decision-eyebrow">
          {question.eyebrow}
          {question.demo === true ? <span className="mark"> demo — not served by the server yet</span> : null}
        </p>
        <p className="decision-what">{question.what}</p>
        <p className="decision-why">{question.why}</p>
        {/* biome-ignore lint/a11y/useSemanticElements: a labelled group of choice buttons is the prototype's markup (§7 Tray); there is no native element for this. */}
        <div className="choices" role="group" aria-label="Answer">
          {question.options.map((option) => (
            <button
              key={option}
              type="button"
              className={`choice${option === 'Answer in chat…' ? ' choice-other' : ''}${
                resolution?.picked === option ? ' is-selected' : ''
              }`}
              disabled={dead}
              onClick={() => void wb.answerQuestion(question, option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      <div className="decision-side">
        {resolution !== undefined ? (
          <p className="expires muted">{resolution.note}</p>
        ) : (
          <p className="expires muted">{question.sideNote ?? 'Nothing else waits on this'}</p>
        )}
      </div>
    </li>
  )
}

/** The tray with its amber head; lives above the conversation so a decision is never out of sight. */
export function Tray({ cards }: { cards: TrayCard[] }) {
  const wb = useWorkbench()
  const [collapsed, setCollapsed] = useState(false)
  const open = cards.filter(
    (card) => wb.resolutions[idOf(card)] === undefined && !expiredOf(card, wb.now),
  ).length

  return (
    <section className={`tray${collapsed ? ' is-collapsed' : ''}`} id="tray" aria-labelledby="tray-title">
      <header className="tray-head">
        <h2 id="tray-title" className="tray-title">
          Needs you <span className="tray-count">{open}</span>
        </h2>
        <p className="tray-sub">
          {open === 0 ? 'Nothing waits for you.' : 'Approve with A, deny with D, move with J K'}
        </p>
        <Btn
          variant="quiet"
          className="tray-toggle"
          aria-expanded={!collapsed}
          aria-controls="tray-list"
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? 'Show' : 'Collapse'}
        </Btn>
      </header>
      <ol className="tray-list" id="tray-list">
        {cards.map((card) =>
          card.kind === 'decision' ? (
            <DecisionCard key={card.item.id} item={card.item} />
          ) : (
            <QuestionCard key={card.question.id} question={card.question} />
          ),
        )}
      </ol>
    </section>
  )
}

/** The same cards, headless, for the Needs-you page — one source of truth. */
export function TrayCards({ cards }: { cards: TrayCard[] }) {
  return (
    <ol className="tray-list">
      {cards.map((card) =>
        card.kind === 'decision' ? (
          <DecisionCard key={card.item.id} item={card.item} />
        ) : (
          <QuestionCard key={card.question.id} question={card.question} />
        ),
      )}
    </ol>
  )
}

function idOf(card: TrayCard): string {
  return card.kind === 'decision' ? card.item.id : card.question.id
}

function expiredOf(card: TrayCard, now: number): boolean {
  return card.kind === 'decision' && new Date(card.item.expiresAt).getTime() - now <= 0
}
