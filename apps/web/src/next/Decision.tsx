import { type FormEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { layers } from './keyboard'
import { Button } from './primitives'

/** Any unrelated action, Escape or eight seconds disarms. */
export const ARM_WINDOW_MS = 8000

/**
 * Said once the window runs out by itself. Without it the press that follows arms again with no
 * effect sent, which reads as a confirm button that does nothing.
 */
export const LAPSED_NOTE = `Not done: the confirm lapsed after ${ARM_WINDOW_MS / 1000} seconds. Press it again to arm.`

/** The line under the buttons: what is armed, else that an arm ran out by itself, else nothing. */
export function armedNote(armedLabel: string | null | undefined, lapsed: boolean): string {
  if (armedLabel) return `Armed: ${armedLabel}. Escape or any other action cancels.`
  return lapsed ? LAPSED_NOTE : ''
}

export type DecisionStatus =
  | { state: 'open'; expires: string }
  | { state: 'resolved'; label: string; detail: string }
  | { state: 'expired'; label: string; detail: string }

interface DecisionFrame {
  label: string
  title: string
  summary: string
  evidence: readonly { label: string; value: string; mono?: boolean }[]
  status: DecisionStatus
  onInspect?: () => void
  inspectLabel?: string
}

/** Set on the card a person just settled, so it takes focus back wherever the list refiles it. */
interface FocusClaim {
  claimFocus?: boolean
}

export interface ApprovalProps extends DecisionFrame, FocusClaim {
  approveLabel: string
  /** Names the exact effect, for the armed button and the announcement. */
  confirmLabel: string
  denyLabel: string
  /**
   * Set where a deny is an answer, not a cancel: Deny then asks for a second click as Approve does,
   * naming what it denies. Left out, Deny is one click (a cancel that changes nothing).
   */
  denyConfirmLabel?: string
  consequences: readonly { heading: string; body: string }[]
  onConfirm: () => void
  onDeny: () => void
}

export interface QuestionProps extends DecisionFrame, FocusClaim {
  choices: readonly string[]
  freeTextLabel: string
  onAnswer: (answer: string) => void
}

/** A fact over several lines (a PR body) keeps its lines; the rest sit on one. */
const factClass = (fact: { value: string; mono?: boolean }): string | undefined =>
  fact.value.includes('\n') ? 'fact-text' : fact.mono ? 'mono' : undefined

function Frame({
  frame,
  headingRef,
  children,
}: {
  frame: DecisionFrame
  headingRef: React.RefObject<HTMLHeadingElement | null>
  children: React.ReactNode
}) {
  const { status } = frame
  const open = status.state === 'open'
  return (
    <article className="decision" data-state={status.state}>
      <div className="decision-head">
        <span className={open ? 'attention-label' : 'settled-label'}>
          {open ? frame.label : status.label}
        </span>
        <small>{open ? status.expires : status.detail}</small>
      </div>
      <h2 ref={headingRef} tabIndex={-1}>
        {frame.title}
      </h2>
      <p className="muted">{frame.summary}</p>
      <dl className="facts evidence">
        {frame.evidence.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd className={factClass(fact)}>{fact.value}</dd>
          </div>
        ))}
      </dl>
      {frame.onInspect && (
        <Button variant="text" onClick={frame.onInspect}>
          {frame.inspectLabel ?? 'Inspect evidence'}
        </Button>
      )}
      {children}
    </article>
  )
}

/**
 * When the controls unmount on settling, focus lands on the outcome instead of the body. A card
 * filed under Settled is a new element, so one that claims focus takes it again as it mounts.
 */
function useSettledFocus(status: DecisionStatus, claim = false) {
  const heading = useRef<HTMLHeadingElement>(null)
  const wasOpen = useRef(status.state === 'open')
  useLayoutEffect(() => {
    const open = status.state === 'open'
    if ((wasOpen.current || claim) && !open && document.activeElement === document.body) {
      heading.current?.focus()
    }
    wasOpen.current = open
  }, [status.state, claim])
  return heading
}

/**
 * Both labels laid out in one cell, the one not in force unseen and unread: the button is as wide
 * armed as at rest, so arming moves nothing under the pointer.
 */
function TwoLabels({ armed, rest, confirm }: { armed: boolean; rest: string; confirm: string }) {
  return (
    <span className="two-labels">
      <span className="two-label" aria-hidden={armed || undefined}>
        {rest}
      </span>
      <span className="two-label" aria-hidden={!armed || undefined}>
        {confirm}
      </span>
    </span>
  )
}

