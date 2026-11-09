import page from '../../package.json'
import { api } from '../api'

/** The version this page was built at. The server names its own on `/api/status`. */
export const PAGE_VERSION: string = page.version

/**
 * A page is stale when the server it talks to names another version: MEC was upgraded while this
 * tab stayed open (9 November 2026). A server that names none, or cannot read its own, is no
 * evidence, so an answer the page cannot decode then stays the decode failure it says it is.
 */
export function isStalePage(server: string | undefined, own: string = PAGE_VERSION): boolean {
  return server !== undefined && server !== 'unknown' && server !== own
}

/** The live server's version, or undefined when it does not say. */
export async function liveServerVersion(): Promise<string | undefined> {
  const status = await api.status()
  return typeof status.version === 'string' ? status.version : undefined
}
