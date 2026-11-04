import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'

/** Gated (MEC_REAL_PLANNER=1): a REAL planner turn — spends Claude quota, never CI. */
const REAL = process.env.MEC_REAL_PLANNER === '1'

import { MetaAgentService, RealClaudeBrain } from '@mec/meta'

/** #15 diagnosis: the service + real brain, exactly as composition wires it. */
it.skipIf(!REAL)(
  'one real service turn: tiered plan + launch enqueued',
  async () => {
    // A COPY of the real store: healthy slots, real state — no mutation of ~/.mec.
    const dir = mkdtempSync(join(tmpdir(), 'mec-svc-diag-'))
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        copyFileSync(join(process.env.HOME ?? '', '.mec', `mec.db${suffix}`), join(dir, `mec.db${suffix}`))
      } catch {
        /* absent is fine */
      }
    }
    const db = new Database(join(dir, 'mec.db'))
    migrate(db, MIGRATIONS_v1)
    const store = new SqliteStore(db)
    const { loadModelsTable } = await import('@mec/prompts')
    const { probeModelAvailabilitySync } = await import('@mec/slots')
    const service = new MetaAgentService({
      store,
      effects: store.effects,
      modelsTable: () => {
        try {
          const loaded = loadModelsTable()
          return {
            table: loaded.table,
            provenance: { sha256: loaded.provenance.sha256, origin: loaded.provenance.source },
          }
        } catch {
          return undefined
        }
      },
      marks: () => {
        const out: Record<string, Record<string, 'available' | 'unavailable' | 'unlisted'>> = {}
        for (const slot of store.slots.list()) {
          if (slot.engine !== 'opencode' || typeof slot.home !== 'string') continue
          try {
            out[String(slot.id)] = probeModelAvailabilitySync('opencode', {
              configDir: join(slot.home, 'config'),
            }).availability
          } catch {
            /* honestly unlisted */
          }
        }
        return out
      },
      brain: new RealClaudeBrain({
        slotDir: join(process.env.HOME ?? '', '.mec/engines/claude/preflight-a'),
        toolsSecret: 'diag-secret',
      }).asBrain(),
    } as never)
    const outcome = await service.onUserMessage({
      messageId: 'msg_diag1',
      text: 'Add a tiny demo feature: foo.js exporting foo() returning "foo", with a node:test test. Use the cheapest tier that suffices and say why.',
    })
    console.log('OUTCOME:', JSON.stringify(outcome).slice(0, 700))
    if (REAL) {
      expect(outcome.tasksCreated).toBeGreaterThan(0)
      expect(outcome.launchesEnqueued.length).toBeGreaterThan(0)
    }
    console.log('DIR:', dir)
    const evts = db.prepare('SELECT body FROM events ORDER BY rowid DESC LIMIT 40').all() as Array<{
      body: string | null
    }>
    for (const e of evts.reverse()) console.log('EVENT:', (e.body ?? '').slice(0, 800))
    const tasks = db.prepare("SELECT json FROM docs WHERE id LIKE 'task_%'").all() as Array<{ json: string }>
    for (const t of tasks) {
      const doc = JSON.parse(t.json)
      if (doc.workItemId !== outcome.workItemId) continue
      console.log(
        'TASK-FULL:',
        JSON.stringify({
          id: doc.id,
          role: doc.role,
          modelRequest: doc.modelRequest,
          ownedPaths: doc.ownedPaths,
          originalRequestRef: doc.originalRequestRef,
          status: doc.status,
        }),
      )
    }
  },
  300_000,
)
