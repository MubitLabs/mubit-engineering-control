import { type FormEvent, type KeyboardEvent, type RefObject, useId } from 'react'
import { isSubmitEnter } from './keyboard'
import { Button, SendIcon } from './primitives'

export interface ComposerProps {
  /** Who the next message reaches, as words: names New request or the follow-up subject. */
  scope: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  /** The other intent, when there is one to switch to. */
  intentToggle?: { label: string; onToggle: () => void }
  /** Why nothing can be sent. The frame stays visible and reachable, but read-only. */
  unavailable?: string
  textareaRef?: RefObject<HTMLTextAreaElement | null>
}

export function ComposerFrame({
  scope,
  value,
  onChange,
  onSubmit,
  intentToggle,
  unavailable,
  textareaRef,
}: ComposerProps) {
  const noteId = useId()
  const blocked = unavailable !== undefined || value.trim() === ''

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!blocked) onSubmit()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isSubmitEnter(event.nativeEvent)) return
    event.preventDefault()
    if (!blocked) onSubmit()
  }

  return (
    <div className="composer-dock">
      <form className="composer" aria-label="Message the meta agent" onSubmit={submit}>
        <div className="composer-scope">
          <span>{scope}</span>
          {intentToggle && (
            <Button variant="text" onClick={intentToggle.onToggle}>
              {intentToggle.label}
            </Button>
          )}
        </div>
        <textarea
          ref={textareaRef}
          aria-label="Message the meta agent"
          aria-describedby={noteId}
          readOnly={unavailable !== undefined}
          rows={2}
          placeholder={unavailable ? undefined : 'What would you like to work on?'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-bottom">
          <small id={noteId}>{unavailable ?? 'You talk to the meta agent. It coordinates the work.'}</small>
          <Button type="submit" variant="primary" className="send" aria-label="Send" aria-disabled={blocked}>
            <SendIcon />
          </Button>
        </div>
      </form>
      {!unavailable && <p className="composer-hint">Enter to send, Shift + Enter for a new line</p>}
    </div>
  )
}
