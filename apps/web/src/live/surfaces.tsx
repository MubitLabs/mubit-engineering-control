import { useEffect, useRef } from 'react'
import type { ChatMessage, RepositoryEntry, WorkItem } from '../api'
import {
  ActivityNote,
  AgentMessage,
  DeliveryPlan,
  PageHeader,
  type TaskProgress,
  UserMessage,
} from '../next/Conversation'
import type { InspectorScope } from '../next/Inspector'
import { Button, ChevronIcon } from '../next/primitives'
import { ROUTE_LABELS } from '../next/routes'
import { useShellActions } from '../next/Shell'
import { EmptyState, ReturnToClassic, StateNotice } from '../next/states'
import { repositoryName } from '../repo-target'
import type { Submission } from './submission'
import type { Feed } from './workspace'

/** The conversation and work surfaces: real rows through the next shell's components. */

const STATE_WORDS: Record<string, string> = {
  proposed: 'Proposed',
  admitted: 'Admitted',
  planning: 'Planning',
  executing: 'Working',
  integrating: 'Integrating',
  blocked: 'Blocked',
  done: 'Done',
  stopped: 'Stopped',
}

const stateWord = (state: string): string => STATE_WORDS[state] ?? state.replaceAll('_', ' ')

const PROGRESS: Record<string, TaskProgress> = {
  blocked: 'blocked',
  done: 'done',
  stopped: 'failed',
  executing: 'running',
  integrating: 'running',
}

export const isOpenWork = (row: WorkItem): boolean => row.state !== 'done' && row.state !== 'stopped'

export const workTitle = (row: WorkItem): string => row.title ?? 'Untitled work'

function taskLine(row: WorkItem): string {
  const { total, byStatus } = row.taskCounts
  if (total === 0) return 'No tasks yet'
  const parts = Object.entries(byStatus).map(([status, count]) => `${count} ${status.replaceAll('_', ' ')}`)
  return `${total} ${total === 1 ? 'task' : 'tasks'}: ${parts.join(', ')}`
}

/** §18: acknowledgements name work by id, and an id is not something the owner should read. */
function withTitles(text: string, work: readonly WorkItem[]): string {
  return work.reduce(
    (line, row) => (row.title === undefined ? line : line.replaceAll(row.id, row.title)),
    text,
  )
}

function MessageRow({ message, work }: { message: ChatMessage; work: readonly WorkItem[] }) {
  if (message.plan !== undefined) {
    const { plan } = message
    return (
      <DeliveryPlan
        title={plan.title}
        subtitle={plan.note ?? ''}
        stateLabel="Plan"
        footnote={plan.approvedNote ?? ''}
        tasks={plan.tasks.map((task) => ({
          id: task.id,
          title: task.task,
          detail: task.role,
          stateLabel: task.state,
          progress: 'waiting',
          selected: false,
          onOpen: () => {},
        }))}
      />
    )
  }
  if (message.kind === 'agent') return <AgentMessage>{withTitles(message.text, work)}</AgentMessage>
  if (message.kind === 'status' || message.kind === 'notice') {
    return <ActivityNote>{withTitles(message.text, work)}</ActivityNote>
  }
  return (
    <>
      <UserMessage>{message.text}</UserMessage>
      {message.ackText !== undefined && <AgentMessage>{withTitles(message.ackText, work)}</AgentMessage>}
      {message.secretGuard === true && (
        <ActivityNote>This looked like a key, so it was redacted before storage.</ActivityNote>
      )}
    </>
  )
}

export function Loading({ title }: { title: string }) {
  return <StateNotice kind="working" title={title} body="This takes a moment." />
}

export function ReadFailed({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <StateNotice
      kind="error"
      title={title}
      body="The workbench did not answer. Nothing here was changed."
      action={{ label: 'Retry', onClick: onRetry }}
    />
  )
}

