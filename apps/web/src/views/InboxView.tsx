import { Button, Card, EmptyState } from '../components/ui'

export type DecisionCardProps = {
  title: string
  detail: string
  evidencePlaceholder: string
}

/** Stub of the §12.6 decision card; Approve/Deny become functional with guardrails (§13). */
export function DecisionCard({ title, detail, evidencePlaceholder }: DecisionCardProps) {
  return (
    <Card>
      <h3 className="card-title">{title}</h3>
      <p className="card-detail">{detail}</p>
      <details className="evidence">
        <summary>Evidence</summary>
        <p>{evidencePlaceholder}</p>
      </details>
      <div className="card-actions">
        <Button variant="primary">Approve</Button>
        <Button>Deny</Button>
      </div>
    </Card>
  )
}

export function InboxView() {
  return (
    <div className="view">
      <h2 className="view-title">Inbox</h2>
      <EmptyState>Confirmations and questions appear here, newest first</EmptyState>
    </div>
  )
}
