import { useId, useRef, useState } from 'react'
import type { Route } from '../router'
import { timeLabel } from './format'
import {
  Button,
  ChevronIcon,
  CloseIcon,
  ConnectionsIcon,
  ConversationIcon,
  IconButton,
  NeedsIcon,
  SettingsIcon,
  SetupIcon,
  ThemeIcon,
  UpDownIcon,
  WorkIcon,
} from './primitives'
import { CONFIGURATION_ROUTES, ROUTE_LABELS, WORK_ROUTES } from './routes'
import { Sheet } from './Sheet'
import { nextTheme, THEME_LABELS, type ThemeChoice } from './theme'

export interface RepositoryOption {
  id: string
  name: string
  detail: string
}

export interface RecentItem {
  id: string
  title: string
  current: boolean
}

const ROUTE_ICONS: Record<Route, () => React.JSX.Element> = {
  chat: ConversationIcon,
  work: WorkIcon,
  needs: NeedsIcon,
  slots: ConnectionsIcon,
  setup: SetupIcon,
  settings: SettingsIcon,
}

/** §20: stops everything until resumed, unlike Hold and Stop, which act on one piece of work. */
export interface PauseControl {
  /** `unknown` when the read failed: the control never guesses which way it would go. */
  state: 'running' | 'paused' | 'unknown'
  busy: boolean
  pausedAt?: string
  /** Why it cannot be used here; said before the click. */
  unavailable?: string
  error?: string
  onToggle: () => void
}

/** The banner's wording around a served time. A person reads it, so it is never the ISO form. */
export function pausedSince(at: string): string {
  return Number.isNaN(new Date(at).getTime()) ? '' : ` since ${timeLabel(at)}`
}

function PauseButton({ pause }: { pause: PauseControl }) {
  const paused = pause.state === 'paused'
  const help = useId()
  return (
    <section className="pause" aria-label="Processing">
      {paused && (
        <p className="pause-state">
          <strong>Processing paused</strong>
          {pause.pausedAt ? pausedSince(pause.pausedAt) : ''}. Messages are kept and no new turn runs.
        </p>
      )}
      <Button
        className="pause-button"
        aria-describedby={help}
        disabled={pause.busy || pause.state === 'unknown' || pause.unavailable !== undefined}
        onClick={pause.onToggle}
      >
        {pause.busy ? 'Working…' : paused ? 'Resume processing' : 'Pause processing'}
      </Button>
      <p id={help} className="pause-state">
        {paused
          ? 'Resuming lets queued work start again.'
          : 'Stops new runs for all work. Runs in progress finish.'}
      </p>
      {pause.state === 'unknown' && (
        <p className="pause-state">Could not read whether processing is paused.</p>
      )}
      {pause.unavailable && <p className="pause-state">{pause.unavailable}</p>}
      {pause.error && (
        <p className="pause-state" role="alert">
          {pause.error}
        </p>
      )}
    </section>
  )
}

export interface SidebarProps {
  repositories: readonly RepositoryOption[]
  repositoryId: string | null
  onSwitchRepository: (id: string) => void
  route: Route
  onNavigate: (route: Route) => void
  /** null when the count is unknown: that is different from nothing waiting. */
  needsCount: number | null
  /** Legacy rows with no repository, offered read-only while any exist. */
  unassigned?: { current: boolean; onOpen: () => void }
  /** The persistent global control, set apart from navigation just below Needs you (#22). */
  pause?: PauseControl
  recent: readonly RecentItem[]
  onOpenRecent: (id: string) => void
  footnote: string
  theme: ThemeChoice
  onTheme: (choice: ThemeChoice) => void
  /** Present only inside the drawer. */
  onClose?: () => void
  closeLabelId?: string
}

