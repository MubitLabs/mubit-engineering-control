import { Btn } from '../components/base'
import { PaneHead } from '../components/Rail'
import { SlotCard } from '../components/Slots'
import { useWorkbench } from '../workbench'

/** Slots: one card per slot — engine, plan, identity, an honest usage line, and the served actions. */
export function SlotsView() {
  const wb = useWorkbench()
  const listed = wb.slots.filter((slot) => slot.state !== 'retired')

  return (
    <section className="pane is-active" id="pane-slots" aria-labelledby="slots-title">
      <PaneHead
        title="Slots"
        sub="Each slot is one engine signed in to one account. Keys and logins stay on this machine; MEC keeps only a fingerprint."
      >
        <Btn variant="primary" onClick={() => wb.openSheet({ kind: 'key' })}>
          Add a slot
        </Btn>
      </PaneHead>
      {listed.length === 0 ? (
        <div className="empty">
          <p>No slots yet. A slot is one engine signed in to one account — add the first one in Setup.</p>
        </div>
      ) : (
        <ul className="slot-grid">
          {listed.map((slot) => (
            <SlotCard key={slot.id} slot={slot} />
          ))}
        </ul>
      )}
    </section>
  )
}
