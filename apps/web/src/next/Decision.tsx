import { type FormEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { layers } from './keyboard'
import { Button } from './primitives'

/** Any unrelated action, Escape or eight seconds disarms. */
export const ARM_WINDOW_MS = 8000

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
  consequences: readonly { heading: string; body: string }[]
  onConfirm: () => void
  onDeny: () => void
}

export interface QuestionProps extends DecisionFrame, FocusClaim {
  choices: readonly string[]
  freeTextLabel: string
  onAnswer: (answer: string) => void
}

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
            <dd className={fact.mono ? 'mono' : undefined}>{fact.value}</dd>
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
 * Two-step approval. The frame holds only the arming: the effect itself is the caller's, so
 * this component cannot reach anything by itself.
 */
export function Approval(props: ApprovalProps) {
  const { status, onConfirm, onDeny } = props
  const heading = useSettledFocus(status, props.claimFocus)
  const [armed, setArmed] = useState(false)
  const confirm = useRef<HTMLButtonElement>(null)
  const open = status.state === 'open'

  useEffect(() => {
    if (!armed) return
    const disarm = () => setArmed(false)
    const timer = setTimeout(disarm, ARM_WINDOW_MS)
    const onUnrelated = (event: Event) => {
      if (event.target instanceof Node && confirm.current?.contains(event.target)) return
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
    if (!armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    onConfirm()
  }

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
            <Button ref={confirm} variant="primary" data-armed={armed} onClick={onApprove}>
              {armed ? props.confirmLabel : props.approveLabel}
            </Button>
            <Button variant="quiet" onClick={onDeny}>
              {props.denyLabel}
            </Button>
          </div>
          <p role="status" className="small armed-note">
            {armed ? `Armed: ${props.confirmLabel}. Escape or any other action cancels.` : ''}
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
