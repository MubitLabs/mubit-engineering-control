import { useCallback, useState } from 'react'
import { api, type PartEntry, type StatusSnapshot } from '../api'
import { Badge, type BadgeState, Card, EmptyState } from '../components/ui'
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
      <p className="mono">mec slot add</p>
    </Card>
  )
}

export function SlotsView() {
  const [status, setStatus] = useState<StatusSnapshot | null>(null)

  const refresh = useCallback(() => {
    api
      .status()
      .then(setStatus)
      .catch(() => {})
  }, [])
  usePolling(refresh, 5000)

  const slots: Array<[string, PartEntry]> = status
    ? Object.entries(status.parts).filter(([name]) => name.startsWith(SLOT_PREFIX))
    : []

  return (
    <div className="view">
      <h2 className="view-title">Slots</h2>
      {status !== null && (!status.setup.has_slot || !status.setup.has_repository) ? (
        <SetupBanner hasRepository={status.setup.has_repository} hasSlot={status.setup.has_slot} />
      ) : null}
      {slots.length === 0 ? (
        <EmptyState>No slots registered</EmptyState>
      ) : (
        <div className="slot-grid">
          {slots.map(([name, part]) => (
            <SlotCard
              detail={part.detail}
              key={name}
              label={name.slice(SLOT_PREFIX.length) || name}
              state={part.state}
            />
          ))}
        </div>
      )}
    </div>
  )
}
