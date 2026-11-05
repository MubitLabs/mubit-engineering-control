import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ActivityNote, AgentMessage, DeliveryPlan, PageHeader, UserMessage } from '../../src/next/Conversation'
import { Approval, type DecisionStatus, Question } from '../../src/next/Decision'
import { Shell, useShellActions } from '../../src/next/Shell'
import { EmptyState, StateNotice } from '../../src/next/states'
import '../../src/next/styles'
import { useTheme } from '../../src/next/theme'
import { useHashRoute } from '../../src/router'
import {
  longMessages,
  sampleApprovalScope,
  sampleConsequences,
  sampleEvidence,
  sampleRecent,
  sampleRepositories,
  sampleTaskScopes,
  sampleTasks,
} from './next-fixtures'

/**
 * Renders the real components with synthetic props, for test/next.screens.playwright.ts. Vite
 * serves it from the dev server only; the local state here stands in for what M1.3 binds.
 */

const params = new URLSearchParams(window.location.search)
const variant = params.get('state') ?? 'working'

function ConversationContent({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const { openInspector } = useShellActions()
  if (variant === 'empty') {
    return (
      <div className="conversation">
        <PageHeader title="Conversation" subtitle="Sample meta agent, working in Sample console" />
        <EmptyState title="What would you like to build?" body="Ask for an outcome and the meta agent plans it." />
      </div>
    )
  }
  return (
    <div className="conversation">
      <PageHeader title="Add sample search" subtitle="Sample meta agent, working in Sample console" />
      <UserMessage>Add sample search with clear empties.</UserMessage>
      <AgentMessage>On it. Sample search will be easy to find.</AgentMessage>
      {variant === 'long' && longMessages.map((text) => <AgentMessage key={text}>{text}</AgentMessage>)}
      {variant === 'blocked' && (
        <StateNotice kind="blocked" title="One sample question first" body="Should sample search include archives?" />
      )}
      {variant === 'error' && (
        <StateNotice
          kind="error"
          title="Sample details could not load"
          body="Your conversation and draft are still here."
          action={{ label: 'Try again', onClick: () => {} }}
        />
      )}
      {variant === 'completed' && (
        <StateNotice kind="completed" title="Sample work is tested" body="No sample pull request has been opened." />
      )}
      <DeliveryPlan
        title="Add sample search"
        subtitle="Three sample tasks, one delivery"
        stateLabel="Working locally"
        footnote="No external changes without your approval"
        tasks={sampleTasks.map((task) => ({
          ...task,
          selected: task.id === selected,
          onOpen: () => {
            onSelect(task.id)
            openInspector()
          },
        }))}
      />
      <ActivityNote>Sample implementation is underway.</ActivityNote>
      <p data-testid="sent">Sent: {sent()}</p>
    </div>
  )
}

function DecisionsContent() {
  const { openInspector } = useShellActions()
  const [push, setPush] = useState<DecisionStatus>({ state: 'open', expires: 'Expires in 23 sample minutes' })
  const [question, setQuestion] = useState<DecisionStatus>({ state: 'open', expires: 'No sample expiry' })
  return (
    <div className="page">
      <PageHeader title="Needs you" subtitle="Only the sample decisions that need you." />
      <Approval
        label="Push approval"
        title="Push the tested sample branch"
        summary="This makes the sample branch available on the remote."
        evidence={sampleEvidence}
        consequences={sampleConsequences}
        status={push}
        approveLabel="Approve push"
        confirmLabel="Confirm: push sample branch"
        denyLabel="Deny"
        inspectLabel="Inspect checks and changes"
        onInspect={() => openInspector('checks')}
        onConfirm={() => setPush({ state: 'resolved', label: 'Approved', detail: 'Sample result only' })}
        onDeny={() => setPush({ state: 'resolved', label: 'Denied', detail: 'Sample result only' })}
      />
      <Question
        label="Question"
        title="Include sample archives?"
        summary="The remaining sample work can continue."
        evidence={[{ label: 'Repository', value: 'Sample console' }]}
        status={question}
        choices={['Include sample archives', 'Leave sample archives out']}
        freeTextLabel="Or answer in your own words"
        onAnswer={() => setQuestion({ state: 'resolved', label: 'Answered', detail: 'Sample result only' })}
      />
      <Approval
        label="Push approval"
        title="Push an earlier sample branch"
        summary="This sample approval has already been resolved."
        evidence={sampleEvidence}
        consequences={[]}
        status={{ state: 'resolved', label: 'Approved', detail: 'Sample result only' }}
        approveLabel="Approve push"
        confirmLabel="Confirm: push earlier sample"
        denyLabel="Deny"
        onConfirm={() => {}}
        onDeny={() => {}}
      />
      <Approval
        label="Push approval"
        title="Push a stale sample branch"
        summary="This sample approval passed its expiry without an answer."
        evidence={sampleEvidence}
        consequences={[]}
        status={{ state: 'expired', label: 'Expired', detail: 'Nothing was pushed in this sample' }}
        approveLabel="Approve push"
        confirmLabel="Confirm: push stale sample"
        denyLabel="Deny"
        onConfirm={() => {}}
        onDeny={() => {}}
      />
    </div>
  )
}

function StatesContent() {
  return (
    <div className="page">
      <PageHeader title="Sample states" />
      <StateNotice kind="working" title="Working sample" body="Sample work is underway." />
      <StateNotice kind="blocked" title="Blocked sample" body="Sample work needs one answer." />
      <StateNotice
        kind="error"
        title="Failed sample"
        body="The sample failed and its content is kept."
        action={{ label: 'Try again', onClick: () => {} }}
      />
      <StateNotice kind="completed" title="Completed sample" body="The sample artifact is delivered." />
      <StateNotice kind="resolved" title="Resolved sample" body="The sample decision is recorded." />
      <StateNotice kind="expired" title="Expired sample" body="The sample decision lapsed untouched." />
      <EmptyState title="Empty sample" body="Start one sample request to fill this." />
    </div>
  )
}

let sentCount = 0
const sent = () => sentCount

function HarnessApp() {
  const [route, navigate] = useHashRoute()
  const [theme, setTheme] = useTheme()
  const [repositoryId, setRepositoryId] = useState('repo_a')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [following, setFollowing] = useState(false)
  const [selected, setSelected] = useState<string | null>(params.get('task'))
  const [, redraw] = useState(0)

  const scope = selected ? (sampleTaskScopes[selected] ?? null) : null
  const empty = variant === 'empty'
  return (
    <Shell
      route={route}
      onNavigate={navigate}
      theme={theme}
      onTheme={setTheme}
      repositories={sampleRepositories}
      repositoryId={repositoryId}
      onSwitchRepository={setRepositoryId}
      needsCount={empty ? 0 : 1}
      recent={empty ? [] : sampleRecent}
      onOpenRecent={() => {}}
      footnote="Local workspace"
      taskInspector={empty ? null : scope}
      approvalInspector={empty ? null : sampleApprovalScope}
      initialInspectorOpen={params.get('inspector') === 'open'}
      composer={{
        scope: following ? 'Following up on Add sample search' : 'New request in Sample console',
        value: drafts[repositoryId] ?? '',
        onChange: (value) => setDrafts((all) => ({ ...all, [repositoryId]: value })),
        onSubmit: () => {
          sentCount += 1
          setDrafts((all) => ({ ...all, [repositoryId]: '' }))
          redraw((value) => value + 1)
        },
        intentToggle: {
          label: following ? 'New request' : 'Follow up',
          onToggle: () => setFollowing((value) => !value),
        },
      }}
    >
      {route === 'chat' && variant !== 'states' && <ConversationContent selected={selected} onSelect={setSelected} />}
      {route === 'chat' && variant === 'states' && <StatesContent />}
      {route === 'needs' && <DecisionsContent />}
      {route !== 'chat' && route !== 'needs' && (
        <div className="page">
          <PageHeader title="Sample surface" />
          <EmptyState title="Nothing sampled here" body="This route has no sample content yet." />
        </div>
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
