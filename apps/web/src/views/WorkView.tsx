import { PaneHead } from '../components/Rail'
import { WorkBoard } from '../components/Work'
import { useWorkbench } from '../workbench'

/** Work: every open piece of work, grouped by whom it waits for. */
export function WorkView() {
  const wb = useWorkbench()
  return (
    <section className="pane is-active" id="pane-work" aria-labelledby="work-title">
      <PaneHead title="Work" sub="Every open piece of work, grouped by whom it waits for." />
      <WorkBoard items={wb.work} />
    </section>
  )
}
