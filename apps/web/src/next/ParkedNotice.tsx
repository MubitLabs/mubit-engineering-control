import { useState } from 'react'
import {
  type Capabilities,
  type ConnectionRow,
  type ParkedRow,
  parkedFacts,
  parkedMoves,
  switchPlan,
} from './config-model'
import { timeLabel } from './format'
import { Button } from './primitives'

export interface ParkedCommands {
  /** Sends the switch. Resolves with the server's answer in words; it never claims more. */
  switchWork: (row: ParkedRow, target: ConnectionRow) => Promise<string>
  signIn: (row: ParkedRow) => void
}

function ParkedItem({
  row,
  all,
  connections,
  capabilities,
  commands,
}: {
  row: ParkedRow
  all: readonly ParkedRow[]
  connections: readonly ConnectionRow[]
  capabilities: Capabilities | null
  commands: ParkedCommands
}) {
  const [target, setTarget] = useState<ConnectionRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)
  const facts = parkedFacts(row, timeLabel)
  const moves = parkedMoves(row, all, connections, capabilities)
  const plan = target === null ? null : switchPlan(row, target)
  const send = (chosen: ConnectionRow) => {
    setBusy(true)
    commands
      .switchWork(row, chosen)
      .then(setOutcome)
      .finally(() => {
        setBusy(false)
        setTarget(null)
      })
  }
  return (
    <li className="parked-item">
      <h3>{facts.heading}</h3>
      <p className="muted">{row.workTitle}</p>
      <dl className="facts-grid">
        <div>
          <dt>Connection</dt>
          <dd>{facts.slot}</dd>
        </div>
        <div>
          <dt>Reason</dt>
          <dd>{facts.reason}</dd>
        </div>
        <div>
          <dt>Reset</dt>
          <dd>{facts.reset}</dd>
        </div>
        <div>
          <dt>Worktree</dt>
          <dd>{facts.worktree}</dd>
        </div>
      </dl>
      {outcome !== null && (
        <p className="muted" role="status">
          {outcome}
        </p>
      )}
      {moves.note !== null && <p className="field-note">{moves.note}</p>}
      <div className="connection-actions">
        {moves.signIn && (
          <Button variant="primary" onClick={() => commands.signIn(row)}>
            Sign in again
          </Button>
        )}
        {plan === null &&
          moves.targets.map((choice) => (
            <Button key={choice.id} onClick={() => setTarget(choice)}>
              Switch work to {choice.label}
            </Button>
          ))}
      </div>
      {plan !== null && target !== null && (
        <div className="armed-panel">
          <h3>{plan.title}</h3>
          <ul>
            {plan.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="form-actions">
            <Button variant="quiet" disabled={busy} onClick={() => setTarget(null)}>
              Keep it parked
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => send(target)}>
              {busy ? 'Asking…' : plan.confirmLabel}
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}

/** The parked work in `rows`; `all` is every park, because a sibling's can rule a switch out. */
export function ParkedNotices({
  rows,
  all,
  connections,
  capabilities,
  commands,
}: {
  rows: readonly ParkedRow[]
  all: readonly ParkedRow[]
  connections: readonly ConnectionRow[]
  capabilities: Capabilities | null
  commands: ParkedCommands
}) {
  if (rows.length === 0) return null
  return (
    <ul className="parked-list" aria-label="Parked work">
      {rows.map((row) => (
        <ParkedItem
          key={row.attemptId}
          row={row}
          all={all}
          connections={connections}
          capabilities={capabilities}
          commands={commands}
        />
      ))}
    </ul>
  )
}
