import type { ReactNode } from 'react'
import type { Route } from '../router'
import { PageHeader } from './Conversation'
import { ROUTE_LABELS } from './routes'
import { Shell, type ShellProps } from './Shell'
import { EmptyState } from './states'

/**
 * Surfaces with no live path yet say so. Each sentence avoids implying anything about the
 * owner's real work: not "nothing is waiting", only "not shown here".
 */
const UNAVAILABLE: Partial<Record<Route, { title: string; body: string }>> = {
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

export interface NextAppProps extends Omit<ShellProps, 'children'> {
  /** The live surface for this route. Without one it says it is not connected here. */
  children?: ReactNode
}

/** Pure props: everything real arrives from `live/`. */
export function NextApp({ children, ...shell }: NextAppProps) {
  const copy = UNAVAILABLE[shell.route]
  return (
    <Shell {...shell}>
      {children ?? (
        <div className="page">
          <PageHeader title={ROUTE_LABELS[shell.route]} />
          {copy && <EmptyState title={copy.title} body={copy.body} />}
        </div>
      )}
    </Shell>
  )
}
