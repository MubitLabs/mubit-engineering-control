import { useState } from 'react'
import { PageHeader } from './Conversation'
import { Approval, Question } from './Decision'
import { GlossaryButton } from './GlossarySheet'
import { Button } from './primitives'
import { useShellActions } from './Shell'
import { StateNotice } from './states'
import { ReadNotice, RepoScope } from './WorkView'
import type {
  ApprovalView,
  NeedCard,
  QuestionView,
  RepoFilterOption,
  SurfaceState,
  WorkNeedView,
} from './work-model'

interface NeedHandlers {
  onAnswer: (id: string, answer: string) => void
  onApprove: (id: string) => void
  onDeny: (id: string) => void
  onInspect: (id: string) => void
  onRetryEvidence: (id: string) => void
  /** Blocked work has nothing to answer here: its way forward is the delivery itself. */
  onOpenWork: (workItemId: string) => void
}

/** The same frame on Needs you and in the conversation: one record, settled once. */
export function QuestionCard({
  view,
  onAnswer,
  claimFocus,
}: {
  view: QuestionView
  onAnswer: NeedHandlers['onAnswer']
  claimFocus?: boolean
}) {
  if (!view.actionable && view.status.state === 'open') {
    return (
      <StateNotice
        kind="blocked"
        title={view.title}
        body="This belongs to work with no repository, so it can be read here and not answered."
      />
    )
  }
  const { id, actionable: _actionable, failure, ...frame } = view
  return (
    <>
      {failure && <StateNotice kind="error" title="Your answer was not sent" body={failure} />}
      <Question {...frame} claimFocus={claimFocus} onAnswer={(answer) => onAnswer(id, answer)} />
    </>
  )
}

function ApprovalCard({
  view,
  handlers,
  claimFocus,
}: {
  view: ApprovalView
  handlers: NeedHandlers
  claimFocus: boolean
}) {
  const { openInspector } = useShellActions()
  const { id, canApprove, actionable, hold, retryEvidence, ...frame } = view
  const open = view.status.state === 'open'
  if (open && !actionable) {
    return (
      <StateNotice
        kind="blocked"
        title={view.title}
        body="This belongs to work with no repository, so it can be read here and not settled."
      />
    )
  }
  if (open && !canApprove) {
    return (
      <div className="decision-missing">
        <StateNotice
          kind="blocked"
          title={view.title}
          body="Its evidence has not loaded, so it cannot be approved yet."
          action={{ label: 'Retry', onClick: () => handlers.onRetryEvidence(id) }}
        />
        <Button variant="quiet" onClick={() => handlers.onDeny(id)}>
          {view.denyLabel}
        </Button>
      </div>
    )
  }
  return (
    <>
      {hold && <StateNotice kind="blocked" title="Still open" body={hold} />}
      <Approval
        {...frame}
        claimFocus={claimFocus}
        inspectLabel="Inspect checks and diff"
        onInspect={() => {
          handlers.onInspect(id)
          openInspector('checks')
        }}
        onConfirm={() => handlers.onApprove(id)}
        onDeny={() => handlers.onDeny(id)}
      />
      {retryEvidence && (
        <Button variant="text" onClick={() => handlers.onRetryEvidence(id)}>
          Retry
        </Button>
      )}
    </>
  )
}

function WorkNeed({ view, onOpen }: { view: WorkNeedView; onOpen: NeedHandlers['onOpenWork'] }) {
  return (
    <StateNotice
      kind="blocked"
      title={view.title}
      body={
        view.actionable
          ? `${view.body} In ${view.repository}.`
          : `${view.body} This work has no repository, so it can be read here and not acted on.`
      }
      {...(view.actionable && {
        action: { label: 'Open this delivery', onClick: () => onOpen(view.workItemId) },
      })}
    />
  )
}

function Card({
  card,
  handlers,
  claimFocus,
}: {
  card: NeedCard
  handlers: NeedHandlers
  claimFocus: boolean
}) {
  if (card.kind === 'work') return <WorkNeed view={card.view} onOpen={handlers.onOpenWork} />
  return card.kind === 'question' ? (
    <QuestionCard view={card.view} onAnswer={handlers.onAnswer} claimFocus={claimFocus} />
  ) : (
    <ApprovalCard view={card.view} handlers={handlers} claimFocus={claimFocus} />
  )
}

export interface NeedsViewProps extends NeedHandlers {
  surface: SurfaceState
  waiting: readonly NeedCard[]
  settled: readonly NeedCard[]
  repoOptions: readonly RepoFilterOption[]
  repoValue: string
  onRepo: (option: RepoFilterOption) => void
  onRetry: () => void
  /** Set when the list stops short of what the server holds, so its count is unknown. */
  partialNote?: string | null
}

export function NeedsView(props: NeedsViewProps) {
  const { surface, waiting, settled, onRetry, partialNote: _partialNote, ...rest } = props
  /** The last card acted on. Moving under Settled remounts it, so it asks for focus back. */
  const [acted, setActed] = useState<string | null>(null)
  const handlers: NeedHandlers = {
    ...rest,
    onAnswer: (id, answer) => {
      setActed(id)
      rest.onAnswer(id, answer)
    },
    onApprove: (id) => {
      setActed(id)
      rest.onApprove(id)
    },
    onDeny: (id) => {
      setActed(id)
      rest.onDeny(id)
    },
  }
  return (
    <div className="page">
      <PageHeader title="Needs you" action={<GlossaryButton />} />
      <RepoScope options={props.repoOptions} value={props.repoValue} onChange={props.onRepo} />
      {/* A healthy empty state takes no space: only a failure or a list is worth saying. */}
      {surface.state !== 'empty' && <ReadNotice surface={surface} noun="what needs you" onRetry={onRetry} />}
      {props.partialNote && <p className="freshness">{props.partialNote}</p>}
      {waiting.map((card) => (
        <Card key={card.view.id} card={card} handlers={handlers} claimFocus={card.view.id === acted} />
      ))}
      {settled.length > 0 && (
        <section aria-label="Settled">
          <h2 className="needs-settled">Settled</h2>
          {settled.map((card) => (
            <Card key={card.view.id} card={card} handlers={handlers} claimFocus={card.view.id === acted} />
          ))}
        </section>
      )}
    </div>
  )
}
