import { expect, it } from 'vitest'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import { mergeBehindCard, openMergeCard } from '../src/release'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const ghRun = async (args: readonly string[], opts?: { stdin?: string }) => {
  const { execFile } = await import('node:child_process')
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile('gh', args, { timeout: 60_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? 1 : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
    if (opts?.stdin !== undefined) child.stdin?.end(opts.stdin)
    else child.stdin?.end()
  })
}

it('H3 card 3 (approved): merge after green CI — REAL gh, GitHub-confirmed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mec-h3-merge-'))
  const db = new Database(join(dir, 'merge.db'))
  migrate(db, MIGRATIONS_v1)
  const store = new SqliteStore(db)
  const deps = { run: ghRun, store, effects: store.effects, now: () => new Date() }
  const card = await openMergeCard(deps, { repo: 'MubitLabs/mec-sandbox', prNumber: 2 })
  console.log('MERGE-CARD:', card.confirmationId, 'status', store.confirmations.get(card.confirmationId)?.status)
  const result = await mergeBehindCard(deps, { confirmationId: card.confirmationId, repo: 'MubitLabs/mec-sandbox', prNumber: 2, answer: 'approve' })
  console.log('MERGE:', JSON.stringify(result))
  expect(result.merged).toBe(true)
}, 180000)
