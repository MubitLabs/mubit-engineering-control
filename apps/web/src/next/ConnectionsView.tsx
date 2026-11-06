import { type ReactNode, useState } from 'react'
import { engineName } from './ConnectionForm'
import { PageHeader } from './Conversation'
import {
  type Capabilities,
  type ConnectionRow,
  canRetire,
  capabilityGate,
  connectionActions,
} from './config-model'
import { Button, Status, type StatusTone } from './primitives'

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

const when = (iso: string): string => new Date(iso).toLocaleString()

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
  capabilities,
  commands,
  arm,
  note,
}: {
  row: ConnectionRow
  capabilities: Capabilities | null
  commands: ConnectionCommands
  arm: RetireArm | null
  note: string | undefined
}) {
  const [replacing, setReplacing] = useState(false)
  const actions = connectionActions(row)
  const drain = capabilityGate(capabilities, 'drain')
  const switchWork = capabilityGate(capabilities, 'switchWork')
  const identity = [row.identity?.email, row.identity?.plan].filter(Boolean).join(', ')
  return (
    <li className="connection">
      <header className="connection-head">
        <div>
          <h2>{row.label}</h2>
          <p className="muted">
            {engineName(row.engine)}
            {row.engineVersion ? ` ${row.engineVersion}` : ''}, {row.provider}
          </p>
        </div>
        <Status tone={toneOf(row.state)}>{STATE_WORDS[row.state] ?? row.state}</Status>
      </header>
      {row.stateReason && <p className="field-note">{REASON_WORDS[row.stateReason] ?? row.stateReason}</p>}
      <dl className="facts-grid">
        <Fact term="Identity">{identity || 'Not reported'}</Fact>
        <Fact term="Key">{row.fingerprint ? `Ends ${row.fingerprint.last4}` : 'None stored'}</Fact>
        <Fact term="Last check">{row.lastProbeAt ? when(row.lastProbeAt) : 'Not checked yet'}</Fact>
        <Fact term="Usage">No reading yet</Fact>
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
          <Button aria-expanded={replacing} onClick={() => setReplacing(true)}>
            Replace key
          </Button>
        )}
        <Button variant="quiet" disabled={!drain.enabled} title={drain.enabled ? undefined : drain.reason}>
          Drain
        </Button>
        <Button
          variant="quiet"
          disabled={!switchWork.enabled}
          title={switchWork.enabled ? undefined : switchWork.reason}
        >
          Switch work
        </Button>
        <Button variant="quiet" aria-expanded={arm !== null} onClick={() => commands.armRetire(row.id)}>
          Retire
        </Button>
      </div>
      {replacing && (
        <ReplaceKey
          onReplace={(key) => commands.replaceKey(row.id, key)}
          onClose={() => setReplacing(false)}
        />
      )}
      {arm && (
        <RetirePanel
          row={row}
          arm={arm}
          onCancel={commands.disarmRetire}
          onRetire={() => commands.retire(row.id, row.label)}
        />
      )}
    </li>
  )
}

export function ConnectionsView({
  rows,
  capabilities,
  commands,
  arm,
  notes,
  adding,
  onAdd,
  form,
}: {
  rows: readonly ConnectionRow[]
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
  return (
    <div className="page">
      <PageHeader
        title="Connections"
        subtitle="Each connection is one engine signed in to one account. Keys and logins stay on this machine."
        action={
          adding ? undefined : (
            <Button variant="primary" onClick={onAdd}>
              Add connection
            </Button>
          )
        }
      />
      {adding && <section className="config-block">{form}</section>}
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
