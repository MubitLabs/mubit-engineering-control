import type { SaveBarView } from './config-model'
import { Button } from './primitives'

/** One bar per block (§18): present only while a draft exists, a save runs or a save failed. */
export function SaveBar({
  view,
  onSave,
  onDiscard,
  onUseNewest,
}: {
  view: SaveBarView
  onSave: () => void
  onDiscard: () => void
  /** Carries the kept draft onto the newest saved version, once the owner has read the notice. */
  onUseNewest?: () => void
}) {
  if (!view.visible) return null
  return (
    <div className="save-bar" role="status">
      <p>{view.message}</p>
      <div className="save-actions">
        <Button variant="quiet" disabled={view.saving} onClick={onDiscard}>
          {view.stale ? 'Discard my draft' : 'Discard'}
        </Button>
        {view.stale && onUseNewest && (
          <Button variant="quiet" onClick={onUseNewest}>
            Keep my draft on the newest version
          </Button>
        )}
        <Button variant="primary" disabled={!view.canSave} onClick={onSave}>
          {view.saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
