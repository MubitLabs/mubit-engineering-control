import { expect, it } from 'vitest'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import { buildPrBody, createPrBehindCard, resolvePrCreate } from '../src/release'
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

it('H3 card 2 (approved): open the PR — REAL gh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mec-h3-store-'))
  const db = new Database(join(dir, 'cards.db'))
  migrate(db, MIGRATIONS_v1)
  const store = new SqliteStore(db)
  const deps = { run: ghRun, store, effects: store.effects, now: () => new Date() }
  const body = buildPrBody({
    request: 'Add a farewell feature',
    tasks: [{ id: 'implement', role: 'implementer', acceptedSha: 'f9af3a61e52033b89f7171c505a64ef3db065fb0' }],
    integrationSha: 'd54355a2d521eb041302208b443ea777c778ce29',
    checks: [{ name: 'npm-test-int', status: 'passed' }],
    findings: [],
    decisions: [],
  })
  const card = await createPrBehindCard(deps, { repo: 'MubitLabs/mec-sandbox', branch: 'mec/h3/integration', title: 'Add a farewell feature (MEC delivery wi_h3)', body })
  console.log('CARD:', card.confirmationId)
  const pending = store.confirmations.get(card.confirmationId)
  console.log('CARD-STATE-BEFORE-RESOLVE:', JSON.stringify({ status: pending?.status, cls: pending?.cls }))
  const resolved = await resolvePrCreate(deps, { confirmationId: card.confirmationId, answer: 'approve' })
  console.log('RESOLVED:', JSON.stringify(resolved).slice(0, 200))
  expect(resolved.prNumber).toBeGreaterThan(0)
}, 180000)
