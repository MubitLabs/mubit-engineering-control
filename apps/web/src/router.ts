import { useCallback, useEffect, useState } from 'react'

export type Route = 'chat' | 'inbox' | 'work' | 'slots' | 'settings'

const ROUTES: ReadonlySet<string> = new Set(['chat', 'inbox', 'work', 'slots', 'settings'])

/** '#/chat' -> 'chat'; anything unrecognized falls back to 'chat'. */
export function parseHash(hash: string): Route {
  const candidate = hash.replace(/^#\/?/, '')
  return ROUTES.has(candidate) ? (candidate as Route) : 'chat'
}

export function routeToHash(route: Route): string {
  return `#/${route}`
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
