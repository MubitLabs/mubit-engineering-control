import { type ComponentType, useCallback, useState } from 'react'
import { api, type RuntimeState, type StatusSnapshot } from './api'
import { Badge, type BadgeState } from './components/ui'
import { type Route, routeToHash, useHashRoute } from './router'
import { usePolling } from './usePolling'
import { ChatView } from './views/ChatView'
import { InboxView } from './views/InboxView'
import { SettingsView } from './views/SettingsView'
import { SlotsView } from './views/SlotsView'
import { WizardView } from './views/WizardView'
import { WorkView } from './views/WorkView'

const NAV: ReadonlyArray<{ route: Route; label: string }> = [
  { route: 'chat', label: 'Chat' },
  { route: 'inbox', label: 'Inbox' },
  { route: 'work', label: 'Work' },
  { route: 'slots', label: 'Slots' },
  { route: 'wizard', label: 'Setup' },
  { route: 'settings', label: 'Settings' },
]

const VIEWS: Record<Route, ComponentType> = {
  chat: ChatView,
  inbox: InboxView,
  work: WorkView,
  slots: SlotsView,
  wizard: WizardView,
  settings: SettingsView,
}

type Health =
  | { kind: 'unknown' }
  | { kind: 'live'; runtime: StatusSnapshot['runtime'] }
  | { kind: 'unreachable' }

function runtimeBadgeState(state: RuntimeState): BadgeState {
  if (state === 'ready') return 'ok'
  if (state === 'error') return 'error'
  return 'degraded'
}

function badgeFor(health: Health): { label: string; state: BadgeState } {
  if (health.kind === 'unreachable') return { label: 'runtime: unreachable', state: 'error' }
  if (health.kind === 'unknown') return { label: 'runtime: starting', state: 'degraded' }
  const { state, instances } = health.runtime
  const suffix = instances === 1 ? '' : ` · ${instances} instances`
  return { label: `runtime: ${state}${suffix}`, state: runtimeBadgeState(state) }
}

export function App() {
  const [route] = useHashRoute()
  const [health, setHealth] = useState<Health>({ kind: 'unknown' })

  const check = useCallback(() => {
    api
      .status()
      .then((snapshot) => setHealth({ kind: 'live', runtime: snapshot.runtime }))
      .catch(() => setHealth({ kind: 'unreachable' }))
  }, [])
  usePolling(check, 5000)

  const View = VIEWS[route]
  const badge = badgeFor(health)
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">MEC</div>
        <nav className="nav">
          {NAV.map((item) => (
            <a
              key={item.route}
              className={item.route === route ? 'nav-item active' : 'nav-item'}
              href={routeToHash(item.route)}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          {/* Health badge fed by GET /api/status (§19): runtime state → colour */}
          <Badge label={badge.label} state={badge.state} />
        </header>
        <main className="content">
          <View />
        </main>
      </div>
    </div>
  )
}
