import { type FormEvent, useState } from 'react'
import { type CheckProfile, parseChecks, parseLines } from './config-model'
import { Button } from './primitives'

export interface RepositoryRequest {
  urlOrPath: string
  bootstrapCmds: string[]
  checkCmds: CheckProfile[]
}

export const CHECKS_HINT = 'One a line, as name: command. Commands run as argv, never through a shell.'
export const BOOTSTRAP_HINT = 'One a line. They run once in a new worktree.'

/** One form for Setup and Settings. A new repository starts untrusted; trust is a separate step. */
export function RepositoryForm({
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  busy: boolean
  error: string | null
  onSubmit: (request: RepositoryRequest) => void
  onCancel?: () => void
}) {
  const [urlOrPath, setUrl] = useState('')
  const [bootstrap, setBootstrap] = useState('')
  const [checks, setChecks] = useState('')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (urlOrPath.trim() === '') return
    onSubmit({
      urlOrPath: urlOrPath.trim(),
      bootstrapCmds: parseLines(bootstrap),
      checkCmds: parseChecks(checks),
    })
  }

  return (
    <form className="config-form" onSubmit={submit}>
      <label className="field">
        Repository path or https URL
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={urlOrPath}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <label className="field">
        Bootstrap commands
        <textarea rows={2} value={bootstrap} onChange={(event) => setBootstrap(event.target.value)} />
        <small>{BOOTSTRAP_HINT}</small>
      </label>
      <label className="field">
        Check profile
        <textarea rows={3} value={checks} onChange={(event) => setChecks(event.target.value)} />
        <small>{CHECKS_HINT}</small>
      </label>
      <p className="field-note">The repository starts untrusted. You can trust it later in Settings.</p>
      {error !== null && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        {onCancel && (
          <Button variant="quiet" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={busy || urlOrPath.trim() === ''}>
          {busy ? 'Adding…' : 'Add repository'}
        </Button>
      </div>
    </form>
  )
}
