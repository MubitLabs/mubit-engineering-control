import { StrictMode, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  decodeCardEvidence,
  decodeChatLines,
  decodeNeedsPage,
  decodeSearchPage,
  decodeTaskDetail,
  decodeWorkDetail,
  decodeWorkPage,
} from '../../src/inspection-decode'
import { ConversationView } from '../../src/next/ConversationView'
import type { NeedItem, Page, WorkDetail, WorkRow } from '../../src/next/inspection-wire'
import { NeedsView } from '../../src/next/NeedsView'
import { SearchSheet } from '../../src/next/SearchSheet'
import { Shell } from '../../src/next/Shell'
import '../../src/next/styles'
import { useTheme } from '../../src/next/theme'
import {
  type AnswerOutcome,
  type ApprovalOutcome,
  approvalScope,
  conversationView,
  DENIED,
  deliveryDetail,
  filterValue,
  focusTask,
  needCard,
  needsCount,
  needsList,
  type QuestionView,
  type Read,
  type RepoFilter,
  type RepoFilterOption,
  readSurface,
  repoFilterOptions,
  type SearchRowView,
  searchRows,
  searchTarget,
  selectionInScope,
  taskScope,
  type WorkAction,
  workGroups,
  workRowView,
  metaStatus,
} from '../../src/next/work-model'
import { WorkView } from '../../src/next/WorkView'
import { describeApproval } from '../../src/release-cards'
import { useHashRoute } from '../../src/router'
import {
  cardEvidence,
  chatLines,
  emptyWorkPage,
  needsPage,
  searchPage,
  taskDetails,
  workDetails,
  workPage,
} from './inspection-fixtures'

/**
 * Fixture, then the real decoder, then work-model, then the real components, for
 * test/work.screens.playwright.ts. Vite serves it from the dev server only. The local state here
 * stands in for what Stage B binds, and `window.__effects` records each effect a click asked for.
 */

const params = new URLSearchParams(window.location.search)
const variant = params.get('state') ?? 'all'
const READ_AT = '2026-11-05T10:00:00.000Z'

declare global {
  interface Window {
    __effects?: string[]
  }
}

const effects: string[] = []
window.__effects = effects

function initialRead<T>(ready: T, empty: T): Read<T> {
  if (variant === 'empty') return { status: 'ready', data: empty, readAt: READ_AT }
  if (variant === 'failed') return { status: 'failed', message: 'Sample read failed', data: null, readAt: null }
  if (variant === 'error') {
    return { status: 'failed', message: 'Sample read failed', data: ready, readAt: READ_AT }
  }
  if (variant === 'loading') return { status: 'loading' }
  return { status: 'ready', data: ready, readAt: READ_AT }
}

const servedWork = decodeWorkPage(workPage)
const decodedWork =
  variant === 'delivery'
    ? {
        ...servedWork,
        items: servedWork.items.map((row) =>
          row.id === 'work_blocked'
            ? {
                ...row,
                stage: { key: 'person/blocked', label: 'Blocked', waitingOn: 'person' as const },
                reason: 'Blocked: SAMPLE-ONLY reason',
              }
            : row,
        ),
      }
    : servedWork
const blockedNeed: NeedItem = {
  kind: 'work',
  id: 'work_blocked',
  repoId: 'repo_a',
  repoLabel: 'sample-console',
  workItemId: 'work_blocked',
  title: 'SAMPLE-ONLY blocked delivery',
  stageKey: 'person/blocked',
  stageLabel: 'Blocked',
  reason: 'Blocked: SAMPLE-ONLY reason',
  nextAction: 'Resolve what blocks it',
  status: 'open',
  since: READ_AT,
  readOnly: false,
}
const servedNeeds = decodeNeedsPage(needsPage)
const decodedNeeds =
  variant === 'delivery' ? { ...servedNeeds, items: [blockedNeed, ...servedNeeds.items] } : servedNeeds
const decodedEmptyNeeds: Page<NeedItem> = { items: [], nextCursor: null, observedAt: READ_AT }
const hits = decodeSearchPage(searchPage).items
const lines = decodeChatLines(chatLines)

/** `state=delivery`: the surfaces delivery adds, on the same sample work. */
const DELIVERY_STATES: Record<string, Partial<WorkDetail['delivery']>> = {
  work_working: {
    stage: 'pr-ready',
    branch: 'mec/sample/integration',
    prNumber: 12,
    prUrl: 'https://github.com/sample/console/pull/12',
    repo: 'sample/console',
    ci: 'none-required',
    ciReadAt: READ_AT,
  },
  work_blocked: { failure: 'Combined checks failed on abc1230: SAMPLE-ONLY typecheck.' },
}

