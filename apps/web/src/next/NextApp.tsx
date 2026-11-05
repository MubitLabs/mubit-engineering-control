import { useState } from 'react'
import { useHashRoute } from '../router'
import { PageHeader } from './Conversation'
import { ROUTE_LABELS } from './routes'
import { Shell } from './Shell'
import { EmptyState, ReturnToClassic } from './states'
import { useTheme } from './theme'

/**
 * No live path is wired yet, so every surface says so. Each sentence avoids implying
 * anything about the owner's real work: not "nothing is waiting", only "not shown here".
 */
const UNAVAILABLE = {
  chat: {
    title: 'Conversation is not connected here yet',
    body: 'This preview does not show your repositories or send requests. Your work is unchanged.',
  },
  work: {
    title: 'Work is not connected here yet',
    body: 'Deliveries and tasks are not shown in this preview. Your work is unchanged.',
  },
  needs: {
    title: 'Decisions are not shown here yet',
    body: 'Anything waiting for you is still in the classic workbench. This preview cannot approve or deny.',
  },
  slots: {
    title: 'Connections are not connected here yet',
    body: 'Connection health and usage are not read in this preview. Nothing has changed.',
  },
  setup: {
    title: 'Setup is not connected here yet',
    body: 'Readiness is not checked in this preview. Nothing here reflects your setup.',
  },
  settings: {
    title: 'Settings are not connected here yet',
    body: 'Policy, prompts and models are not read or saved in this preview.',
  },
}

const COMPOSER_UNAVAILABLE = 'Sending is not connected in this preview.'

export function NextApp() {
  const [route, navigate] = useHashRoute()
  const [theme, setTheme] = useTheme()
  const [draft, setDraft] = useState('')
  const copy = UNAVAILABLE[route]

  return (
    <Shell
      route={route}
      onNavigate={navigate}
      theme={theme}
      onTheme={setTheme}
      repositories={[]}
      repositoryId={null}
      needsCount={null}
      recent={[]}
      onOpenRecent={() => {}}
      footnote="Preview only"
      composer={{
        scope: 'New request',
        value: draft,
        onChange: setDraft,
        onSubmit: () => {},
        unavailable: COMPOSER_UNAVAILABLE,
      }}
      commands={[
        {
          id: 'return-classic',
          label: 'Return to the classic workbench',
          run: () => window.location.assign(`?ui=classic${window.location.hash}`),
        },
      ]}
    >
      <div className={route === 'chat' ? 'conversation' : 'page'}>
        <PageHeader title={ROUTE_LABELS[route]} />
        <EmptyState title={copy.title} body={copy.body}>
          <ReturnToClassic />
        </EmptyState>
      </div>
    </Shell>
  )
}
