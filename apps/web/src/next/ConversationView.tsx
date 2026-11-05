import { useEffect, useRef } from 'react'
import { ActivityNote, AgentMessage, DeliveryPlan, PageHeader, UserMessage } from './Conversation'
import { GlossaryButton } from './GlossarySheet'
import { QuestionCard } from './NeedsView'
import { Button } from './primitives'
import { useShellActions } from './Shell'
import { EmptyState } from './states'
import { ReadNotice } from './WorkView'
import type { ConversationEntry, ConversationViewModel, QuestionView, SurfaceState } from './work-model'

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
  /** The text on its way to the server, shown until the thread has it. */
  sending?: string | null
  /** Unassigned history: nothing can be sent here, so the empty state invites nothing. */
  readOnly?: boolean
  /** The message a search chose. */
  foundId?: string | null
}

function Entry({ entry }: { entry: ConversationEntry }) {
  if (entry.kind === 'user') return <UserMessage>{entry.text}</UserMessage>
  if (entry.kind === 'agent') return <AgentMessage>{entry.text}</AgentMessage>
  return <ActivityNote>{entry.text}</ActivityNote>
}

export function ConversationView(props: ConversationViewProps) {
  const { surface, view, sending, foundId } = props
  const { openInspector } = useShellActions()
  const end = useRef<HTMLDivElement>(null)
  const found = useRef<HTMLDivElement>(null)
  const newest = view.entries.at(-1)?.id
  const isSending = sending != null

  useEffect(() => {
    if (foundId) found.current?.scrollIntoView?.({ block: 'center' })
    else if (newest !== undefined || isSending) end.current?.scrollIntoView?.({ block: 'end' })
  }, [foundId, newest, isSending])

  return (
    <div className="conversation">
      <PageHeader title={view.title} subtitle={props.subtitle} action={<GlossaryButton />} />
      <ReadNotice surface={surface} noun="this conversation" onRetry={props.onRetry} />
      {surface.state === 'empty' && !isSending && (
        <EmptyState
          title={props.readOnly ? 'Nothing here' : 'What should we build?'}
          body={
            props.readOnly
              ? 'There is no conversation without a repository.'
              : 'Describe an outcome and the meta agent plans it.'
          }
        />
      )}
      {view.entries.map((entry) =>
        entry.id === foundId ? (
          <div key={entry.id} ref={found} className="entry-found">
            <Entry entry={entry} />
          </div>
        ) : (
          <Entry key={entry.id} entry={entry} />
        ),
      )}
      {isSending && (
        <>
          <UserMessage>{sending}</UserMessage>
          <ActivityNote>Sending</ActivityNote>
        </>
      )}
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
            {...(view.discuss && { action: { label: view.discuss.label, onClick: props.onDiscuss } })}
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
      <div ref={end} />
    </div>
  )
}
