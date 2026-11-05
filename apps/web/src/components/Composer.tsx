import { useCallback, useEffect, useRef, useState } from 'react'
import { CLASSIC_REPO_KEY, classicTarget, repositoryName } from '../repo-target'
import { useWorkItemContext, workItemContext } from '../state'
import { useWorkbench } from '../workbench'
import { Btn } from './base'

function readStoredRepo(): string | null {
  try {
    return localStorage.getItem(CLASSIC_REPO_KEY)
  } catch {
    return null
  }
}

/**
 * The composer: Enter sends, Shift+Enter adds a line, `/` focuses it from
 * anywhere. The reply chip names the work item the next message refers to, and with no chip
 * and several repositories a plain select names where the message lands.
 */
export function Composer({ prefill }: { prefill?: { text: string; nonce: number } }) {
  const wb = useWorkbench()
  const replyTo = useWorkItemContext()
  const [draft, setDraft] = useState('')
  const [storedRepo, setStoredRepo] = useState(readStoredRepo)
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

  const replyWork = wb.work.find((item) => item.id === replyTo)
  const target = classicTarget(wb.repositories, replyWork, storedRepo)

  const chooseRepo = useCallback((repoId: string) => {
    setStoredRepo(repoId)
    setError(null)
    try {
      localStorage.setItem(CLASSIC_REPO_KEY, repoId)
    } catch {
      // The choice still holds for this session.
    }
  }, [])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (text === '') return
    if (replyWork !== undefined && replyWork.repoId === undefined) {
      setError('That work has no repository. Clear the reply to send.')
      return
    }
    if (target === null) {
      setError(wb.repositories.length === 0 ? 'Add a repository in Setup first' : 'Choose a repository')
      return
    }
    setDraft('')
    const failure = await wb.sendChat(text, target, replyTo ?? undefined)
    setError(failure ? 'could not send — try again' : null)
    if (failure) setDraft(text)
  }, [draft, replyTo, replyWork, target, wb])

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
      {replyTo === null && wb.repositories.length > 1 ? (
        <select
          aria-label="Repository"
          value={target ?? ''}
          onChange={(event) => chooseRepo(event.target.value)}
        >
          {target === null ? <option value="">Choose a repository</option> : null}
          {wb.repositories.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repositoryName(repo.url)}
            </option>
          ))}
        </select>
      ) : null}
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