const workDetail = (id: string) => {
  const raw = workDetails[id as keyof typeof workDetails]
  if (!raw) return null
  const decoded = decodeWorkDetail(raw)
  if (variant !== 'delivery') return decoded
  return { ...decoded, delivery: { ...decoded.delivery, ...DELIVERY_STATES[id] } }
}
const taskDetail = (id: string) => {
  const raw = taskDetails[id as keyof typeof taskDetails]
  return raw ? decodeTaskDetail(raw) : null
}
const evidence = (id: string) => {
  const raw = cardEvidence[id as keyof typeof cardEvidence]
  return raw && variant !== 'no-evidence' ? decodeCardEvidence(raw) : null
}

const SAMPLE_REPOSITORIES = [
  { id: 'repo_a', name: 'sample-console', detail: '~/sample/console' },
  { id: 'repo_b', name: 'sample-billing', detail: '~/sample/billing' },
]

function HarnessApp() {
  const [route, navigate] = useHashRoute()
  const [theme, setTheme] = useTheme()
  const [repositoryId, setRepositoryId] = useState('repo_a')
  const [filter, setFilter] = useState<RepoFilter>({ kind: 'all' })
  const [work, setWork] = useState(() => initialRead(decodedWork, emptyWorkPage as Page<WorkRow>))
  const [need, setNeed] = useState(() => initialRead(decodedNeeds, decodedEmptyNeeds))
  const [selectedWork, setSelectedWork] = useState<string | null>(params.get('work'))
  const [selectedTask, setSelectedTask] = useState<string | null>(null)
  const [selectedCard, setSelectedCard] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<Record<string, ApprovalOutcome>>({})
  const [answers, setAnswers] = useState<Record<string, AnswerOutcome>>({})
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [following, setFollowing] = useState(false)

  const retry = () => {
    setWork({ status: 'ready', data: decodedWork, readAt: READ_AT })
    setNeed({ status: 'ready', data: decodedNeeds, readAt: READ_AT })
  }

  const rows = work.status === 'loading' ? [] : (work.data?.items ?? [])
  const items = need.status === 'loading' ? [] : (need.data?.items ?? [])
  const groups = workGroups(rows, filter)
  const visibleWork = groups.flatMap((group) => group.rows.map((row) => row.id))
  const list = needsList(need, rows, filter)
  const visibleCards = [...list.waiting, ...list.settled].map((item) => item.id)
  const options = repoFilterOptions(rows, items)

  const card = (item: NeedItem) =>
    needCard(
      item,
      evidence,
      (id) => outcomes[id] ?? null,
      (id) => answers[id] ?? null,
    )

  const workId = selectionInScope(selectedWork, visibleWork)
  const openWork = workId ? workDetail(workId) : null
  const task = selectedTask ? taskDetail(selectedTask) : null
  const taskInScope = task && selectionInScope(task.workItemId, visibleWork) ? task : null
  const taskOwner = rows.find((row) => row.id === taskInScope?.workItemId)
  const cardId = selectionInScope(selectedCard, visibleCards)
  const chosenCard = list.waiting.concat(list.settled).find((item) => item.id === cardId)
  const chosenEvidence = chosenCard ? evidence(chosenCard.id) : null

  const repository = SAMPLE_REPOSITORIES.find((entry) => entry.id === repositoryId)
  const chatRow = rows.find((row) => row.repoId === repositoryId && row.id === 'work_working') ?? null
  const chatDetail = chatRow ? workDetail(chatRow.id) : null
  const chat = conversationView({
    row: chatRow,
    detail: chatDetail,
    messages: chatRow ? lines : [],
    work: rows,
    repository: repository?.name ?? null,
    open: rows.filter(
      (row) =>
        row.repoId === repositoryId && row.id !== chatRow?.id && workRowView(row).outcome === null,
    ),
  })
  // The delivery screens are the ones that show a blocked notice; the rest keep their baselines.
  const chatView = variant === 'delivery' ? chat : { ...chat, blocked: [] }
  const meta = metaStatus(
    {
      status: 'ready',
      data: {
        observedAt: READ_AT,
        connection: { slotLabel: 'sample-slot', engine: 'claude', model: 'sample-large', modelAt: READ_AT },
        repositories: SAMPLE_REPOSITORIES.map(({ id }) => ({
          repoId: id,
          state: 'waiting_specialist',
          line: 'Waiting for implementer on sample-slot: SAMPLE-ONLY build the index',
          workItemId: null,
          running: false,
          at: READ_AT,
        })),
      },
      readAt: READ_AT,
    },
    repositoryId,
    false,
  )
  const chatQuestions = items
    .filter((item) => item.kind === 'question' && item.repoId === repositoryId)
    .map((item) => card(item).view as QuestionView)
    .filter((view) => view.status.state === 'open')

  const chooseFilter = (option: RepoFilterOption) => {
    setFilter(option.filter)
  }

  const act = (action: WorkAction) => {
    effects.push(`${action.kind} ${action.workItemId} ${action.repoId}`)
  }

  const approve = (id: string) => {
    effects.push(`approve ${id}`)
    const result =
      variant === 'hold' ? { status: 'pending', reason: 'ci_pending' } : { status: 'approved', pushed: true }
    setOutcomes((all) => ({ ...all, [id]: describeApproval(result) }))
  }

  const answer = (id: string, text: string) => {
    effects.push(`answer ${id}`)
    const outcome: AnswerOutcome =
      variant === 'conflict' ? { kind: 'already-answered' } : { kind: 'answered', answer: text }
    setAnswers((all) => ({ ...all, [id]: outcome }))
  }

  const results = useMemo(() => {
    const typed = query.trim().toLowerCase()
    return typed === '' ? [] : hits.filter((hit) => hit.title.toLowerCase().includes(typed))
  }, [query])

  const choose = (row: SearchRowView) => {
    const target = searchTarget(row.hit)
    setSelectedWork(target.workItemId)
    setSelectedTask(target.taskId)
    setSearching(false)
    navigate(target.route)
  }

  return (
    <Shell
      route={route}
      onNavigate={navigate}
      theme={theme}
      onTheme={setTheme}
      repositories={SAMPLE_REPOSITORIES}
      repositoryId={repositoryId}
      onSwitchRepository={(id) => {
        setRepositoryId(id)
        setFilter({ kind: 'repo', repoId: id })
      }}
      needsCount={needsCount(list)}
      recent={[]}
      onOpenRecent={() => {}}
      footnote="Local workspace"
      taskInspector={taskInScope && taskOwner ? taskScope(taskInScope, workRowView(taskOwner).title) : null}
      approvalInspector={
        chosenCard?.kind === 'card' && chosenEvidence ? approvalScope(chosenCard, chosenEvidence) : null
      }
      composer={{
        scope: following ? 'Following up on this delivery' : `New request in ${repository?.name}`,
        value: draft,
        onChange: setDraft,
        onSubmit: () => setDraft(''),
        intentToggle: {
          label: following ? 'New request' : 'Follow up',
          onToggle: () => setFollowing((value) => !value),
        },
      }}
      commands={[{ id: 'search', label: 'Search', run: () => setSearching(true) }]}
      search={{ onOpen: () => setSearching(true) }}
    >
      {route === 'chat' && (
        <ConversationView
          surface={readSurface(work, () => chat.entries.length === 0 && chat.plan === null)}
          subtitle={`Meta agent, working in ${repository?.name}`}
          view={chatView}
          questions={chatQuestions}
          selectedTaskId={taskInScope?.id ?? null}
          onOpenTask={setSelectedTask}
          onInspect={() => setSelectedTask(chatDetail ? focusTask(chatDetail) : null)}
          onDiscuss={() => setFollowing(true)}
          onOpenWork={(id) => {
            setSelectedWork(id)
            navigate('work')
          }}
          planWorkId={chatRow?.id ?? null}
          meta={meta}
          onAnswer={answer}
          onRetry={retry}
        />
      )}
      {route === 'work' && (
        <WorkView
          surface={readSurface(work, (page) => page.items.length === 0)}
          groups={groups}
          repoOptions={options}
          repoValue={filterValue(filter)}
          onRepo={chooseFilter}
          selectedId={workId}
          onSelect={setSelectedWork}
          delivery={
            openWork
              ? { status: 'ready', data: deliveryDetail(openWork, filter), readAt: READ_AT }
              : { status: 'failed', message: 'Sample detail failed', data: null, readAt: null }
          }
          selectedTaskId={taskInScope?.id ?? null}
          onOpenTask={setSelectedTask}
          onAction={act}
          onDiscuss={() => {
            setFollowing(true)
            navigate('chat')
          }}
          onRetry={retry}
        />
      )}
      {route === 'needs' && (
        <NeedsView
          surface={readSurface(need, (page) => page.items.length === 0)}
          waiting={list.waiting.map(card)}
          settled={list.settled.map(card)}
          repoOptions={options}
          repoValue={filterValue(filter)}
          onRepo={chooseFilter}
          onAnswer={answer}
          onApprove={approve}
          onDeny={(id) => {
            effects.push(`deny ${id}`)
            setOutcomes((all) => ({ ...all, [id]: DENIED }))
          }}
          onInspect={setSelectedCard}
          onAgreement={() => {}}
          onRetryEvidence={() => {}}
          onOpenWork={() => {}}
          onRetry={retry}
        />
      )}
      {searching && (
        <SearchSheet
          query={query}
          onQuery={setQuery}
          surface={readSurface<readonly unknown[]>(
            { status: 'ready', data: results, readAt: READ_AT },
            (found) => found.length === 0,
          )}
          rows={searchRows(results)}
          onChoose={choose}
          onRetry={() => {}}
          onClose={() => setSearching(false)}
        />
      )}
    </Shell>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('expected #root')
createRoot(root).render(
  <StrictMode>
    <HarnessApp />
  </StrictMode>,
)
