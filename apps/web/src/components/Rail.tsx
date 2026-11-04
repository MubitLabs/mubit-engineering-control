import type { Route } from '../router'
import { routeToHash } from '../router'
import type { SlotHealth } from '../workbench'

export type RailCounts = { needs: number; work: number; slots: number; slotsAttention: boolean }

/**
 * The rail: route, counts, slot health dots, the runtime line, the theme switch
 * and the ⌘K hint. Amber appears only on what waits for the person.
 */
export function Rail({
  route,
  counts,
  slotHealth,
  runtimeLine,
  runtimeSub,
  theme,
  onTheme,
}: {
  route: Route
  counts: RailCounts
  slotHealth: SlotHealth[]
  runtimeLine: string
  runtimeSub: string
  theme: 'auto' | 'light' | 'dark'
  onTheme: (t: 'auto' | 'light' | 'dark') => void
}) {
  return (
    <nav className="rail" aria-label="Primary">
      <a className="brand" href={routeToHash('chat')} aria-label="MEC home">
        MEC
      </a>
      <ul className="rail-nav">
        <RailItem route={route} target="chat" label="Chat" />
        <RailItem
          route={route}
          target="needs"
          label="Needs you"
          count={counts.needs}
          attention={counts.needs > 0}
        />
        <RailItem route={route} target="work" label="Work" count={counts.work} />
        <RailItem
          route={route}
          target="slots"
          label="Slots"
          count={counts.slotsAttention ? counts.slots : undefined}
          attention={counts.slotsAttention}
        />
        <RailItem route={route} target="setup" label="Setup" />
        <RailItem route={route} target="settings" label="Settings" />
      </ul>
      <div className="rail-foot">
        {slotHealth.length > 0 ? (
          <div className="slot-dots">
            {slotHealth.map((slot) => (
              <span
                key={slot.label}
                className={`dot ${slot.kind === 'attn' ? 'dot-attn' : slot.kind === 'warn' ? 'dot-warn' : 'dot-ok'}`}
                title={`${slot.label}: ${slot.note}`}
              />
            ))}
          </div>
        ) : null}
        <p className="rail-status">
          {runtimeLine}
          <br />
          <span className="muted">{runtimeSub}</span>
        </p>
        <div className="theme">
          {(['auto', 'light', 'dark'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={theme === t ? 'is-active' : ''}
              onClick={() => onTheme(t)}
            >
              {t === 'auto' ? 'Auto' : t === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
        <p className="rail-hint">
          <kbd>⌘K</kbd> commands
        </p>
      </div>
    </nav>
  )
}

function RailItem({
  route,
  target,
  label,
  count,
  attention = false,
}: {
  route: Route
  target: Route
  label: string
  count?: number
  attention?: boolean
}) {
  return (
    <li>
      <a href={routeToHash(target)} className={`rail-item${route === target ? ' is-active' : ''}`}>
        <span>{label}</span>
        {count === undefined ? null : (
          <b className={`count${attention ? ' count-attention' : ''}`}>{count}</b>
        )}
      </a>
    </li>
  )
}

export function PaneHead({
  title,
  sub,
  children,
}: {
  title: React.ReactNode
  sub?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <header className="pane-head">
      <h1 className="pane-title">{title}</h1>
      {sub === undefined ? null : <p className="pane-sub">{sub}</p>}
      {children === undefined ? null : <div className="pane-tools">{children}</div>}
    </header>
  )
}
