import { type FormEvent, useId, useState } from 'react'
import type { ConnectionOption, ConnectionPath, EngineProbe } from './config-model'
import { Button } from './primitives'

export type ConnectionRequest =
  | { path: 'link'; engine: string; label: string }
  | { path: 'sign_in'; engine: string; label: string }
  | { path: 'api_key'; engine: string; label: string; provider: string; key: string }

const PATH_LABELS: Record<ConnectionPath, { title: string; body: string }> = {
  link: {
    title: 'Use my existing login',
    body: 'No extra sign-in. MEC sessions appear in your own history and share your quota.',
  },
  sign_in: {
    title: 'Sign in to a dedicated connection',
    body: 'Opens the vendor’s own sign-in in a terminal card. MEC never sees the token.',
  },
  api_key: {
    title: 'Paste an API key',
    body: 'Stored only in this connection’s keystore. MEC keeps a fingerprint.',
  },
}

const ENGINE_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }
export const engineName = (engine: string): string => ENGINE_NAMES[engine] ?? engine

/** One form for Setup and Connections: only what this server really supports is offered. */
export function ConnectionForm({
  options,
  engines,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  options: readonly ConnectionOption[]
  engines: readonly EngineProbe[]
  busy: boolean
  error: string | null
  onSubmit: (request: ConnectionRequest) => void
  onCancel?: () => void
}) {
  const [engine, setEngine] = useState(options[0]?.engine ?? '')
  const option = options.find((entry) => entry.engine === engine)
  const [chosenPath, setPath] = useState<ConnectionPath | null>(null)
  const path = chosenPath !== null && option?.paths.includes(chosenPath) ? chosenPath : option?.paths[0]
  const [chosenProvider, setProvider] = useState<string | null>(null)
  const provider =
    option?.providers.find((entry) => entry.id === chosenProvider)?.id ?? option?.providers[0]?.id
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const pathGroup = useId()
  const probe = engines.find((entry) => entry.engine === engine)

  const complete = label.trim() !== '' && (path !== 'api_key' || (provider !== undefined && key !== ''))

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!complete || path === undefined) return
    const named = { engine, label: label.trim() }
    if (path === 'api_key' && provider !== undefined) {
      onSubmit({ path, ...named, provider, key })
      setKey('')
    } else if (path !== 'api_key') {
      onSubmit({ path, ...named })
    }
  }

  return (
    <form className="config-form" onSubmit={submit}>
      <label className="field">
        Engine
        <select
          value={engine}
          onChange={(event) => {
            setEngine(event.target.value)
            setPath(null)
            setProvider(null)
          }}
        >
          {options.map((entry) => (
            <option key={entry.engine} value={entry.engine}>
              {engineName(entry.engine)}
            </option>
          ))}
        </select>
      </label>
      {probe && !probe.installed && (
        <p className="field-note">{engineName(engine)} was not found on PATH on this machine.</p>
      )}

      <fieldset className="choice-set">
        <legend>How MEC should use it</legend>
        {option?.paths.map((entry) => (
          <label key={entry} className="choice-row">
            <input type="radio" name={pathGroup} checked={path === entry} onChange={() => setPath(entry)} />
            <span>
              {PATH_LABELS[entry].title}
              <small>{PATH_LABELS[entry].body}</small>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="field">
        Connection name
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>

      {path === 'api_key' && (
        <>
          {option && option.providers.length > 1 && (
            <label className="field">
              Provider
              <select value={provider} onChange={(event) => setProvider(event.target.value)}>
                {option.providers.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            API key
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
          </label>
          {provider === 'gemini-api' && (
            <p className="field-note">
              Google may use free-tier prompts to improve its products. A billing-linked project is
              recommended for private code.
            </p>
          )}
        </>
      )}

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
        <Button type="submit" variant="primary" disabled={busy || !complete}>
          {busy ? 'Adding…' : path === 'sign_in' ? 'Start sign-in' : 'Add connection'}
        </Button>
      </div>
    </form>
  )
}

/** The vendor's own login, streamed live. Nothing here is stored (§5.6). */
export function SignInCard({
  label,
  lines,
  url,
  ended,
  note,
  onCancel,
  onDone,
}: {
  label: string
  lines: readonly string[]
  url: string | null
  ended: boolean
  note: string | null
  onCancel: () => void
  onDone: () => void
}) {
  return (
    <div className="sign-in">
      <p className="muted">Signing in to {label} through the vendor’s own command.</p>
      {url !== null && (
        <a className="btn btn-default" href={url} target="_blank" rel="noreferrer noopener">
          Open the sign-in page
        </a>
      )}
      <pre className="terminal" aria-live="polite">
        {lines.join('') || 'Waiting for the sign-in command…'}
      </pre>
      {note !== null && <p className="muted">{note}</p>}
      <div className="form-actions">
        {ended ? (
          <Button variant="primary" onClick={onDone}>
            Check the sign-in
          </Button>
        ) : (
          <Button onClick={onCancel}>Cancel sign-in</Button>
        )}
      </div>
    </div>
  )
}
