import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { api, type ChatMessage, HttpError, newIdempotencyKey, type WorkItem } from '../api'
import type { Address } from '../next/address'
import { PageHeader } from '../next/Conversation'
import { ConversationView } from '../next/ConversationView'
import type { NeedItem } from '../next/inspection-wire'
import { NeedsView } from '../next/NeedsView'
import { NextApp } from '../next/NextApp'
import { ParkedNotices } from '../next/ParkedNotice'
import { CONFIGURATION_ROUTES, ROUTE_LABELS } from '../next/routes'
import { SearchSheet } from '../next/SearchSheet'
import type { RepositoryOption } from '../next/Sidebar'
import { StateNotice } from '../next/states'
import { useTheme } from '../next/theme'
import { WorkView } from '../next/WorkView'
import {
  approvalScope,
  attemptSubscription,
  conversationView,
  type DiscussAction,
  deliveryDetail,
  filterValue,
  focusTask,
  inFilter,
  mapRead,
  needCard,
  needsCount,
  needsList,
  type RepoFilter,
  type RepoFilterOption,
  readData,
  readSurface,
  readsCurrent,
  repoFilterOptions,
  type SearchRowView,
  searchRows,
  searchTarget,
  selectionInScope,
  type TaskEvidence,
  taskInspector,
  threadQuestions,
  usableEvidence,
  workGroups,
  workRowView,
} from '../next/work-model'
import { repositoryName } from '../repo-target'
import { createConfigStore } from './config-store'
import { createDrafts, type Intent, resolveIntent } from './drafts'
import { createInspection, liveInspectionClient } from './inspection'
import { switchWork, useParked } from './parked'
import { usePause } from './pause'
import { createSubmissions, draftScope, type Frozen, type Submission } from './submission'
import {
  InspectorRequest,
  isOpenWork,
  Loading,
  NoRepositories,
  ReadFailed,
  RepositoryChoices,
  workTitle,
} from './surfaces'
import {
  createWorkspace,
  liveClient,
  loading,
  resolveActive,
  chatRead as threadRead,
  UNASSIGNED,
  useAddress,
  useWorkspaceUpkeep,
} from './workspace'

const RECENT_LIMIT = 5

const WORK_CUT = 'The server holds more deliveries than this page reads. Search still finds them.'
const NEEDS_CUT = 'More is waiting than this page reads, so there is no count.'

/** Its own chunk: only these three routes need the configuration calls. */
const ConfigSurface = lazy(() => import('./config').then((module) => ({ default: module.ConfigSurface })))

/** One set per page, outside React's render, so a double Enter meets the same guard. */
function createLive() {
  const workspace = createWorkspace(liveClient)
  const inspection = createInspection(liveInspectionClient)
  workspace.onRefresh(inspection.refresh)
  workspace.onInvalidate(inspection.invalidate)
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
    inspection,
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
    return `The workbench refused this message${error.reason ? ` (${error.reason})` : ''}. It is kept here. Retry sends the original text.`
  }
  return 'This may not have been sent. Retry sends the original text and cannot send it twice.'
}

const cardIds = (item: NeedItem): string[] => (item.kind === 'card' ? [item.id] : [])

const toOption = (repo: { id: string; url: string }): RepositoryOption => ({
  id: repo.id,
  name: repositoryName(repo.url),
  detail: repo.url,
})

