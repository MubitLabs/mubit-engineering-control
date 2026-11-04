import { PaneHead } from '../components/Rail'
import { type TrayCard, TrayCards } from '../components/Tray'
import { useWorkbench } from '../workbench'

/** The Needs-you page: the tray's same cards with a keyboard home (§4). */
export function NeedsView() {
  const wb = useWorkbench()
  const cards: TrayCard[] = [
    ...wb.inbox.map((item) => ({ kind: 'decision' as const, item })),
    ...wb.questions.map((question) => ({ kind: 'question' as const, question })),
  ]
  const open = cards.filter((card) => wb.resolutions[cardKindId(card)] === undefined).length

  return (
    <section className="pane is-active" id="pane-needs" aria-labelledby="needs-title">
      <PaneHead
        title="Needs you"
        sub={
          open === 0
            ? 'Nothing waits for you right now.'
            : `${open} thing${open === 1 ? '' : 's'} wait for you. Approve what leaves the machine; answer what a specialist cannot decide.`
        }
      />
      <p className="muted" style={{ maxWidth: '62ch' }}>
        This is the same list as the tray in Chat, kept here so it has a keyboard home: <kbd>J</kbd>{' '}
        <kbd>K</kbd> to move, <kbd>A</kbd> to approve, <kbd>D</kbd> to deny, <kbd>Enter</kbd> to open the
        evidence.
      </p>
      <div className="empty-hint" id="needs-mirror">
        {cards.length === 0 ? (
          <div className="empty">
            <p>Nothing waits for you. When an agent needs a person, the card appears here and in Chat.</p>
          </div>
        ) : (
          <section className="tray">
            <TrayCards cards={cards} />
          </section>
        )}
      </div>
    </section>
  )
}

function cardKindId(card: TrayCard): string {
  return card.kind === 'decision' ? card.item.id : card.question.id
}
