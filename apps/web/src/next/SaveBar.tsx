import { type RefObject, useEffect, useRef } from 'react'
import type { SaveBarView } from './config-model'
import { Button } from './primitives'

/** One bar per block (§18): present only while a draft exists, a save runs or a save failed. */
export function SaveBar({
  view,
  onSave,
  onDiscard,
  onUseNewest,
  returnFocus,
}: {
  view: SaveBarView
  onSave: () => void
  onDiscard: () => void
  /** Carries the kept draft onto the newest saved version, once the owner has read the notice. */
  onUseNewest?: () => void
  /** Where focus goes when the bar it was on leaves. */
  returnFocus: RefObject<HTMLElement | null>
}) {
  const acted = useRef(false)
  useEffect(() => {
    if (view.visible || !acted.current) return
    acted.current = false
    returnFocus.current?.focus()
  }, [view.visible, returnFocus])
  const act = (action: () => void) => () => {
    acted.current = true
    action()
  }
  if (!view.visible) return null
  return (
    <div className="save-bar" role="status">
      <p>{view.message}</p>
      <div className="save-actions">
        <Button variant="quiet" disabled={view.saving} onClick={act(onDiscard)}>
          {view.stale ? 'Discard my draft' : 'Discard'}
        </Button>
        {view.stale && onUseNewest && (
          <Button variant="quiet" onClick={onUseNewest}>
            Keep my draft on the newest version
          </Button>
        )}
        <Button variant="primary" disabled={!view.canSave} onClick={act(onSave)}>
          {view.saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
