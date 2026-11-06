import { useEffect } from 'react'
import type { RepositoryEntry, WorkItem } from '../api'
import { ChevronIcon } from '../next/primitives'
import { useShellActions } from '../next/Shell'
import { EmptyState, StateNotice } from '../next/states'
import { repositoryName } from '../repo-target'

/** The states around the live surfaces: a repository to choose, or one that could not be read. */

export const isOpenWork = (row: WorkItem): boolean => row.state !== 'done' && row.state !== 'stopped'

export const workTitle = (row: WorkItem): string => row.title ?? 'Untitled work'

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

/** Opens the inspector for a task reached from outside the page, such as a search result. */
export function InspectorRequest({ request, onDone }: { request: boolean; onDone: () => void }) {
  const { openInspector } = useShellActions()
  useEffect(() => {
    if (!request) return
    openInspector()
    onDone()
  }, [request, onDone, openInspector])
  return null
}

export function NoRepositories() {
  return (
    <EmptyState
      title="Add a repository to begin"
      body="Conversations and work belong to a repository. Setup registers the first one."
    >
      <a className="btn btn-default" href="#setup">
        Open Setup
      </a>
    </EmptyState>
  )
}
