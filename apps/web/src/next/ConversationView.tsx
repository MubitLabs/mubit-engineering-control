import { ActivityNote, AgentMessage, DeliveryPlan, PageHeader, UserMessage } from './Conversation'
import { GlossaryButton } from './GlossarySheet'
import { QuestionCard } from './NeedsView'
import { Button } from './primitives'
import { useShellActions } from './Shell'
import { EmptyState } from './states'
import { ReadNotice } from './WorkView'
import type { ConversationViewModel, QuestionView, SurfaceState } from './work-model'

export interface ConversationViewProps {
  surface: SurfaceState
  subtitle: string
  view: ConversationViewModel
  questions: readonly QuestionView[]
  selectedTaskId: string | null
  onOpenTask: (id: string) => void
  /** Opens evidence for the plan's current task. Never a specialist chat. */
  onInspect: () => void
  /** M1.3's intent setter, and nothing else. */
  onDiscuss: () => void
  onAnswer: (id: string, answer: string) => void
  onRetry: () => void
}

export function ConversationView(props: ConversationViewProps) {
  const { surface, view } = props
  const { openInspector } = useShellActions()
  return (
    <div className="conversation">
      <PageHeader title={view.title} subtitle={props.subtitle} action={<GlossaryButton />} />
      <ReadNotice surface={surface} noun="this conversation" onRetry={props.onRetry} />
      {surface.state === 'empty' && (
        <EmptyState title="What should we build?" body="Describe an outcome and the meta agent plans it." />
      )}
      {view.entries.map((entry) => {
        if (entry.kind === 'user') return <UserMessage key={entry.id}>{entry.text}</UserMessage>
        if (entry.kind === 'agent') return <AgentMessage key={entry.id}>{entry.text}</AgentMessage>
        return <ActivityNote key={entry.id}>{entry.text}</ActivityNote>
      })}
      {props.questions.map((question) => (
        <QuestionCard key={question.id} view={question} onAnswer={props.onAnswer} />
      ))}
      {view.plan && (
        <>
          <DeliveryPlan
            {...view.plan}
            tasks={view.plan.tasks.map((task) => ({
              ...task,
              selected: task.id === props.selectedTaskId,
              onOpen: () => {
                props.onOpenTask(task.id)
                openInspector()
              },
            }))}
            action={{ label: 'Discuss this work', onClick: props.onDiscuss }}
          />
          <div className="actions">
            <Button
              variant="text"
              onClick={() => {
                props.onInspect()
                openInspector()
              }}
            >
              Inspect
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
