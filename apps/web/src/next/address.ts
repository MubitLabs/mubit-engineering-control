import { parseHash, type Route, routeToHash } from '../router'

/**
 * Where the next shell is. Repo, work and task have addresses that survive reload and
 * back/forward: `#repo/<id>/chat`, `#repo/<id>/work/<workId>/task/<taskId>` and so on. A plain
 * `#chat` or an alias still works and resolves against the active repository, and classic
 * parses the longer form to chat through `parseHash`.
 */
export interface Address {
  route: Route
  /** null is the active repository, whichever that is. */
  repoId: string | null
  workId: string | null
  taskId: string | null
}

const ROUTES: readonly Route[] = ['chat', 'needs', 'work', 'slots', 'setup', 'settings']

const plain = (route: Route): Address => ({ route, repoId: null, workId: null, taskId: null })

function decodeAll(parts: readonly string[]): string[] | null {
  try {
    return parts.map(decodeURIComponent)
  } catch {
    return null
  }
}

export function parseAddress(hash: string): Address {
  const path = hash.replace(/^#\/?/, '')
  const [head, ...encoded] = path.split('/')
  if (head !== 'repo') return plain(parseHash(hash))

  const parts = decodeAll(encoded)
  const fallback = plain('chat')
  if (parts === null || parts.some((part) => part === '')) return fallback
  const [repoId, route, workId, label, taskId] = parts
  if (repoId === undefined) return fallback
  const known = ROUTES.find((entry) => entry === route)
  if (known === undefined) return fallback

  const scoped = { ...fallback, route: known, repoId }
  if (parts.length === 2) return scoped
  if (known !== 'work' || workId === undefined) return fallback
  if (parts.length === 3) return { ...scoped, workId }
  if (parts.length === 5 && label === 'task' && taskId !== undefined) return { ...scoped, workId, taskId }
  return fallback
}

export function addressHash(address: Address): string {
  const { route, repoId, workId, taskId } = address
  if (repoId === null) return routeToHash(route)
  const base = `#repo/${encodeURIComponent(repoId)}/${route}`
  if (workId === null) return base
  const work = `${base}/${encodeURIComponent(workId)}`
  return taskId === null ? work : `${work}/task/${encodeURIComponent(taskId)}`
}
