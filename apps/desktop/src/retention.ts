/**
 * Retention (plan §20): operational logs 30 days, delivery evidence 90 days, decisions and
 * merge records kept. Cleanup is a resumable job with eligibility checks that never touches
 * slot homes — never an agent deciding what to delete. Both functions are pure: the caller
 * walks the state dir, persists the plan, and applies deletions; replaying a persisted plan
 * converges because eligibility depends only on (path, mtime, kind, now).
 */
import { basename } from 'node:path'

export type RetentionRule = { kind: 'operational_log' | 'delivery_evidence' | 'decision'; days: number }

export const DEFAULT_RULES: readonly RetentionRule[] = [
  { kind: 'operational_log', days: 30 },
  { kind: 'delivery_evidence', days: 90 },
  { kind: 'decision', days: Number.POSITIVE_INFINITY },
]

/** The database, its SQLite sidecars and backup manifests are never retention's business. */
const NEVER_DELETE_BASENAMES = new Set([
  'db.sqlite',
  'db.sqlite-wal',
  'db.sqlite-shm',
  'db.sqlite-journal',
  'manifest.json',
])

function isSlotHome(path: string): boolean {
  // Any `engines` path segment is treated as a slot home. Over-matching keeps files —
  // the safe direction for a deletion rule (plan §20: never touch slot homes).
  return path.split('/').includes('engines')
}

export function eligibility(input: {
  now: Date
  file: { path: string; mtime: Date; kind: RetentionRule['kind'] }
}): { delete: boolean; reason?: string } {
  const { path, mtime, kind } = input.file
  if (isSlotHome(path)) {
    return {
      delete: false,
      reason: 'slot home (engines/ segment in the path) — retention never touches slot homes',
    }
  }
  if (NEVER_DELETE_BASENAMES.has(basename(path))) {
    return { delete: false, reason: 'database or backup manifest — never deleted by retention' }
  }
  const rule = DEFAULT_RULES.find((candidate) => candidate.kind === kind)
  if (rule === undefined) {
    return { delete: false, reason: `no retention rule for kind '${kind}' — kept` }
  }
  if (!Number.isFinite(rule.days)) {
    return { delete: false, reason: `rule for '${kind}' has no expiry — records are kept` }
  }
  const expiresAt = mtime.getTime() + rule.days * 24 * 60 * 60 * 1000
  if (expiresAt < input.now.getTime()) return { delete: true }
  return { delete: false, reason: `'${kind}' is inside its ${rule.days}-day retention window` }
}

export function planRetention(input: {
  now: Date
  files: { path: string; mtime: Date }[]
  classify: (path: string) => RetentionRule['kind']
}): { toDelete: string[]; kept: { path: string; reason: string }[] } {
  const toDelete: string[] = []
  const kept: { path: string; reason: string }[] = []
  for (const file of input.files) {
    const kind = input.classify(file.path)
    const verdict = eligibility({ now: input.now, file: { path: file.path, mtime: file.mtime, kind } })
    if (verdict.delete) toDelete.push(file.path)
    else kept.push({ path: file.path, reason: verdict.reason ?? 'kept' })
  }
  return { toDelete, kept }
}