export function LiveApp() {
  const [theme, setTheme] = useTheme()
  const [address, go] = useAddress()
  const [live] = useState(createLive)
  const { workspace, inspection, drafts, submissions, bump } = live
  const state = useSyncExternalStore(workspace.subscribe, workspace.getState)
  const inspected = useSyncExternalStore(inspection.subscribe, inspection.getState)
  useSyncExternalStore(live.subscribe, live.version)
  useWorkspaceUpkeep(workspace)
  const [configStore] = useState(createConfigStore)
  const pause = usePause()
  const parked = useParked(address.route === 'work')

  const [notice, setNotice] = useState<string | null>(null)
  /** Work and Needs you start on every repository: the first question is whether anything needs you. */
  const [filter, setFilter] = useState<RepoFilter>({ kind: 'all' })
  const [conversationTaskId, setConversationTaskId] = useState<string | null>(null)
  const [cardId, setCardId] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [foundMessageId, setFoundMessageId] = useState<string | null>(null)
  const [inspectorRequest, setInspectorRequest] = useState(false)
  const clearInspectorRequest = useCallback(() => setInspectorRequest(false), [])
  const repositoriesReady = state.repositories.status === 'ready'
  const repositories = state.repositories.rows
  const resolved = resolveActive({
    addressed: address.repoId,
    stored: drafts.activeRepo(),
    repositories: state.repositories,
    unassigned: state.unassigned,
  })
  const activeId = resolved.id
  const readOnly = activeId === UNASSIGNED
  const repoId = activeId !== null && !readOnly ? activeId : null

  useEffect(() => {
    if (repositoriesReady || activeId !== null) workspace.setScope(activeId)
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

  // Moving between repositories moves the filter with it. The first answer of a reload does not.
  const previousActive = useRef(activeId)
  useEffect(() => {
    const previous = previousActive.current
    previousActive.current = activeId
    if (previous === null || activeId === null || previous === activeId) return
    setFilter(activeId === UNASSIGNED ? { kind: 'unassigned' } : { kind: 'repo', repoId: activeId })
    setConversationTaskId(null)
    setCardId(null)
    setFoundMessageId(null)
  }, [activeId])

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
      setFoundMessageId(null)
      inspection.clearNotice()
      workspace.clearReset()
      go({ route, repoId: activeId, workId: null, taskId: null })
    },
    [activeId, go, inspection, workspace],
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

  /** The item's own repository, whatever is selected or filtered. The composer then names it. */
  const discuss = useCallback(
    ({ repoId: owner, workItemId }: DiscussAction) => {
      drafts.setIntent(owner, { kind: 'follow_up', workId: workItemId })
      bump()
      setNotice(null)
      go({ route: 'chat', repoId: owner, workId: null, taskId: null })
    },
    [bump, drafts, go],
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

  const rows = readData(inspected.work)?.items ?? []
  const items = readData(inspected.needs)?.items ?? []
  const groups = workGroups(rows, filter)
  const needs = needsList(inspected.needs, rows, filter)
  const registered = Object.entries(state.labels).map(([id, label]) => ({ id, label }))
  const repoOptions = repoFilterOptions(rows, items, registered)
  const chooseFilter = (option: RepoFilterOption) => setFilter(option.filter)

  const listed = groups.flatMap((group) => group.rows.map((row) => row.id))
  const addressedWork = address.route === 'work' ? address.workId : null
  const selectedWorkId =
    readData(inspected.work) === null ? addressedWork : selectionInScope(addressedWork, listed)

  // Conversation follows one delivery: the one being followed up, else the newest still open here.
  const followedId = intent.kind === 'follow_up' ? intent.workId : null
  const conversationRow =
    repoId === null
      ? null
      : (rows.find((row) => row.id === followedId) ??
        rows.findLast((row) => row.repoId === repoId && workRowView(row).outcome === null) ??
        null)

  const onChat = address.route === 'chat'
  const deliveryId = onChat ? (conversationRow?.id ?? null) : selectedWorkId
  const taskId = onChat ? conversationTaskId : selectedWorkId === null ? null : address.taskId
  useEffect(() => inspection.selectWork(deliveryId), [deliveryId, inspection])
  useEffect(() => inspection.selectTask(taskId), [taskId, inspection])

  /** With no active repository a row supplies the address, because a hash needs one to hold a selection. */
  const workRepo = (workId: string | null) => {
    if (activeId !== null || workId === null) return activeId
    const owner = rows.find((row) => row.id === workId)
    return owner === undefined ? null : (owner.repoId ?? UNASSIGNED)
  }
  const openWork = (workId: string | null) => {
    inspection.clearNotice()
    go({ route: 'work', repoId: workRepo(workId), workId, taskId: null })
  }
  const openTask = (id: string) =>
    go({ route: 'work', repoId: workRepo(selectedWorkId), workId: selectedWorkId, taskId: id })

  const deliveryRead =
    inspected.delivery.id === deliveryId ? inspected.delivery.read : ({ status: 'loading' } as const)
  const deliveryData = readData(deliveryRead)
  const delivery = mapRead(deliveryRead, (detail) => deliveryDetail(detail, filter))

  const ownerRow = rows.find((row) => row.id === deliveryId)
  const ownerTitle = ownerRow ? workRowView(ownerRow).title : 'This delivery'
  const taskEvidence: TaskEvidence = {
    attemptId: inspected.activity.attemptId,
    activity: inspected.activity.read,
    artifact: inspected.artifact,
    onAttempt: inspection.selectAttempt,
    onMore: inspection.moreActivity,
    onRetry: inspection.retryActivity,
    onArtifact: inspection.openArtifact,
    onArtifactMore: inspection.moreArtifact,
    onArtifactRetry: inspection.retryArtifact,
  }
  const taskView =
    taskId !== null && deliveryId !== null && inspected.task.id === taskId
      ? taskInspector(taskId, inspected.task.read, deliveryId, ownerTitle, taskEvidence)
      : null

  // Each delivery read, not each cursor: a reset drops the attempt until a new read brings one.
  const attemptFeed = attemptSubscription(inspected.activity.attemptId, deliveryData?.cursors ?? {})
  const attemptStream = attemptFeed?.stream ?? null
  const attemptAfter = attemptFeed?.after ?? 0
  const deliveryReadAt = deliveryRead.status === 'loading' ? null : deliveryRead.readAt
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliveryReadAt is the trigger
  useEffect(() => {
    workspace.followAttempt(attemptStream === null ? null : { stream: attemptStream, after: attemptAfter })
  }, [attemptStream, attemptAfter, deliveryReadAt, workspace])

  const card = (item: (typeof items)[number]) =>
    needCard(
      item,
      (id) => inspected.evidence[id] ?? null,
      (id) => inspected.outcomes[id] ?? null,
      (id) => inspected.answers[id] ?? null,
    )
  // Evidence for what is on show: a reload has none of it, and Work and Conversation need none.
  const settledCards = address.route === 'needs' ? needs.settled.flatMap(cardIds) : []
  const settledKey = settledCards.join(',')
  useEffect(() => {
    if (settledKey !== '') void inspection.readSettledEvidence(settledKey.split(','))
  }, [settledKey, inspection])

  const chosenCard = [...needs.waiting, ...needs.settled].find((item) => item.id === cardId)
  const chosenEvidence = chosenCard ? usableEvidence(inspected.evidence[chosenCard.id] ?? null) : null
  const approvalInspector =
    chosenCard?.kind === 'card' && chosenEvidence ? approvalScope(chosenCard, chosenEvidence) : null

  const chatQuestions = threadQuestions(items, repoId, (id) => inspected.answers[id] ?? null)

  const chatRead = threadRead(chat, state.repositories)
  // "Current" is a claim about now, so a later failure withdraws it for good.
  const current = readsCurrent([chatRead, inspected.work, inspected.needs])
  useEffect(() => {
    if (!current) workspace.clearReset()
  }, [current, workspace])

  const conversation = conversationView({
    row: conversationRow,
    detail: onChat ? deliveryData : null,
    messages: readData(chatRead) ?? [],
    work: rows,
  })

  /** The served label, which is what a search hit carries. Empty when no repository is active. */
  const activeLabel =
    repoId === null
      ? readOnly
        ? null
        : ''
      : (state.labels[repoId] ?? rows.find((row) => row.repoId === repoId)?.repoLabel ?? null)

  const chooseResult = ({ hit }: SearchRowView) => {
    const target = searchTarget(hit, activeLabel)
    const owner = rows.find((row) => row.id === target.workItemId)
    if (owner !== undefined && !inFilter(owner, filter)) setFilter({ kind: 'all' })
    setSearching(false)
    if (target.route === 'chat') {
      navigate('chat')
      setFoundMessageId(hit.id)
      return
    }
    const workId = target.workItemId
    go({ route: 'work', repoId: workRepo(workId), workId, taskId: target.taskId })
    if (target.taskId !== null) setInspectorRequest(true)
  }

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
    { id: 'search', label: 'Search', run: () => setSearching(true) },
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
    if (CONFIGURATION_ROUTES.includes(address.route)) {
      return (
        <Suspense fallback={<Loading title={`Loading ${ROUTE_LABELS[address.route]}`} />}>
          <ConfigSurface
            route={address.route}
            store={configStore}
            onNavigate={navigate}
            onRepositories={retryRead}
          />
        </Suspense>
      )
    }
    const nothingAnywhere =
      repositoriesReady && repositories.length === 0 && rows.length === 0 && items.length === 0
    if ((address.route === 'work' || address.route === 'needs') && nothingAnywhere) {
      return (
        <div className="page">
          <PageHeader title={ROUTE_LABELS[address.route]} />
          <NoRepositories />
        </div>
      )
    }
    if (address.route === 'work') {
      return (
        <WorkView
          surface={readSurface(inspected.work, () => groups.every((group) => group.count === 0))}
          groups={groups}
          repoOptions={repoOptions}
          repoValue={filterValue(filter)}
          onRepo={chooseFilter}
          selectedId={selectedWorkId}
          onSelect={openWork}
          delivery={delivery}
          selectedTaskId={taskId}
          onOpenTask={openTask}
          onAction={inspection.act}
          onDiscuss={discuss}
          onRetry={retryRead}
          partialNote={readData(inspected.work)?.nextCursor == null ? null : WORK_CUT}
          parkedNotice={(workItemId) => (
            <ParkedNotices
              rows={parked.rows.filter((row) => row.workItemId === workItemId)}
              all={parked.rows}
              connections={parked.connections}
              capabilities={parked.capabilities}
              commands={{
                switchWork: (row, target) => switchWork(row, target).finally(parked.refresh),
                signIn: () => navigate('slots'),
              }}
            />
          )}
        />
      )
    }
    if (address.route === 'needs') {
      return (
        <NeedsView
          surface={readSurface(inspected.needs, () => needs.waiting.length + needs.settled.length === 0)}
          waiting={needs.waiting.map(card)}
          settled={needs.settled.map(card)}
          repoOptions={repoOptions}
          repoValue={filterValue(filter)}
          onRepo={chooseFilter}
          onAnswer={inspection.answer}
          onApprove={(id) => inspection.settle(id, 'approve')}
          onDeny={(id) => inspection.settle(id, 'deny')}
          onInspect={(id) => {
            setCardId(id)
            void inspection.readEvidence(id)
          }}
          onRetryEvidence={(id) => void inspection.readEvidence(id)}
          onRetry={retryRead}
          partialNote={needs.partial ? NEEDS_CUT : null}
        />
      )
    }
    if (address.route !== 'chat') return undefined
    const framed = (content: ReactNode) => (
      <div className="conversation">
        <PageHeader title={ROUTE_LABELS.chat} />
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
    return (
      <ConversationView
        surface={readSurface(chatRead, () => conversation.entries.length === 0 && conversation.plan === null)}
        subtitle={subtitle}
        view={conversation}
        questions={chatQuestions}
        selectedTaskId={taskId}
        onOpenTask={setConversationTaskId}
        onInspect={() => setConversationTaskId(deliveryData ? focusTask(deliveryData) : null)}
        onDiscuss={() => {
          if (conversation.discuss) discuss(conversation.discuss)
        }}
        onAnswer={inspection.answer}
        onRetry={retryRead}
        sending={submission?.state === 'pending' ? submission.frozen.text : null}
        readOnly={readOnly}
        foundId={foundMessageId}
        follow
      />
    )
  }

  const body = surface()
  const lostRepository = notice && (
    <div className="live-notice">
      <StateNotice kind="blocked" title="Repository not found" body={notice} />
    </div>
  )
  const commandNotice = inspected.notice && (
    <div className="live-notice">
      <StateNotice
        kind={inspected.notice.kind === 'done' ? 'completed' : 'error'}
        title={inspected.notice.kind === 'done' ? 'Done' : 'That did not go through'}
        body={inspected.notice.text}
      />
    </div>
  )
  const resetNotice = state.resetAt && (
    <div className="live-notice">
      <StateNotice
        kind="resolved"
        title="Read again from the start"
        body="The event history moved on, so this page took a new snapshot. What is shown is current."
      />
    </div>
  )
  const page =
    body === undefined ? undefined : (
      <>
        {lostRepository}
        {commandNotice}
        {resetNotice}
        <InspectorRequest request={inspectorRequest} onDone={clearInspectorRequest} />
        {body}
      </>
    )

  return (
    <>
      <NextApp
        route={address.route}
        onNavigate={navigate}
        theme={theme}
        onTheme={setTheme}
        repositories={repositories.map(toOption)}
        repositoryId={repoId}
        onSwitchRepository={switchRepository}
        // §18: a count must equal the list it links to, so it is that list's own, filter included.
        needsCount={needsCount(needs)}
        pause={pause}
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
        footnote="Local workspace"
        taskInspector={taskView}
        approvalInspector={approvalInspector}
        initialInspectorOpen={address.taskId !== null}
        composer={address.route === 'chat' ? composer : null}
        commands={commands}
        search={{ onOpen: () => setSearching(true) }}
      >
        {page}
      </NextApp>
      {searching && (
        <SearchSheet
          query={inspected.query}
          onQuery={inspection.setQuery}
          surface={readSurface(inspected.search, (found) => found.items.length === 0)}
          rows={searchRows(readData(inspected.search)?.items ?? [])}
          onChoose={chooseResult}
          onRetry={inspection.retrySearch}
          onClose={() => setSearching(false)}
        />
      )}
    </>
  )
}
