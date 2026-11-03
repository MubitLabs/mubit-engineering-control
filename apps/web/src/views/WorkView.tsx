import { EmptyState } from '../components/ui'

const COLUMNS = ['ready', 'active', 'awaiting review'] as const

export function WorkView() {
  return (
    <div className="view">
      <h2 className="view-title">Work</h2>
      <EmptyState>No work items</EmptyState>
      <div className="board">
        {COLUMNS.map((column) => (
          <section key={column} className="board-col">
            <h3 className="board-col-title">{column}</h3>
          </section>
        ))}
      </div>
    </div>
  )
}
