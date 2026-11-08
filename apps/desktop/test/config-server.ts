import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HealthBoard, StoreDoc } from '@mec/contracts'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { buildServer, type ProbeCmd, type ServerDeps } from '../src/server'
import { ownerApproval, ownerHeaders } from './approval-rig'

/** A deliberately synthetic key: it passes the anthropic intake shape and opens nothing. */
export const SYNTHETIC_KEY = 'sk-ant-api03-mec-test-fixture-000000000000abcd'
export const SYNTHETIC_KEY_2 = 'sk-ant-api03-mec-test-fixture-111111111111wxyz'

type App = ReturnType<typeof buildServer>
const injected = (app: App) => app.inject({ method: 'GET', url: '/' })
type Reply = ReturnType<typeof injected>

export type ConfigServer = {
  app: App
  store: SqliteStore
  db: Database.Database
  dir: string
  keystoreRoot: string
  fetches: string[]
  setProbe: (probe: ProbeCmd) => void
  setRespond: (respond: () => Response) => void
  post: (url: string, body?: unknown) => Reply
  put: (url: string, body: unknown) => Reply
  patch: (url: string, body: unknown) => Reply
  get: (url: string) => Reply
  close: () => Promise<void>
}

/** Every engine installed: a fake binary, so no test ever runs a real one. */
export const installedProbe: ProbeCmd = async (cmd) => ({ code: 0, stdout: `${cmd} 9.9.9\n`, stderr: '' })
export const nothingInstalled: ProbeCmd = async () => ({ code: -1, stdout: '', stderr: '' })

const health: HealthBoard = {
  claim: () => ({ starting: () => {}, ready: () => {}, paused: () => {}, error: () => {} }),
}

/** buildServer over a real SqliteStore and a scratch keystore root; no real probe or provider. */
export function makeConfigServer(extra: Partial<ServerDeps> = {}): ConfigServer {
  const dir = mkdtempSync(join(tmpdir(), `mec-config-${randomBytes(4).toString('hex')}-`))
  const db = new Database(join(dir, 'mec.db'))
  migrate(db, MIGRATIONS_v1)
  const store = new SqliteStore(db)
  const keystoreRoot = join(dir, 'root')
  const fetches: string[] = []
  let respond: () => Response = () => new Response('{"data":[]}', { status: 200 })
  let probe: ProbeCmd = installedProbe
  const app = buildServer({
    store,
    effects: store.effects,
    health,
    policyText: '{"preAuthorised":{}}',
    now: () => new Date(),
    keystoreRoot,
    probeCmd: (cmd, args, opts) => probe(cmd, args, opts),
    validateFetch: async (input) => {
      fetches.push(String(input))
      return respond()
    },
    approval: ownerApproval(),
    ...extra,
  })
  const send =
    (method: 'POST' | 'PUT' | 'PATCH') =>
    (url: string, body?: unknown): Reply =>
      app.inject({
        method,
        url,
        // A test plays the owner: its word carries the key the server was handed.
        headers: { ...ownerHeaders, ...(body !== undefined && { 'content-type': 'application/json' }) },
        ...(body !== undefined && { payload: JSON.stringify(body) }),
      })
  return {
    app,
    store,
    db,
    dir,
    keystoreRoot,
    fetches,
    setProbe: (next) => {
      probe = next
    },
    setRespond: (next) => {
      respond = next
    },
    post: send('POST'),
    put: send('PUT'),
    patch: send('PATCH'),
    get: (url) => app.inject({ method: 'GET', url }),
    close: async () => {
      await app.close()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const AT = '2026-11-05T10:00:00.000Z'

/** A slot doc as the routes write one; `state` decides what it is usable for. */
export function seedSlot(store: SqliteStore, fields: Partial<StoreDoc> & { label: string }): string {
  const id = `slot_${fields.label}`
  store.slots.save({
    id,
    engine: 'claude',
    kind: 'claude-sub',
    provider: 'anthropic',
    home: `/nonexistent/${fields.label}`,
    state: 'healthy',
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  })
  return id
}
