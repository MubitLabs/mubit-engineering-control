import { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkItemContext, workItemContext } from '../state'
import { useWorkbench } from '../workbench'
import { Btn } from './base'

/**
 * The composer: Enter sends, Shift+Enter adds a line, `/` focuses it from
 * anywhere. The reply chip names the work item the next message refers to.
 */
export function Composer({ prefill }: { prefill?: { text: string; nonce: number } }) {
  const wb = useWorkbench()
  const replyTo = useWorkItemContext()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const appliedNonce = useRef(-1)

  // Someone asked to "Answer in chat…" — focus the composer with a starting sentence.
  useEffect(() => {
    if (prefill === undefined || prefill.nonce === appliedNonce.current) return
    appliedNonce.current = prefill.nonce
    setDraft(prefill.text)
    inputRef.current?.focus()
  }, [prefill])

  const grow = useCallback(() => {
    const input = inputRef.current
    if (input === null) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(200, input.scrollHeight)}px`
  }, [])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (text === '') return
    setDraft('')
    const failure = await wb.sendChat(text, replyTo ?? undefined)
    setError(failure ? 'could not send — try again' : null)
    if (failure) setDraft(text)
  }, [draft, replyTo, wb])

  return (
    <form
      className="composer"
      aria-label="Message the meta agent"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <div className="composer-context" hidden={replyTo === null}>
        {replyTo === null ? null : (
          <>
            <span className="chip">
              Replying about <b className="mono">{replyTo}</b>
            </span>
            <button type="button" className="link" onClick={() => workItemContext.set(null)}>
              Clear
            </button>
          </>
        )}
      </div>
      <label className="sr-only" htmlFor="composer-input">
        Message
      </label>
      <textarea
        id="composer-input"
        ref={inputRef}
        rows={1}
        placeholder="Message the meta agent"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          grow()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            void send()
          }
        }}
      />
      <div className="composer-foot">
        <p className="muted composer-hint">
          Enter sends. Shift+Enter adds a line. <kbd>/</kbd> focuses.
          {error === null ? '' : ` ${error}`}
        </p>
        <Btn type="submit" variant="primary" disabled={wb.sendingChat}>
          Send
        </Btn>
      </div>
    </form>
  )
}
