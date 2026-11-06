/**
 * The guarded server entry (plan §21): start the composition, announce the URL, stay alive
 * until SIGINT/SIGTERM, then close in order. Stop-marker aware on both ends: it refuses to
 * start while an intentional stop stands, and its shutdown leaves no marker behind (a stop
 * is written by `mec stop`, never by a signal). `mec restart` starts this entry detached.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { readApprovalKey } from './approval'
import { type RunningServer, startServer } from './composition'
import { readStopMarker } from './stop-marker'

/** Setup-completeness from the store (best-effort): the wizard sets both of these. */
function setupComplete(dataDir: string): boolean {
  try {
    const db = new Database(join(dataDir, 'mec.db'), { readonly: true })
    try {
      const row = db.prepare('SELECT json FROM docs WHERE id = ?').get('settings/repositories') as
        | { json: string }
        | undefined
      const repoDoc = row === undefined ? undefined : (JSON.parse(row.json) as { repositories?: unknown })
      const slotRow = db.prepare('SELECT json FROM docs WHERE id = ?').get('settings/meta-slot') as
        | { json: string }
        | undefined
      const slotDoc = slotRow === undefined ? undefined : (JSON.parse(slotRow.json) as { slotId?: unknown })
      const hasRepo =
        repoDoc !== undefined && Array.isArray(repoDoc.repositories) && repoDoc.repositories.length > 0
      const hasSlot = slotDoc !== undefined && typeof slotDoc.slotId === 'string' && slotDoc.slotId !== ''
      return hasRepo && hasSlot
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const child = spawn(cmd, [url], { stdio: 'ignore' })
  child.on('error', () => {
    console.log(`open ${url} in your browser to continue`)
  })
}

/** The real entry: only it keeps a port across restarts, for the tab left open on it. */
export const serveOptions = (dataDir: string) => ({ dataDir, reuseLastPort: true })

/** Where this start landed. A moved port is said here: a tab on the old one cannot hear it. */
export function startupLines(handle: Pick<RunningServer, 'url' | 'portMoved'>): string[] {
  const { url, portMoved } = handle
  const moved = portMoved && `port ${portMoved.from} is taken, so mec moved to ${portMoved.to}: reopen ${url}`
  return [`mec server listening on ${url}`, ...(moved ? [moved] : [])]
}

/** `approvalKeyFd`: the deliberate path (`--approval-key-fd=N`). Nothing else sets a key. */
export async function serveMain(dataDir: string, flags: { approvalKeyFd?: number } = {}): Promise<void> {
  if (readStopMarker(dataDir).present) {
    console.log('intentional stop marker present; not starting (run: mec restart)')
    return
  }

  const { approvalKeyFd } = flags
  const handle = await startServer({
    ...serveOptions(dataDir),
    ...(approvalKeyFd !== undefined && { approvalKey: readApprovalKey(approvalKeyFd) }),
  })
  for (const line of startupLines(handle)) console.log(line)
  // Review §3.2: on an incomplete setup, open the browser straight into the wizard;
  // --no-open (exported by bin/mec.js as MEC_NO_OPEN) keeps scripts and CI quiet.
  if (process.env.MEC_NO_OPEN !== '1' && !setupComplete(dataDir)) {
    openBrowser(`${handle.url}/#/wizard`)
  }

  await new Promise<void>((resolve) => {
    let stopped = false
    const shutdown = (signal: string): void => {
      if (stopped) return
      stopped = true
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
      console.log(`mec server stopping on ${signal}`)
      handle
        .close()
        .catch((error: unknown) => {
          console.log(`mec server shutdown error: ${error instanceof Error ? error.message : String(error)}`)
        })
        .then(() => resolve())
    }
    const onSigint = (): void => shutdown('SIGINT')
    const onSigterm = (): void => shutdown('SIGTERM')
    process.once('SIGINT', onSigint)
    process.once('SIGTERM', onSigterm)
  })
}
