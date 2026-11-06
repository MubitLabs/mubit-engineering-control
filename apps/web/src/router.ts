import { useCallback, useEffect, useState } from 'react'

/**
 * The six screens of the workbench. The hash is the `#chat` form; the older `#/wizard` and
 * `#/inbox` deep links stay working as aliases so nothing already shared breaks.
 */
export type Route = 'chat' | 'needs' | 'work' | 'slots' | 'setup' | 'settings'

const ROUTES: ReadonlySet<string> = new Set(['chat', 'needs', 'work', 'slots', 'setup', 'settings'])

/** Old scaffold names → the screen that carries them now. */
const ALIASES: Readonly<Record<string, Route>> = { inbox: 'needs', wizard: 'setup' }

/** '#chat' | '#/chat' | '#/wizard' → 'chat' | … ; anything unrecognized falls back to 'chat'. */
export function parseHash(hash: string): Route {
  const candidate = hash.replace(/^#\/?/, '')
  if (ROUTES.has(candidate)) return candidate as Route
  const aliased = ALIASES[candidate]
  return aliased ?? 'chat'
}

export function routeToHash(route: Route): string {
  return `#${route}`
}

export function useHashRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const navigate = useCallback((r: Route) => {
    window.location.hash = routeToHash(r)
  }, [])

  return [route, navigate]
}
