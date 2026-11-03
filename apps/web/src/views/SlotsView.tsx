import { useCallback, useState } from 'react'
import { api, HttpError, type PartEntry, type SlotEntry, type StatusSnapshot } from '../api'
import { Badge, type BadgeState, Button, Card, EmptyState } from '../components/ui'
import { routeToHash } from '../router'
import { usePolling } from '../usePolling'

const SLOT_PREFIX = 'slot:'

export type SlotCardProps = {
  label: string
  state: BadgeState
  detail?: string
}

/** §18.4 slot card fed by the health snapshot's `slot:*` part entries. */
export function SlotCard({ label, state, detail }: SlotCardProps) {
  return (
    <Card>
      <div className="slot-head">
        <span className="slot-label">{label}</span>
        <Badge label={state} state={state} />
      </div>
      {detail === undefined ? null : <p className="mono slot-detail">{detail}</p>}
    </Card>
  )
}

/** Plan §21.2 exit 3: the runtime cannot start until slot/repository exist. */
function SetupBanner({ hasSlot, hasRepository }: { hasSlot: boolean; hasRepository: boolean }) {
  const missing: string[] = []
  if (!hasSlot) missing.push('a slot')
  if (!hasRepository) missing.push('a repository')
  return (
    <Card className="setup-banner">
      <h3 className="card-title">waiting for setup</h3>
      <p className="card-detail">the workbench still needs {missing.join(' and ')}</p>
      <div className="card-actions">
        <Button onClick={() => (window.location.hash = routeToHash('wizard'))} variant="primary">
          Run setup
        </Button>
        <span className="mono slot-detail">or: mec slot add</span>
      </div>
    </Card>
  )
}

/**
 * §5.7 courier form — provider → key (masked, never echoed) → Add. The ONLY way a key
 * enters MEC: it goes to the slot keystore and the field is cleared the moment the
 * courier accepts it, so the key never lingers in component state either. Exported
 * for the wizard's step 2 — one form, one shape, wherever a key is pasted.
 */
export function AddApiKeyCard({ onAdded }: { onAdded: () => void }) {
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [provider, setProvider] = useState<'anthropic-api' | 'glm-api' | 'gemini-api'>('anthropic-api')
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
      setNote(
        provider === 'anthropic-api'
          ? 'key stored — validate it below'
          : 'key stored (pattern-checked); live validation arrives with the OpenCode wiring',
      )
      onAdded()
    } catch (error) {
      if (error instanceof HttpError) {
        setNote(
          error.status === 400
            ? 'rejected: the key does not match the selected provider’s shape'
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
  }, [label, key, provider, onAdded])

  return (
    <Card>
      <h3 className="card-title">Add API key</h3>
      <p className="card-detail">
        Provider key → slot keystore (0600, inside the slot home). Stored nowhere else; the database keeps
        only a fingerprint. This form is the ONLY door for keys — never paste one in chat.
      </p>
      <form
        className="key-form"
        onSubmit={(event) => {
          event.preventDefault()
          void add()
        }}
      >
        <select
          aria-label="Provider"
          onChange={(event) => setProvider(event.target.value as typeof provider)}
          value={provider}
        >
          <option value="anthropic-api">Anthropic (Claude API)</option>
          <option value="glm-api">GLM Coding Plan (z.ai)</option>
          <option value="gemini-api">Google Gemini</option>
        </select>
        <input
          aria-label="Slot label"
          onChange={(event) => setLabel(event.target.value)}
          placeholder="slot label, e.g. max-1"
          value={label}
        />
        <input
          aria-label="API key"
          autoComplete="off"
          onChange={(event) => setKey(event.target.value)}
          placeholder={
            provider === 'anthropic-api' ? 'sk-ant-…' : provider === 'glm-api' ? '32 hex chars.…' : 'AIza…'
          }
          type="password"
          value={key}
        />
        <Button disabled={busy || label.trim() === '' || key === ''} type="submit" variant="primary">
          {busy ? 'Adding…' : 'Add'}
        </Button>
        {note === null ? null : <span className="error-note">{note}</span>}
      </form>
    </Card>
  )
}

function badgeOf(state: string): BadgeState {
  if (state === 'healthy') return 'ok'
  if (state === 'degraded') return 'error'
  return 'degraded'
}

/** A claude-api slot from GET /api/slots: fingerprint display + Validate / Retire. */
function ApiSlotCard({ slot, onChanged }: { slot: SlotEntry; onChanged: () => void }) {
  const [busy, setBusy] = useState<'validate' | 'retire' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const retired = slot.state === 'retired'

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
      onChanged()
    }
  }, [slot.id, onChanged])

  const retire = useCallback(async () => {
    if (!window.confirm(`Retire slot ${slot.label}? Its keystore file is shredded.`)) return
    setBusy('retire')
    setNote(null)
    try {
      await api.retireSlot(slot.id)
      setNote('retired — key file shredded')
    } catch {
      setNote('could not reach the runtime — try again')
    } finally {
      setBusy(null)
      onChanged()
    }
  }, [slot.id, slot.label, onChanged])

  const detail = [
    slot.fingerprint === undefined ? slot.provider : `${slot.provider} key ····${slot.fingerprint.last4}`,
    slot.stateReason,
  ]
    .filter((part) => part !== undefined && part !== '')
    .join(' — ')

  return (
    <Card>
      <div className="slot-head">
        <span className="slot-label">{slot.label}</span>
        <Badge label={slot.state} state={badgeOf(slot.state)} />
      </div>
      <p className="mono slot-detail">{detail}</p>
      <div className="card-actions">
        {slot.kind === 'claude-api' ? (
          <Button disabled={busy !== null || retired} onClick={() => void validate()}>
            {busy === 'validate' ? 'Validating…' : 'Validate'}
          </Button>
        ) : null}
        <Button disabled={busy !== null || retired} onClick={() => void retire()}>
          {busy === 'retire' ? 'Retiring…' : 'Retire'}
        </Button>
        {note === null ? null : <span className="error-note">{note}</span>}
      </div>
    </Card>
  )
}

export function SlotsView() {
  const [status, setStatus] = useState<StatusSnapshot | null>(null)
  const [entries, setEntries] = useState<SlotEntry[]>([])

  const refresh = useCallback(() => {
    api
      .status()
      .then(setStatus)
      .catch(() => {})
    api
      .slots()
      .then(setEntries)
      .catch(() => {})
  }, [])
  usePolling(refresh, 5000)

  const parts: Array<[string, PartEntry]> = status
    ? Object.entries(status.parts).filter(([name]) => name.startsWith(SLOT_PREFIX))
    : []

  return (
    <div className="view">
      <h2 className="view-title">Slots</h2>
      {status !== null && (!status.setup.has_slot || !status.setup.has_repository) ? (
        <SetupBanner hasRepository={status.setup.has_repository} hasSlot={status.setup.has_slot} />
      ) : null}
      <AddApiKeyCard onAdded={refresh} />
      {entries.length > 0 ? (
        <div className="slot-grid">
          {entries.map((slot) => (
            <ApiSlotCard key={slot.id} onChanged={refresh} slot={slot} />
          ))}
        </div>
      ) : parts.length > 0 ? (
        <div className="slot-grid">
          {parts.map(([name, part]) => (
            <SlotCard
              detail={part.detail}
              key={name}
              label={name.slice(SLOT_PREFIX.length) || name}
              state={part.state}
            />
          ))}
        </div>
      ) : (
        <EmptyState>No slots registered</EmptyState>
      )}
    </div>
  )
}
