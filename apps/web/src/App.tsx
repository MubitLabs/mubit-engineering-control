import type { ComponentType } from 'react'
import { Badge } from './components/ui'
import { type Route, routeToHash, useHashRoute } from './router'
import { ChatView } from './views/ChatView'
import { InboxView } from './views/InboxView'
import { SettingsView } from './views/SettingsView'
import { SlotsView } from './views/SlotsView'
import { WorkView } from './views/WorkView'

const NAV: ReadonlyArray<{ route: Route; label: string }> = [
  { route: 'chat', label: 'Chat' },
  { route: 'inbox', label: 'Inbox' },
  { route: 'work', label: 'Work' },
  { route: 'slots', label: 'Slots' },
  { route: 'settings', label: 'Settings' },
]

const VIEWS: Record<Route, ComponentType> = {
  chat: ChatView,
  inbox: InboxView,
  work: WorkView,
  slots: SlotsView,
  settings: SettingsView,
}

export function App() {
  const [route] = useHashRoute()
  const View = VIEWS[route]
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
          {/* Placeholder until the health board (§19) feeds real states */}
          <Badge label="runtime: starting" state="degraded" />
        </header>
        <main className="content">
          <View />
        </main>
      </div>
    </div>
  )
}
