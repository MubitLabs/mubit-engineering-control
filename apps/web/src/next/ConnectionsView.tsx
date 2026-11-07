import { type ReactNode, useEffect, useRef, useState } from 'react'
import { engineName } from './ConnectionForm'
import { PageHeader } from './Conversation'
import {
  type Capabilities,
  type ConnectionRow,
  canRetire,
  capabilityGate,
  connectionActions,
  type ParkedRow,
} from './config-model'
import { timeLabel } from './format'
import { type ParkedCommands, ParkedNotices } from './ParkedNotice'
import { Button, Status, type StatusTone, useFormFocus } from './primitives'

/** Calls that can fail say how; the row keeps showing what is true until the server has answered. */
export interface ConnectionCommands {
  validate: (id: string) => void
  probe: (id: string) => void
  signIn: (row: ConnectionRow) => void
  replaceKey: (id: string, key: string) => void
  armRetire: (id: string) => void
  disarmRetire: () => void
  retire: (id: string, label: string) => void
}

export interface RetireArm {
  id: string
  /** Null while the impact read is on its way: nothing can be confirmed before it is shown. */
  lines: readonly string[] | null
  error: string | null
  busy: boolean
}

/** The engine, its version and its provider, as far as each is known. */
export function connectionLine(engine: string, version?: string, provider?: string): string {
  const name = version ? `${engine} ${version}` : engine
  return provider ? `${name}, ${provider}` : name
}

const toneOf = (state: string): StatusTone =>
  state === 'healthy' ? 'good' : state === 'degraded' ? 'attention' : 'neutral'

const STATE_WORDS: Record<string, string> = {
  healthy: 'Healthy',
  degraded: 'Needs attention',
  home_ready: 'Not checked yet',
  login_pending: 'Not checked yet',
  draft: 'Not set up',
}