export function RepositoryChoices({
  repositories,
  onChoose,
}: {
  repositories: readonly RepositoryEntry[]
  onChoose: (id: string) => void
}) {
  return (
    <div className="repo-choices">
      <EmptyState
        title="Choose a repository"
        body="Each repository keeps its own conversation, work and drafts."
      />
      <ul className="choices">
        {repositories.map((repo) => (
          <li key={repo.id}>
            <button type="button" className="choice" onClick={() => onChoose(repo.id)}>
              <span>
                {repositoryName(repo.url)}
                <small>{repo.url}</small>
              </span>
              <ChevronIcon />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function NoRepositories() {
  return (
    <EmptyState
      title="Add a repository to begin"
      body="Conversations and work belong to a repository. Setup registers the first one."
    >
      <a className="btn btn-default" href="?ui=classic#setup">
        Open Setup
      </a>
      <ReturnToClassic />
    </EmptyState>
  )
}

export function ConversationSurface({
  subtitle,
  chat,
  work,
  submission,
  onRetry,
  readOnly,
}: {
  subtitle: string
  chat: Feed<ChatMessage>
  work: readonly WorkItem[]
  submission: Submission | null
  onRetry: () => void
  readOnly: boolean
}) {
  const end = useRef<HTMLDivElement>(null)
  const newest = chat.rows.at(-1)?.id
  const sending = submission?.state === 'pending'
  useEffect(() => {
    if (newest !== undefined || sending) end.current?.scrollIntoView?.({ block: 'end' })
  }, [newest, sending])

  const empty = chat.status === 'ready' && chat.rows.length === 0 && !sending
  return (
    <div className="conversation">
      <PageHeader title={ROUTE_LABELS.chat} subtitle={subtitle} />
      {chat.status === 'loading' && <Loading title="Loading the conversation" />}
      {chat.status === 'error' && <ReadFailed title="Could not load the conversation" onRetry={onRetry} />}
      {empty && (
        <EmptyState
          title={readOnly ? 'Nothing here' : 'What would you like to work on?'}
          body={
            readOnly
              ? 'There is no conversation without a repository.'
              : 'Ask for an outcome and the meta agent plans it.'
          }
        />
      )}
      {chat.rows.map((message) => (
        <MessageRow key={message.id} message={message} work={work} />
      ))}
      {sending && (
        <>
          <UserMessage>{submission.frozen.text}</UserMessage>
          <ActivityNote>Sending</ActivityNote>
        </>
      )}
      <div ref={end} />
    </div>
  )
}

export function WorkSurface({
  subtitle,
  work,
  selectedId,
  onSelect,
  onFollowUp,
  onRetry,
  readOnly,
}: {
  subtitle: string
  work: Feed<WorkItem>
  selectedId: string | null
  onSelect: (id: string) => void
  onFollowUp: (id: string) => void
  onRetry: () => void
  readOnly: boolean
}) {
  const { openInspector } = useShellActions()
  return (
    <div className="page">
      <PageHeader title={ROUTE_LABELS.work} subtitle={subtitle} />
      {work.status === 'loading' && <Loading title="Loading work" />}
      {work.status === 'error' && <ReadFailed title="Could not load work" onRetry={onRetry} />}
      {work.status === 'ready' && work.rows.length === 0 && (
        <EmptyState
          title="No work yet"
          body={
            readOnly ? 'There is no work without a repository.' : 'A New request in Conversation starts it.'
          }
        />
      )}
      {work.rows.length > 0 && (
        <ul className="task-list">
          {work.rows.map((row) => {
            const selected = row.id === selectedId
            return (
              <li key={row.id}>
                <button
                  type="button"
                  className="task-row"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => {
                    onSelect(row.id)
                    openInspector()
                  }}
                >
                  <span
                    className={`task-indicator task-${PROGRESS[row.state] ?? 'waiting'}`}
                    role="img"
                    aria-label={stateWord(row.state)}
                  />
                  <span className="task-body">
                    <strong>{workTitle(row)}</strong>
                    <small>{taskLine(row)}</small>
                  </span>
                  <span className="task-state">{stateWord(row.state)}</span>
                  <ChevronIcon />
                </button>
                {selected && !readOnly && isOpenWork(row) && (
                  <div className="work-actions">
                    <Button onClick={() => onFollowUp(row.id)}>Follow up on this work</Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

const NOT_SHOWN =
  'Task and evidence detail is not shown here yet. The classic workbench has what exists today.'

/** Only what `/api/work` serves. The rest says so rather than looking empty. */
export function workScope(row: WorkItem, context: string): InspectorScope {
  return {
    id: row.id,
    kind: 'task',
    context,
    title: workTitle(row),
    overview: {
      sections: [
        { heading: 'Where it stands', body: stateWord(row.state) },
        { heading: 'Tasks', body: taskLine(row) },
      ],
      facts:
        row.updatedAt === '' ? [] : [{ label: 'Updated', value: new Date(row.updatedAt).toLocaleString() }],
    },
    checks: { state: 'unavailable', heading: 'Checks are not shown here yet', detail: NOT_SHOWN },
    activity: { note: NOT_SHOWN, entries: [] },
    diff: { summary: NOT_SHOWN, files: [] },
  }
}
