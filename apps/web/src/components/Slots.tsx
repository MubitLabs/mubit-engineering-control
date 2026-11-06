import { useCallback, useState } from 'react'
import { api, HttpError, type SlotEntry, type SlotUsage } from '../api'
import { useWorkbench } from '../workbench'
import { Btn } from './base'
import { stateKindOf } from './Work'

/**
 * One slot per card: name, state, engine and plan, a usage meter only where a
 * reading exists ("No reading yet" otherwise — never 0%), and the actions the
 * server actually serves.
 */

export function Meter({ usage }: { usage: Extract<SlotUsage, { kind: 'percent' }> }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: §8 of the design spec fixes role="meter" on usage meters; a native <meter> cannot carry this design.
    <div
      className="meter"
      role="meter"
      aria-valuenow={Math.round(usage.percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={usage.label}
    >
      <span style={{ width: `${Math.max(0, Math.min(100, usage.percent))}%` }} />
    </div>
  )
}

export function SlotCard({ slot }: { slot: SlotEntry }) {
  const wb = useWorkbench()
  const [busy, setBusy] = useState<'validate' | 'retire' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const state = stateKindOf(slot.state)
  const cardKind = state.kind === 'attn' ? 'slot-attn' : state.kind === 'warn' ? 'slot-warn' : ''

  const validate = useCallback(async () => {
    setBusy('validate')
    setNote(null)
    try {
      const result = await api.validateSlot(slot.id)
      setNote(
        result.ok
          ? 'probe ok — slot healthy'
          : result.reason === 'key_rejected'
            ? 'provider rejected the key — replace it'
            : 'provider unreachable — state unchanged',
      )
    } catch {
      setNote('could not reach the runtime — try again')
    } finally {
      setBusy(null)
      void wb.refresh()
    }
  }, [slot.id, wb])

  const retire = useCallback(async () => {
    setBusy('retire')
    setNote(null)
    try {
      await api.retireSlot(slot.id)
      setNote('retired — key file shredded')
    } catch (error) {
      // §13: the server now needs the label repeated, which only the new workbench asks for.
      setNote(
        error instanceof HttpError && error.status === 400
          ? 'nothing retired — retire from Connections in the new workbench (add ?ui=next)'
          : 'could not reach the runtime — try again',
      )
    } finally {
      setBusy(null)
      void wb.refresh()
    }
  }, [slot.id, wb])

  const openLogin = () => wb.openSheet({ kind: 'login', engine: engineNameOf(slot), label: slot.label })

  return (
    <li className={`slot ${cardKind}`.trim()}>
      <header className="slot-head">
        <h3>{slot.label}</h3>
        <span className={`state${state.kind === 'none' ? '' : ` state-${state.kind}`}`}>{state.label}</span>
      </header>
      <p className="slot-line">
        {slot.provider}
        {slot.fingerprint === undefined ? null : (
          <>
            {' '}
            key <span className="mono">…{slot.fingerprint.last4}</span>
          </>
        )}
      </p>
      {slot.usage === undefined ? (
        <p className="slot-line">No reading yet — usage is not served by the server yet.</p>
      ) : slot.usage.kind === 'percent' ? (
        <>
          <Meter usage={slot.usage} />
          {(slot.usage.lines ?? []).map((line) => (
            <p className="slot-line" key={line}>
              {line}
            </p>
          ))}
        </>
      ) : (
        <p className="slot-line">No reading yet — {slot.usage.reason}.</p>
      )}
      {slot.stateReason === undefined ? null : <p className="slot-line">{slot.stateReason}</p>}
      <div className="slot-actions">
        {slot.state === 'login_expired' ? (
          <Btn variant="primary" onClick={openLogin}>
            Sign in again
          </Btn>
        ) : null}
        {slot.kind === 'api-key' || slot.fingerprint !== undefined ? (
          <>
            <Btn
              variant="quiet"
              disabled={busy !== null || slot.state === 'retired'}
              onClick={() => void validate()}
            >
              {busy === 'validate' ? 'Validating…' : 'Validate'}
            </Btn>
            <Btn
              variant="quiet"
              onClick={() => wb.openSheet({ kind: 'key', prefillLabel: nextLabel(slot.label) })}
            >
              Replace key
            </Btn>
          </>
        ) : null}
        <Btn
          variant="quiet"
          disabled={busy !== null || slot.state === 'retired'}
          onClick={() => void retire()}
        >
          {busy === 'retire' ? 'Retiring…' : 'Retire'}
        </Btn>
      </div>
      {note === null ? null : <p className="slot-line muted">{note}</p>}
    </li>
  )
}

function engineNameOf(slot: SlotEntry): 'claude' | 'codex' | 'opencode' {
  if (slot.engine === 'codex') return 'codex'
  if (slot.engine === 'opencode') return 'opencode'
  return 'claude'
}

function nextLabel(label: string): string {
  const match = /^(.*?)(\d+)$/.exec(label)
  if (match === null) return label
  return `${match[1]}${Number(match[2]) + 1}`
}
