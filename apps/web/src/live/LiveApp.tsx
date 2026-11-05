import { type ReactNode, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { api, type ChatMessage, HttpError, newIdempotencyKey, type WorkItem } from '../api'
import type { Address } from '../next/address'
import { PageHeader } from '../next/Conversation'
import { NextApp } from '../next/NextApp'
import { ROUTE_LABELS } from '../next/routes'
import type { RepositoryOption } from '../next/Sidebar'
import { StateNotice } from '../next/states'
import { useTheme } from '../next/theme'
import { repositoryName } from '../repo-target'
import { createDrafts, type Intent, resolveIntent } from './drafts'
import { createSubmissions, draftScope, type Frozen, type Submission } from './submission'
import {
  ConversationSurface,
  isOpenWork,
  Loading,
  NoRepositories,
  ReadFailed,
  RepositoryChoices,
  WorkSurface,
  workScope,
  workTitle,
} from './surfaces'
import {
  createWorkspace,
  liveClient,
  loading,
  resolveRepository,
  UNASSIGNED,
  useAddress,
  useWorkspaceUpkeep,
} from './workspace'

const RECENT_LIMIT = 5

/** One set per page, outside React's render, so a double Enter meets the same guard. */
function createLive() {
  const workspace = createWorkspace(liveClient)
  const drafts = createDrafts(() => window.localStorage)
  const send = async (frozen: Frozen) => {
    const { key, text, ...target } = frozen
    await api.sendChat(text, target, key)
    workspace.refresh()
  }
  const submissions = createSubmissions({ drafts, newKey: newIdempotencyKey, send })

  let version = 0
  const watchers = new Set<() => void>()
  const bump = () => {
    version += 1
    for (const watcher of watchers) watcher()
  }
  submissions.subscribe(bump)
  return {
    workspace,
    drafts,
    submissions,
    bump,
    subscribe(watcher: () => void) {
      watchers.add(watcher)
      return () => {
        watchers.delete(watcher)
      }
    },
    version: () => version,
  }
}

function failureText(submission: Submission): string {
  const { error } = submission
  if (error instanceof HttpError) {
    return `The workbench refused this message${error.reason ? ` (${error.reason})` : ''}. It is kept here.`
  }
  return 'This may not have been sent. Retry cannot send it twice.'
}

const toOption = (repo: { id: string; url: string }): RepositoryOption => ({
  id: repo.id,
  name: repositoryName(repo.url),
  detail: repo.url,
})

export function LiveApp() {
  const [theme, setTheme] = useTheme()
  const [address, go] = useAddress()
  const [live] = useState(createLive)
  const { workspace, drafts, submissions, bump } = live
  const state = useSyncExternalStore(workspace.subscribe, workspace.getState)
  useSyncExternalStore(live.subscribe, live.version)
  useWorkspaceUpkeep(workspace)

  const [notice, setNotice] = useState<string | null>(null)
  const repositoriesReady = state.repositories.status === 'ready'
  const repositories = state.repositories.rows
  const resolved = repositoriesReady
    ? resolveRepository({
        addressed: address.repoId,
        stored: drafts.activeRepo(),
        repositories,
        unassigned: state.unassigned,
      })
    : { id: null, notice: null }
  const activeId = resolved.id
  const readOnly = activeId === UNASSIGNED
  const repoId = activeId !== null && !readOnly ? activeId : null

  useEffect(() => {
    if (repositoriesReady) workspace.setScope(activeId)
  }, [activeId, repositoriesReady, workspace])

  // A lost repository is said once and forgotten, so the choice that replaces it can stand.
  useEffect(() => {
    if (resolved.notice === null) return
    setNotice(resolved.notice)
    drafts.setActiveRepo(null)
  }, [resolved.notice, drafts])

  useEffect(() => {
    if (repoId !== null) drafts.setActiveRepo(repoId)
  }, [repoId, drafts])

  const inScope = state.scope === activeId
  const chat = inScope ? state.chat : loading<ChatMessage>()
  const work = inScope ? state.work : loading<WorkItem>()
  const activeRepository = repositories.find((repo) => repo.id === repoId)
  const repoName = activeRepository ? repositoryName(activeRepository.url) : null
  const subtitle = readOnly
    ? 'Unassigned history, read-only'
    : repoName === null
      ? 'No repository chosen'
      : `Meta agent, working in ${repoName}`

  const switchRepository = useCallback(
    (id: string) => {
      setNotice(null)
      go({ route: address.route, repoId: id, workId: null, taskId: null })
    },
    [address.route, go],
  )

  const navigate = useCallback(
    (route: Address['route']) => {
      setNotice(null)
      go({ route, repoId: activeId, workId: null, taskId: null })
    },
    [activeId, go],
  )

  const stored: Intent = repoId === null ? { kind: 'new' } : drafts.intent(repoId)
  const intent = resolveIntent(stored, work.status === 'loading' ? null : work.rows)
  const scope = intent.kind === 'new' ? 'new' : `work:${intent.workId}`

  const setIntent = useCallback(
    (next: Intent) => {
      if (repoId === null) return
      drafts.setIntent(repoId, next)
      bump()
    },
    [bump, drafts, repoId],
  )

  const followUp = useCallback(
    (workId: string) => {
      setIntent({ kind: 'follow_up', workId })
      navigate('chat')
    },
    [navigate, setIntent],
  )

  const previous =
    stored.kind === 'new' ? work.rows.find((row) => row.id === stored.previous && isOpenWork(row)) : undefined
  const intentToggle =
    intent.kind === 'follow_up'
      ? { label: 'New request', onToggle: () => setIntent({ kind: 'new', previous: intent.workId }) }
      : previous
        ? {
            label: `Follow up on ${workTitle(previous)}`,
            onToggle: () => setIntent({ kind: 'follow_up', workId: previous.id }),
          }
        : undefined

  const unavailable = repoId
    ? undefined
    : readOnly
      ? 'Unassigned history is read-only. Choose a repository to send.'
      : repositoriesReady && repositories.length === 0
        ? 'Add a repository in Setup to send.'
        : 'Choose a repository to send.'

  const submission = repoId === null ? null : submissions.view(repoId)
  const value = repoId === null ? '' : drafts.read(repoId, scope)
  const sending = submission?.state === 'pending'
  const target = useMemo(() => {
    if (repoId === null) return null
    if (intent.kind === 'new') return { repoId, intent: 'new' as const }
    return { repoId, intent: 'follow_up' as const, referencesWorkItem: intent.workId }
  }, [intent, repoId])

  const composer = {
    scope:
      intent.kind === 'follow_up'
        ? `Following up on ${intent.title}`
        : `New request in ${repoName ?? 'no repository'}`,
    value,
    onChange: (text: string) => {
      if (repoId === null) return
      drafts.write(repoId, scope, text)
      bump()
    },
    onSubmit: () => {
      if (target !== null) submissions.submit(target, value)
    },
    ...(intentToggle && { intentToggle }),
    ...(unavailable !== undefined && { unavailable }),
    sending,
    ...(repoId !== null &&
      drafts.heldInMemory(repoId, draftScope(target ?? {})) && {
        note: 'This looks like a key, so it stays in this tab and is not saved. Add keys in Connections.',
      }),
    ...(submission?.state === 'failed' &&
      repoId !== null && {
        failure: { text: failureText(submission), onRetry: () => void submissions.retry(repoId) },
      }),
  }

  const selected = work.rows.find((row) => row.id === address.workId)
  const openWork = (workId: string) => go({ route: 'work', repoId: activeId, workId, taskId: null })

  const commands = [
    ...(repoId !== null && intent.kind === 'follow_up'
      ? [
          {
            id: 'new-request',
            label: 'New request',
            run: () => setIntent({ kind: 'new', previous: intent.workId }),
          },
        ]
      : []),
    ...repositories
      .filter((repo) => repo.id !== repoId)
      .map((repo) => ({
        id: `repo-${repo.id}`,
        label: `Switch to ${repositoryName(repo.url)}`,
        run: () => switchRepository(repo.id),
      })),
    {
      id: 'return-classic',
      label: 'Return to the classic workbench',
      run: () => window.location.assign(`?ui=classic${window.location.hash}`),
    },
  ]

  const retryRead = () => workspace.refresh()
  const surface = () => {
    if (address.route !== 'chat' && address.route !== 'work') return undefined
    const framed = (content: ReactNode) => (
      <div className={address.route === 'chat' ? 'conversation' : 'page'}>
        <PageHeader title={ROUTE_LABELS[address.route]} />
        {content}
      </div>
    )
    if (state.repositories.status === 'loading') return framed(<Loading title="Loading your repositories" />)
    if (activeId === null) {
      if (state.repositories.status === 'error') {
        return framed(<ReadFailed title="Could not load your repositories" onRetry={retryRead} />)
      }
      if (repositories.length === 0) return framed(<NoRepositories />)
      return framed(<RepositoryChoices repositories={repositories} onChoose={switchRepository} />)
    }
    if (address.route === 'work') {
      return (
        <WorkSurface
          subtitle={subtitle}
          work={work}
          selectedId={address.workId}
          onSelect={openWork}
          onFollowUp={followUp}
          onRetry={retryRead}
          readOnly={readOnly}
        />
      )
    }
    return (
      <ConversationSurface
        subtitle={subtitle}
        chat={chat}
        work={work.rows}
        submission={submission}
        onRetry={retryRead}
        readOnly={readOnly}
      />
    )
  }

  const body = surface()
  const lostRepository = notice && (
    <div className="live-notice">
      <StateNotice kind="blocked" title="Repository not found" body={notice} />
    </div>
  )
  const page =
    body === undefined ? undefined : (
      <>
        {lostRepository}
        {body}
      </>
    )

  return (
    <NextApp
      route={address.route}
      onNavigate={navigate}
      theme={theme}
      onTheme={setTheme}
      repositories={repositories.map(toOption)}
      repositoryId={repoId}
      onSwitchRepository={switchRepository}
      // §18: a count must equal the list it links to, and Needs you is not connected here.
      needsCount={null}
      {...(state.unassigned && {
        unassigned: {
          current: readOnly,
          onOpen: () => go({ route: 'chat', repoId: UNASSIGNED, workId: null, taskId: null }),
        },
      })}
      recent={work.rows.slice(0, RECENT_LIMIT).map((row) => ({
        id: row.id,
        title: workTitle(row),
        current: row.id === address.workId,
      }))}
      onOpenRecent={openWork}
      footnote="Conversation and Work are live"
      taskInspector={selected ? workScope(selected, subtitle) : null}
      composer={address.route === 'chat' ? composer : null}
      commands={commands}
    >
      {page}
    </NextApp>
  )
}
