import type { Route } from '../router'

/** Presentation names only: the addresses stay `#chat`, `#needs`, `#slots` and so on. */
export const ROUTE_LABELS: Record<Route, string> = {
  chat: 'Conversation',
  work: 'Work',
  needs: 'Needs you',
  slots: 'Connections',
  setup: 'Setup',
  settings: 'Settings',
}

export const WORK_ROUTES: readonly Route[] = ['chat', 'work', 'needs']
export const CONFIGURATION_ROUTES: readonly Route[] = ['slots', 'setup', 'settings']