const REASON_WORDS: Record<string, string> = {
  auth_expired: 'Sign-in expired.',
  key_rejected: 'The provider rejected the key.',
  quota_exhausted: 'Quota used up.',
  engine_missing: 'The engine was not found.',
  engine_unsupported: 'This engine version is not supported.',
  provider_unreachable: 'The provider could not be reached.',
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function ReplaceKey({ onReplace, onClose }: { onReplace: (key: string) => void; onClose: () => void }) {
  const [key, setKey] = useState('')
  return (
    <form
      className="armed-panel"
      onSubmit={(event) => {
        event.preventDefault()
        if (key === '') return
        onReplace(key)
        setKey('')
        onClose()
      }}
    >
      <p>The new key replaces the stored one in place, and MEC checks it straight away.</p>
      <label className="field">
        New API key
        <input
          type="password"
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
      </label>
      <div className="form-actions">
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={key === ''}>
          Replace key
        </Button>
      </div>
    </form>
  )
}

function RetirePanel({
  row,
  arm,
  onCancel,
  onRetire,
}: {
  row: ConnectionRow
  arm: RetireArm
  onCancel: () => void
  onRetire: () => void
}) {
  const [typed, setTyped] = useState('')
  return (
    <form
      className="armed-panel armed-danger"
      onSubmit={(event) => {
        event.preventDefault()
        if (canRetire(typed, row.label) && arm.lines !== null) onRetire()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      <h3>Retire {row.label}?</h3>
      {arm.lines === null ? (
        <p className="muted">Reading what this affects…</p>
      ) : (
        <ul>
          {arm.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      <label className="field">
        Type {row.label} to confirm
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
      </label>
      {arm.error !== null && (
        <p className="field-error" role="alert">
          {arm.error}
        </p>
      )}
      <div className="form-actions">
        <Button variant="quiet" onClick={onCancel}>
          Keep this connection
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={arm.busy || arm.lines === null || !canRetire(typed, row.label)}
        >
          {arm.busy ? 'Retiring…' : `Retire ${row.label}`}
        </Button>
      </div>
    </form>
  )
}

function ConnectionItem({
  row,
  rows,
  parked,
  parkedCommands,
  capabilities,
  commands,
  arm,
  note,
}: {
  row: ConnectionRow
  rows: readonly ConnectionRow[]
  parked: readonly ParkedRow[]
  parkedCommands: ParkedCommands
  capabilities: Capabilities | null
  commands: ConnectionCommands
  arm: RetireArm | null
  note: string | undefined
}) {
  const [replacing, setReplacing] = useState(false)
  const actions = connectionActions(row)
  const drain = capabilityGate(capabilities, 'drain')
  const switchWork = capabilityGate(capabilities, 'switchWork')
  const parkedHere = parked.filter((entry) => entry.slotId === row.id)
  const switchReason = switchWork.enabled ? 'Nothing is parked on this connection.' : switchWork.reason
  const identity = [row.identity?.email, row.identity?.plan].filter(Boolean).join(', ')
  const replaceFocus = useFormFocus(replacing)
  const retireFocus = useFormFocus(arm !== null)
  return (
    <li className="connection">
      <header className="connection-head">
        <div>
          <h2>{row.label}</h2>
          <p className="muted">{connectionLine(engineName(row.engine), row.engineVersion, row.provider)}</p>
        </div>
        <Status tone={toneOf(row.state)}>{STATE_WORDS[row.state] ?? row.state}</Status>
      </header>
      {row.stateReason && <p className="field-note">{REASON_WORDS[row.stateReason] ?? row.stateReason}</p>}
      <dl className="facts-grid">
        <Fact term="Identity">{identity || 'Not reported'}</Fact>
        <Fact term="Key">{row.fingerprint ? `Ends ${row.fingerprint.last4}` : 'None stored'}</Fact>
        <Fact term="Last check">{row.lastProbeAt ? timeLabel(row.lastProbeAt) : 'Not checked yet'}</Fact>
        <Fact term="Usage">No reading yet. MEC does not record usage for a connection.</Fact>
        <Fact term="Runs at once">{row.concurrency ?? 'Default limit'}</Fact>
        <Fact term="Slot class">{row.slotClass ?? 'None set'}</Fact>
        <Fact term="Pinned version">Not pinned</Fact>
        <Fact term="Paired with">No pair</Fact>
      </dl>
      {note && (
        <p className="muted" role="status">
          {note}
        </p>
      )}
      {actions.signIn === 'terminal' && (
        <p className="field-note">
          This is your own login. Run claude auth login in a terminal, then check it again here.
        </p>
      )}
      <div className="connection-actions">
        {actions.signIn === 'card' && (
          <Button variant="primary" onClick={() => commands.signIn(row)}>
            Sign in again
          </Button>
        )}
        {actions.probe && <Button onClick={() => commands.probe(row.id)}>Check again</Button>}
        {actions.validate && <Button onClick={() => commands.validate(row.id)}>Validate</Button>}
        {actions.replaceKey && (
          <Button ref={replaceFocus.opener} aria-expanded={replacing} onClick={() => setReplacing(true)}>
            Replace key
          </Button>
        )}
        {drain.enabled && <Button variant="quiet">Drain</Button>}
        {parkedHere.length === 0 && (
          <Button variant="quiet" disabled title={switchReason}>
            Switch work
          </Button>
        )}
        <Button
          ref={retireFocus.opener}
          variant="quiet"
          aria-expanded={arm !== null}
          onClick={() => commands.armRetire(row.id)}
        >
          Retire
        </Button>
      </div>
      <ParkedNotices
        rows={parkedHere}
        all={parked}
        connections={rows}
        capabilities={capabilities}
        commands={parkedCommands}
      />
      {replacing && (
        <div ref={replaceFocus.form}>
          <ReplaceKey
            onReplace={(key) => commands.replaceKey(row.id, key)}
            onClose={() => setReplacing(false)}
          />
        </div>
      )}
      {arm && (
        <div ref={retireFocus.form}>
          <RetirePanel
            row={row}
            arm={arm}
            onCancel={commands.disarmRetire}
            onRetire={() => commands.retire(row.id, row.label)}
          />
        </div>
      )}
    </li>
  )
}

export function ConnectionsView({
  rows,
  parked,
  parkedCommands,
  capabilities,
  commands,
  arm,
  notes,
  adding,
  onAdd,
  form,
}: {
  rows: readonly ConnectionRow[]
  parked: readonly ParkedRow[]
  parkedCommands: ParkedCommands
  capabilities: Capabilities | null
  commands: ConnectionCommands
  arm: RetireArm | null
  notes: Readonly<Record<string, string>>
  adding: boolean
  onAdd: () => void
  /** The shared form, or the sign-in card once one is running. */
  form: ReactNode
}) {
  const unavailable = [capabilityGate(capabilities, 'drain'), capabilityGate(capabilities, 'switchWork')]
    .flatMap((gate) => (gate.enabled ? [] : [gate.reason]))
    .filter(() => rows.length > 0)
  const { opener, form: panel } = useFormFocus(adding)
  // A retired row takes the focus on it away. Add connection is the next thing on the page.
  const count = useRef(rows.length)
  useEffect(() => {
    if (rows.length < count.current && document.activeElement === document.body) opener.current?.focus()
    count.current = rows.length
  }, [rows.length, opener])
  return (
    <div className="page">
      <PageHeader
        title="Connections"
        subtitle="Each connection is one engine signed in to one account. Keys and logins stay on this machine."
        action={
          adding ? undefined : (
            <Button ref={opener} variant="primary" onClick={onAdd}>
              Add connection
            </Button>
          )
        }
      />
      {adding && (
        <div ref={panel} className="config-block">
          {form}
        </div>
      )}
      {rows.length === 0 && !adding ? (
        <div className="empty">
          <h2>No connections yet</h2>
          <p>Add one so MEC has an engine to run.</p>
        </div>
      ) : (
        <ul className="connection-list">
          {rows.map((row) => (
            <ConnectionItem
              key={row.id}
              row={row}
              rows={rows}
              parked={parked}
              parkedCommands={parkedCommands}
              capabilities={capabilities}
              commands={commands}
              arm={arm?.id === row.id ? arm : null}
              note={notes[row.id]}
            />
          ))}
        </ul>
      )}
      {unavailable.map((reason) => (
        <p key={reason} className="field-note">
          {reason}
        </p>
      ))}
    </div>
  )
}
