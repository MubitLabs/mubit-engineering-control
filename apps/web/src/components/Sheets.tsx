import { useCallback, useEffect, useRef, useState } from 'react'
import { api, HttpError, type LoginCardEvent, subscribeLoginCard } from '../api'
import { useWorkbench } from '../workbench'
import { Btn } from './base'

/**
 * Sheets: the terminal sign-in card (§5.6), the API-key form (§5.7) and the
 * switch-slot confirmation. role=dialog + aria-modal, Esc closes (the global
 * chain), focus lands inside on open and returns to the opener on close.
 */

export type SheetProps = { onClose: () => void }

export function Sheet({ title, id, children }: { title: string; id: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const sheet = ref.current
    if (sheet === null) return
    const first = sheet.querySelector('input, button')
    if (first instanceof HTMLElement) first.focus({ preventScroll: true })
  }, [])
  return (
    <div className="sheet" id={id} ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="sr-only">
        {title}
      </h2>
      {children}
    </div>
  )
}

/** The live login terminal: output streams in, the URL opens the vendor's own page. */
export function TerminalCard({ lines, live }: { lines: string[]; live: boolean }) {
  return (
    <div className="terminal" aria-live="polite">
      <pre>{lines.join('') || 'waiting for the login card…'}</pre>
      {live ? null : <p className="muted">The card has ended.</p>}
    </div>
  )
}

export function LoginSheet({ engine, label }: { engine: 'claude' | 'codex' | 'opencode'; label: string }) {
  const wb = useWorkbench()
  const [lines, setLines] = useState<string[]>([])
  const [live, setLive] = useState(true)
  const [note, setNote] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const terminalRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let detach: (() => void) | null = null
    let alive = true
    api
      .startLogin(engine, label)
      .then((started) => {
        if (!alive) return
        if (started.busy) setNote('a login card is already running — attached to it')
        detach = subscribeLoginCard((event: LoginCardEvent) => {
          if (!alive) return
          if (event.kind === 'output') setLines((current) => [...current.slice(-49), event.data])
          else if (event.kind === 'exit') {
            setLive(false)
            setNote(`login card exited (${event.code}) — continue once you are signed in`)
          } else if (event.kind === 'timeout') {
            setLive(false)
            setNote('login card timed out after ten minutes')
          } else setUrl(event.url)
        })
      })
      .catch((error: unknown) => {
        if (!alive) return
        setLive(false)
        setNote(
          error instanceof HttpError
            ? (error.reason ?? `failed (HTTP ${error.status})`)
            : 'could not reach the runtime — try again',
        )
      })
    return () => {
      alive = false
      detach?.()
    }
  }, [engine, label])

  const engineWords = engine === 'claude' ? 'Anthropic’s' : engine === 'codex' ? 'OpenAI’s' : 'the provider’s'

  return (
    <Sheet id="sheet-login" title={`Sign in to ${label}`}>
      <header className="sheet-head">
        <h2 style={{ fontSize: 'var(--t-title)', fontWeight: 600 }}>
          Sign in to <span className="mono">{label}</span>
        </h2>
        <p className="muted">
          This is {engineWords} own sign-in, running in your terminal. MEC watches for the URL and never reads
          the token.
        </p>
      </header>
      <div ref={terminalRef}>
        <TerminalCard lines={lines} live={live} />
      </div>
      <div className="sheet-actions">
        <Btn
          variant="primary"
          disabled={url === null}
          onClick={() => {
            if (url !== null) window.open(url, '_blank', 'noopener')
          }}
        >
          Open the sign-in page
        </Btn>
        <Btn variant="quiet" onClick={() => terminalRef.current?.querySelector('pre')?.focus()}>
          Paste code
        </Btn>
        <Btn
          variant="quiet"
          onClick={() => {
            api.cancelLogin().catch(() => {})
            wb.closeSheet()
          }}
        >
          Cancel
        </Btn>
        <p className="muted">Times out in 10 minutes. One sign-in at a time.</p>
        {note === null ? null : <p className="muted">{note}</p>}
      </div>
    </Sheet>
  )
}

/** The §5.7 courier — the ONLY door a key enters through. */
export function KeyForm({ prefillLabel }: { prefillLabel?: string }) {
  const wb = useWorkbench()
  const [provider, setProvider] = useState<'anthropic-api' | 'glm-api' | 'gemini-api'>('anthropic-api')
  const [label, setLabel] = useState(prefillLabel ?? '')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const add = useCallback(async () => {
    const trimmedLabel = label.trim()
    if (trimmedLabel === '' || key === '') return
    setBusy(true)
    setNote(null)
    try {
      await api.addApiKey(trimmedLabel, key, provider)
      setKey('')
      setLabel('')
      wb.toast(`Key stored for ${trimmedLabel} — the keystore keeps it, the store keeps a fingerprint.`)
      wb.closeSheet()
      await wb.refresh()
    } catch (error) {
      if (error instanceof HttpError) {
        setNote(
          error.status === 400
            ? (error.reason ?? 'rejected: the key does not match the selected provider’s shape')
            : error.status === 409
              ? 'a slot with that label already exists'
              : `failed (HTTP ${error.status})`,
        )
      } else {
        setNote('could not reach the runtime — try again')
      }
    } finally {
      setBusy(false)
    }
  }, [label, key, provider, wb])

  return (
    <Sheet id="sheet-key" title="Add an API key">
      <header className="sheet-head">
        <h2 style={{ fontSize: 'var(--t-title)', fontWeight: 600 }}>Add an API key</h2>
        <p className="muted">
          The key goes to the slot’s keystore on this disk. MEC keeps a fingerprint, never the key.
        </p>
      </header>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault()
          void add()
        }}
      >
        <label>
          Provider
          <select onChange={(event) => setProvider(event.target.value as typeof provider)} value={provider}>
            <option value="glm-api">GLM Coding Plan (Z.ai)</option>
            <option value="gemini-api">Gemini API (Google)</option>
            <option value="anthropic-api">Anthropic API</option>
          </select>
        </label>
        <label>
          Slot name
          <input
            type="text"
            placeholder="glm-2"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <label>
          API key
          <input
            type="password"
            placeholder="Paste the key"
            autoComplete="off"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        <p className="form-note">
          Gemini free-tier keys are refused for private repositories: Google may use free-tier prompts to
          improve its products.
        </p>
        <div className="sheet-actions">
          <Btn type="submit" variant="primary" disabled={busy || label.trim() === '' || key === ''}>
            {busy ? 'Validating…' : 'Validate and add'}
          </Btn>
          <Btn variant="quiet" onClick={() => wb.closeSheet()}>
            Cancel
          </Btn>
          {note === null ? null : <p className="muted">{note}</p>}
        </div>
      </form>
    </Sheet>
  )
}

export function SwitchSheet({ itemId }: { itemId: string }) {
  const wb = useWorkbench()
  return (
    <Sheet id="sheet-switch" title="Switch slot">
      <header className="sheet-head">
        <h2 style={{ fontSize: 'var(--t-title)', fontWeight: 600 }}>Switch slot</h2>
        <p className="muted">
          For <span className="mono">{itemId}</span>: a switch names the target slot and confirms that the
          same worktree continues — nothing is lost.
        </p>
      </header>
      <div className="sheet-actions">
        <p className="muted">Slot switching is not served by the server yet.</p>
        <Btn variant="quiet" onClick={() => wb.closeSheet()}>
          Close
        </Btn>
      </div>
    </Sheet>
  )
}
