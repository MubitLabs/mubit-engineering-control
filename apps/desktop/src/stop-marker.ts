/**
 * The intentional-stop marker for `mec stop` / `mec restart --respect-stop` (plan §21.2).
 *
 * Presence is the signal: while the marker file exists, a stop-respecting restart refuses to
 * bring the runtime back. The payload is advisory (why it was written, when) — reading never
 * throws and never guesses a reason that is not cleanly in the file.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const STOP_MARKER_FILENAME = 'stop-marker'

export function stopMarkerPath(dir: string): string {
  return join(dir, STOP_MARKER_FILENAME)
}

export function writeStopMarker(dir: string, reason?: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(stopMarkerPath(dir), JSON.stringify({ reason, writtenAt: new Date().toISOString() }))
}

export function readStopMarker(dir: string): { present: boolean; reason?: string } {
  let text: string
  try {
    text = readFileSync(stopMarkerPath(dir), 'utf8')
  } catch {
    // Missing directory or missing file: never run, or already cleared.
    return { present: false }
  }
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw === 'object' && raw !== null) {
      const reason = (raw as { reason?: unknown }).reason
      if (typeof reason === 'string') return { present: true, reason }
    }
  } catch {
    // Invalid JSON: the file exists, so the stop stands, but the reason is unknown.
  }
  return { present: true }
}

export function clearStopMarker(dir: string): void {
  try {
    rmSync(stopMarkerPath(dir), { force: true })
  } catch {
    // Best-effort: clearing must never throw.
  }
}
