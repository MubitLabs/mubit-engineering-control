import { Button, Card, EmptyState } from '../components/ui'

export function ChatView() {
  return (
    <div className="chat">
      <Card>
        {/* Inbox strip: decision cards waiting on a person surface here (§12.6) */}
        <EmptyState>No decisions waiting</EmptyState>
      </Card>
      <div className="messages">
        <EmptyState>No messages yet — the meta agent will answer here</EmptyState>
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
        }}
      >
        <input disabled placeholder="the meta agent connects at runtime" type="text" />
        <Button disabled variant="primary">
          Send
        </Button>
      </form>
    </div>
  )
}
