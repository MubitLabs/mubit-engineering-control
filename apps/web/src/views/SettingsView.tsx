import { EmptyState } from '../components/ui'

const SECTIONS = ['Policy', 'Prompts', 'Repositories', 'Backup'] as const

export function SettingsView() {
  return (
    <div className="settings">
      <nav className="settings-nav">
        {SECTIONS.map((section) => (
          <span className="settings-nav-item" key={section}>
            {section}
          </span>
        ))}
      </nav>
      <div className="settings-pane">
        <EmptyState>select a section</EmptyState>
      </div>
    </div>
  )
}
