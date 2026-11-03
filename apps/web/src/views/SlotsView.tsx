import { Badge, Card, EmptyState } from '../components/ui'

export type SlotCardProps = {
  label: string
  engine: string
  state: string
}

/** Stub of the §18.4 slot card; one instance renders below until Stream B lands. */
export function SlotCard({ label, engine, state }: SlotCardProps) {
  return (
    <Card>
      <div className="slot-head">
        <span className="slot-label">{label}</span>
        <span className="mono">{engine}</span>
      </div>
      <Badge label={state} state="ok" />
    </Card>
  )
}

export function SlotsView() {
  return (
    <div className="view">
      <h2 className="view-title">Slots</h2>
      <EmptyState>Stream B mounts the real Slots view here</EmptyState>
      <SlotCard engine="claude" label="max-1" state="ready" />
    </div>
  )
}