export function Sidebar(props: SidebarProps) {
  const { route, onNavigate, needsCount, recent, theme, onTheme, footnote, onClose } = props
  const repository = props.repositories.find((entry) => entry.id === props.repositoryId) ?? null
  const [choosing, setChoosing] = useState(false)
  const repoButton = useRef<HTMLButtonElement>(null)
  const canSwitch = props.repositories.length > 1 || (props.repositories.length === 1 && repository === null)
  const viewingUnassigned = props.unassigned?.current === true
  const repoLabel =
    repository ??
    (viewingUnassigned
      ? { name: 'Unassigned', detail: 'Read-only history' }
      : { name: 'Choose a repository', detail: 'None chosen yet' })

  const navItem = (target: Route) => {
    const NavIcon = ROUTE_ICONS[target]
    const count = target === 'needs' && needsCount !== null && needsCount > 0 ? needsCount : null
    return (
      <button
        key={target}
        type="button"
        className="nav-item"
        aria-current={route === target ? 'page' : undefined}
        onClick={() => onNavigate(target)}
      >
        <NavIcon />
        {ROUTE_LABELS[target]}
        {count !== null && (
          <span className="count">
            {count}
            <span className="sr-only"> waiting</span>
          </span>
        )}
      </button>
    )
  }

  const upcoming = nextTheme(theme)
  return (
    <div className="sidebar">
      <div className="brand-row">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          MEC
        </div>
        {onClose && (
          <IconButton label="Close navigation" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        )}
      </div>

      {canSwitch ? (
        <button
          ref={repoButton}
          type="button"
          className="repo-switch"
          aria-haspopup="dialog"
          aria-expanded={choosing}
          onClick={() => setChoosing(true)}
        >
          {repository && <span className="sr-only">Repository: </span>}
          <RepositoryLabel name={repoLabel.name} detail={repoLabel.detail} />
          {repository && <span className="sr-only">. Switch repository</span>}
          {viewingUnassigned && <span className="sr-only">. Choose a repository</span>}
          <UpDownIcon />
        </button>
      ) : (
        <div className="repo-switch repo-static">
          <RepositoryLabel
            name={repository?.name ?? 'No repository'}
            detail={repository?.detail ?? 'Not connected yet'}
          />
        </div>
      )}

      <nav className="nav-stack" aria-label="Workspace">
        {WORK_ROUTES.map(navItem)}
      </nav>

      {props.pause && <PauseButton pause={props.pause} />}

      {recent.length > 0 && (
        <section className="recent" aria-label="Recent work">
          <h2 className="recent-label">Recent work</h2>
          <ul>
            {recent.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="recent-item"
                  aria-current={item.current ? 'true' : undefined}
                  onClick={() => props.onOpenRecent(item.id)}
                >
                  <span className="clamp-2" title={item.title}>
                    {item.title}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {props.unassigned && (
        <nav className="nav-stack rail-history" aria-label="History">
          <button
            type="button"
            className="nav-item"
            aria-current={props.unassigned.current ? 'page' : undefined}
            onClick={props.unassigned.onOpen}
          >
            <WorkIcon />
            Unassigned
          </button>
        </nav>
      )}

      <div className="rail-foot">
        <nav className="nav-stack" aria-label="Configuration">
          {CONFIGURATION_ROUTES.map(navItem)}
        </nav>
        <div className="rail-bottom">
          <span className="footnote">{footnote}</span>
          <IconButton
            label={`Theme: ${THEME_LABELS[theme]}. Switch to ${THEME_LABELS[upcoming]}`}
            onClick={() => onTheme(upcoming)}
          >
            <ThemeIcon />
          </IconButton>
        </div>
      </div>

      {choosing && (
        <RepositoryDialog
          repositories={props.repositories}
          repositoryId={props.repositoryId}
          onClose={() => setChoosing(false)}
          onChoose={(id) => {
            setChoosing(false)
            props.onSwitchRepository(id)
          }}
        />
      )}
    </div>
  )
}

function RepositoryLabel({ name, detail }: { name: string; detail: string }) {
  return (
    <span className="repo-label">
      <span className="repo-icon" aria-hidden="true">
        {name.charAt(0).toUpperCase()}
      </span>
      <span className="repo-text">
        <strong>{name}</strong>
        <small>{detail}</small>
      </span>
    </span>
  )
}

function RepositoryDialog({
  repositories,
  repositoryId,
  onClose,
  onChoose,
}: {
  repositories: readonly RepositoryOption[]
  repositoryId: string | null
  onClose: () => void
  onChoose: (id: string) => void
}) {
  const hint = useId()
  return (
    <Sheet variant="dialog" title="Switch repository" onClose={onClose}>
      <p id={hint} className="muted">
        Each repository keeps its own conversation, work and drafts.
      </p>
      <ul className="choices" aria-describedby={hint}>
        {repositories.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className="choice"
              aria-current={entry.id === repositoryId ? 'true' : undefined}
              onClick={() => onChoose(entry.id)}
            >
              <span>
                {entry.name}
                <small>{entry.detail}</small>
              </span>
              <ChevronIcon />
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  )
}
