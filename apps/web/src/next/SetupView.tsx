import { type ReactNode, useState } from 'react'
import { PageHeader } from './Conversation'
import {
  metaChoices,
  openStage,
  type Readiness,
  type ReadinessStep,
  type SetupAnswer,
  type StepRoute,
  setupDone,
} from './config-model'
import { Button, Status, type StatusTone } from './primitives'

const TONES: Record<ReadinessStep['status'], StatusTone> = {
  done: 'good',
  missing: 'attention',
  skipped: 'neutral',
  checking: 'neutral',
}
const WORDS: Record<ReadinessStep['status'], string> = {
  done: 'Done',
  missing: 'Not done',
  skipped: 'Skipped',
  checking: 'Checking',
}

function MetaChoice({
  readiness,
  busy,
  error,
  onChoose,
}: {
  readiness: Readiness
  busy: boolean
  error: string | null
  onChoose: (slotId: string) => void
}) {
  const { usable, refused } = metaChoices(readiness.metaCandidates)
  const [picked, setPicked] = useState<string | null>(null)
  const chosen = picked ?? readiness.metaSlotId
  return (
    <div className="config-form">
      {usable.length === 0 ? (
        <p className="muted">No connection can run the meta agent yet. It needs a healthy Claude sign-in.</p>
      ) : (
        <fieldset className="choice-set">
          <legend>Run the meta agent on</legend>
          {usable.map((slot) => (
            <label key={slot.id} className="choice-row">
              <input
                type="radio"
                name="meta-slot"
                checked={chosen === slot.id}
                onChange={() => setPicked(slot.id)}
              />
              <span>{slot.label}</span>
            </label>
          ))}
        </fieldset>
      )}
      {refused.length > 0 && (
        <ul className="refused">
          {refused.map((slot) => (
            <li key={slot.id}>{slot.reason}</li>
          ))}
        </ul>
      )}
      {error !== null && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {usable.length > 0 && (
        <div className="form-actions">
          <Button
            variant="primary"
            disabled={busy || chosen === null}
            onClick={() => chosen !== null && onChoose(chosen)}
          >
            {busy ? 'Saving…' : 'Use this connection'}
          </Button>
        </div>
      )}
    </div>
  )
}

/** The setup agent's own door: it never enters the work planner, so it needs no repository. */
function SetupChat({
  onSend,
  onOpenSettings,
}: {
  onSend: (text: string) => Promise<SetupAnswer | { failure: string }>
  onOpenSettings: () => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState<SetupAnswer | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const send = async () => {
    setBusy(true)
    setFailure(null)
    const result = await onSend(text.trim())
    setBusy(false)
    if ('failure' in result) {
      setFailure(result.failure)
      return
    }
    setAnswer(result)
    setText('')
  }

  return (
    <section className="config-block" aria-label="Setup chat">
      <h2>Setup chat</h2>
      <form
        className="config-form"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <label className="field">
          Ask about setup
          <textarea rows={2} value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <p className="field-note">Never paste a key here. Keys go in Connections.</p>
        {failure !== null && (
          <p className="field-error" role="alert">
            {failure}
          </p>
        )}
        <div className="form-actions">
          <Button type="submit" variant="primary" disabled={busy || text.trim() === ''}>
            {busy ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </form>
      {answer !== null && (
        <div role="status">
          <pre className="code-block">{answer.reply}</pre>
          {answer.drafts > 0 && (
            <div className="form-actions">
              <Button onClick={onOpenSettings}>Open Settings</Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export function SetupView({
  readiness,
  connectionForm,
  repositoryForm,
  metaBusy,
  metaError,
  onChooseMeta,
  onSkip,
  onNavigate,
  onRecheck,
  onAsk,
}: {
  readiness: Readiness
  connectionForm: ReactNode
  repositoryForm: ReactNode
  metaBusy: boolean
  metaError: string | null
  onChooseMeta: (slotId: string) => void
  onSkip: (step: string) => void
  /** `step` names the stage whose next action this is, so the caller can open the right section. */
  onNavigate: (route: StepRoute, step?: string) => void
  onRecheck: () => void
  onAsk: (text: string) => Promise<SetupAnswer | { failure: string }>
}) {
  const current = openStage(readiness.steps)
  const [opened, setOpened] = useState<string | null>(null)
  const [finished, setFinished] = useState(false)
  const shown = opened ?? current
  const inline: Record<string, ReactNode> = {
    connection: connectionForm,
    repository: repositoryForm,
    meta_slot: <MetaChoice readiness={readiness} busy={metaBusy} error={metaError} onChoose={onChooseMeta} />,
  }
  const { completion } = readiness
  const allDone = setupDone(readiness)
  const ended = (finished || allDone) && completion !== null
  const chat = <SetupChat onSend={onAsk} onOpenSettings={() => onNavigate('settings')} />

  return (
    <div className="page">
      <PageHeader
        title="Setup"
        subtitle={
          allDone
            ? 'Setup is finished. Nothing more is needed here.'
            : 'What is really ready, read from what MEC has saved. You can leave and come back.'
        }
      />
      <ol className="stages">
        {readiness.steps.map((step, index) => {
          const expanded = shown === step.id
          return (
            <li key={step.id} className="stage">
              <div className="stage-head">
                <button
                  type="button"
                  className="stage-title"
                  aria-expanded={expanded}
                  onClick={() => setOpened(expanded ? '' : step.id)}
                >
                  <span aria-hidden="true">{index + 1}</span>
                  {step.title}
                </button>
                <Status tone={TONES[step.status]}>{WORDS[step.status]}</Status>
              </div>
              <p className="muted">{step.detail}</p>
              {expanded && step.status !== 'done' && (
                <div className="stage-body">
                  {inline[step.id]}
                  <div className="form-actions">
                    {step.id === 'engines' && <Button onClick={onRecheck}>Check again</Button>}
                    {step.next && step.id !== 'first_request' && step.next.route !== 'setup' && (
                      <Button onClick={() => step.next && onNavigate(step.next.route, step.id)}>
                        {step.next.label}
                      </Button>
                    )}
                    {step.status === 'missing' && step.id !== 'first_request' && (
                      <Button variant="quiet" onClick={() => onSkip(step.id)}>
                        Skip for now
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ol>

      {ended ? (
        <section className="config-block" aria-label="Setup complete">
          <h2>Ready</h2>
          <p>
            Work lands in {completion.repository.url}, and the meta agent runs on {completion.metaSlot.label}.
          </p>
          <div className="form-actions">
            <Button variant="primary" onClick={() => onNavigate('chat')}>
              Open Conversation
            </Button>
          </div>
        </section>
      ) : (
        <div className="finish">
          {!readiness.finish.enabled && readiness.finish.reason && (
            <p className="field-note">{readiness.finish.reason}</p>
          )}
          <Button variant="primary" disabled={!readiness.finish.enabled} onClick={() => setFinished(true)}>
            Finish
          </Button>
        </div>
      )}
      {ended ? (
        <details className="technical">
          <summary>Ask about setup</summary>
          {chat}
        </details>
      ) : (
        chat
      )}
    </div>
  )
}