type Armed = 'approve' | 'deny' | null

/**
 * Two-step approval, and a two-step deny where a deny is an answer. Arming one disarms the other.
 * The frame holds only the arming: the effect itself is the caller's, so this component cannot
 * reach anything by itself.
 */
export function Approval(props: ApprovalProps) {
  const { status, onConfirm, onDeny, denyConfirmLabel } = props
  const heading = useSettledFocus(status, props.claimFocus)
  const [armed, setArmed] = useState<Armed>(null)
  const [lapsed, setLapsed] = useState(false)
  const approveButton = useRef<HTMLButtonElement>(null)
  const denyButton = useRef<HTMLButtonElement>(null)
  const open = status.state === 'open'

  useEffect(() => {
    if (armed === null) return
    const disarm = () => setArmed(null)
    const timer = setTimeout(() => {
      setArmed(null)
      setLapsed(true)
    }, ARM_WINDOW_MS)
    const button = armed === 'approve' ? approveButton : denyButton
    const onUnrelated = (event: Event) => {
      if (event.target instanceof Node && button.current?.contains(event.target)) return
      disarm()
    }
    const removeLayer = layers.push({ modal: false, onEscape: disarm })
    document.addEventListener('pointerdown', onUnrelated, true)
    document.addEventListener('focusin', onUnrelated, true)
    return () => {
      clearTimeout(timer)
      removeLayer()
      document.removeEventListener('pointerdown', onUnrelated, true)
      document.removeEventListener('focusin', onUnrelated, true)
    }
  }, [armed])

  const onApprove = () => {
    setLapsed(false)
    if (armed !== 'approve') {
      setArmed('approve')
      return
    }
    setArmed(null)
    onConfirm()
  }

  const onDenyClick = () => {
    setLapsed(false)
    if (denyConfirmLabel !== undefined && armed !== 'deny') {
      setArmed('deny')
      return
    }
    setArmed(null)
    onDeny()
  }

  const armedLabel = armed === 'approve' ? props.confirmLabel : armed === 'deny' ? denyConfirmLabel : null

  return (
    <Frame frame={props} headingRef={heading}>
      {props.consequences.map((consequence) => (
        <div key={consequence.heading} className="consequence">
          <strong>{consequence.heading}</strong>
          <p className="muted">{consequence.body}</p>
        </div>
      ))}
      {open && (
        <>
          <div className="actions">
            <Button
              ref={approveButton}
              variant="primary"
              data-approve=""
              data-armed={armed === 'approve'}
              onClick={onApprove}
            >
              <TwoLabels armed={armed === 'approve'} rest={props.approveLabel} confirm={props.confirmLabel} />
            </Button>
            <Button ref={denyButton} variant="quiet" data-armed={armed === 'deny'} onClick={onDenyClick}>
              {denyConfirmLabel === undefined ? (
                props.denyLabel
              ) : (
                <TwoLabels armed={armed === 'deny'} rest={props.denyLabel} confirm={denyConfirmLabel} />
              )}
            </Button>
          </div>
          <p role="status" className="small armed-note">
            {armedNote(armedLabel, lapsed)}
          </p>
        </>
      )}
    </Frame>
  )
}

export function Question(props: QuestionProps) {
  const { status, choices, onAnswer } = props
  const heading = useSettledFocus(status, props.claimFocus)
  const [picked, setPicked] = useState<string | null>(null)
  const [text, setText] = useState('')
  const groupName = useId()
  const answer = (picked ?? text).trim()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (answer !== '') onAnswer(answer)
  }

  return (
    <Frame frame={props} headingRef={heading}>
      {status.state === 'open' && (
        <form className="answer" onSubmit={submit}>
          <fieldset>
            <legend className="sr-only">{props.title}</legend>
            {choices.map((choice) => (
              <label key={choice} className="answer-choice">
                <input
                  type="radio"
                  name={groupName}
                  checked={picked === choice}
                  onChange={() => setPicked(choice)}
                />
                {choice}
              </label>
            ))}
          </fieldset>
          <label className="answer-text">
            {props.freeTextLabel}
            <textarea
              rows={2}
              value={text}
              onChange={(event) => {
                setPicked(null)
                setText(event.target.value)
              }}
            />
          </label>
          <div className="actions">
            <Button type="submit" variant="primary" aria-disabled={answer === ''}>
              Send answer
            </Button>
          </div>
        </form>
      )}
    </Frame>
  )
}
