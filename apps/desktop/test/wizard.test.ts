import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HealthBoard } from '@mec/contracts'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { LoginCardManager, type PtySpawn } from '../src/login-cards'
import { buildServer, type ProbeCmd, type ServerDeps } from '../src/server'

const AT = '2026-11-03T12:00:00.000Z'

type ProbeCall = { cmd: string; args: readonly string[]; env?: Record<string, string> }

/**
 * The injected §21.3 probe seam: a table of canned outcomes keyed by command, plus a
 * record of every call so the default-home env discipline stays assertable. A command
 * with no table entry answers code -1 — what the default seam reports for ENOENT.
 */
function fakeProbe(table: Record<string, { code: number; stdout: string }>): {
  probeCmd: ProbeCmd
  calls: ProbeCall[]
} {
  const calls: ProbeCall[] = []
  const probeCmd: ProbeCmd = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env as Record<string, string> | undefined })
    const canned = table[cmd]
    return canned === undefined
      ? { code: -1, stdout: '', stderr: `${cmd}: command not found` }
      : { code: canned.code, stdout: canned.stdout, stderr: '' }
  }
  return { probeCmd, calls }
}

type SpawnCall = { cmd: string; args: string[]; env: Record<string, string>; cwd: string }

/** A pty fake for the login-card route: records the spawn, exits 0 immediately. */
function fakePtySpawn(calls: SpawnCall[]): PtySpawn {
  return (cmd, args, env, cwd) => {
    calls.push({ cmd, args, env, cwd })
    return {
      write: () => {},
      kill: () => {},
      onData: () => {},
      exitCode: Promise.resolve(0),
    }
  }
}

type TestServer = {
  store: SqliteStore
  app: ReturnType<typeof buildServer>
  db: Database.Database
  dir: string
  enginesRoot: string
}

const servers: TestServer[] = []
afterEach(async () => {
  while (servers.length > 0) {
    const ctx = servers.pop()
    if (ctx === undefined) break
    await ctx.app.close()
    ctx.db.close()
    rmSync(ctx.dir, { recursive: true, force: true })
  }
})

/**
 * The makeServer pattern (api-slots.test.ts) extended for the wizard: the probe seam is
 * injectable so no test runs a real engine binary, and an injectable pty backs the
 * login-card route when a case exercises it.
 */
function makeServer(opts: { probeCmd?: ProbeCmd; ptySpawn?: PtySpawn } = {}): TestServer {
  const dir = mkdtempSync(join(tmpdir(), `mec-wizard-${randomBytes(4).toString('hex')}-`))
  const db = new Database(join(dir, 'mec.db'))
  migrate(db, MIGRATIONS_v1)
  const store = new SqliteStore(db)
  const health: HealthBoard = {
    claim: () => ({ starting: () => {}, ready: () => {}, paused: () => {}, error: () => {} }),
  }
  const enginesRoot = join(dir, 'engines-root')
  const deps: ServerDeps = {
    store,
    effects: store.effects,
    health,
    policyText: '{"preAuthorised":{}}',
    now: () => new Date(AT),
    keystoreRoot: enginesRoot,
    ...(opts.probeCmd !== undefined && { probeCmd: opts.probeCmd }),
    ...(opts.ptySpawn !== undefined && { loginCards: new LoginCardManager({ ptySpawn: opts.ptySpawn }) }),
  }
  const ctx: TestServer = { store, app: buildServer(deps), db, dir, enginesRoot }
  servers.push(ctx)
  return ctx
}

async function postJson(
  app: ReturnType<typeof buildServer>,
  url: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; json: () => unknown }> {
  const res = await app.inject({ method: 'POST', url, payload })
  return { statusCode: res.statusCode, json: () => res.json() }
}

describe('first-run wizard routes (§21.3)', () => {
  it('engines: reports installed engines with versions and missing ones without, via the injected probe', async () => {
    const probe = fakeProbe({
      claude: { code: 0, stdout: '2.1.317 (Claude Code)\n' },
      codex: { code: -1, stdout: '' },
      opencode: { code: 0, stdout: 'opencode 2.0.5' },
    })
    const ctx = makeServer({ probeCmd: probe.probeCmd })

    const res = await ctx.app.inject({ method: 'GET', url: '/api/wizard/engines' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      { engine: 'claude', installed: true, version: '2.1.317 (Claude Code)' },
      { engine: 'codex', installed: false },
      { engine: 'opencode', installed: true, version: 'opencode 2.0.5' },
    ])
    // One local --version per engine, nothing else.
    expect(probe.calls.map((call) => [call.cmd, call.args])).toEqual([
      ['claude', ['--version']],
      ['codex', ['--version']],
      ['opencode', ['--version']],
    ])
  })

  it('existing-logins: a signed-in claude reports email and plan, probed in the DEFAULT home', async () => {
    const probe = fakeProbe({
      claude: { code: 0, stdout: '{"loggedIn":true,"email":"dev@example.com","subscriptionType":"max20"}' },
    })
    const ctx = makeServer({ probeCmd: probe.probeCmd })

    const res = await ctx.app.inject({ method: 'GET', url: '/api/wizard/existing-logins' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      claude: { engine: 'claude', loggedIn: true, email: 'dev@example.com', plan: 'max20' },
      codex: null,
      opencode: null,
    })
    // §5.3 slot-0: the default home is the variable UNSET — the probe env must not carry it.
    expect(probe.calls).toHaveLength(1)
    expect(probe.calls[0]?.args).toEqual(['auth', 'status'])
    expect(probe.calls[0]?.env?.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect('CLAUDE_CONFIG_DIR' in (probe.calls[0]?.env ?? {})).toBe(false)
  })

  it('existing-logins: logged out reports loggedIn false; a missing binary reports unknown (null)', async () => {
    const signedOut = fakeProbe({ claude: { code: 0, stdout: '{"loggedIn":false}' } })
    const ctxOut = makeServer({ probeCmd: signedOut.probeCmd })
    const out = await ctxOut.app.inject({ method: 'GET', url: '/api/wizard/existing-logins' })
    expect(out.json()).toEqual({
      claude: { engine: 'claude', loggedIn: false },
      codex: null,
      opencode: null,
    })

    const missing = fakeProbe({})
    const ctxMissing = makeServer({ probeCmd: missing.probeCmd })
    const res = await ctxMissing.app.inject({ method: 'GET', url: '/api/wizard/existing-logins' })
    expect(res.json()).toEqual({ claude: null, codex: null, opencode: null })
  })

  it('repositories: happy path saves the doc, lists it and flips has_repository', async () => {
    const ctx = makeServer()
    const workdir = mkdtempSync(join(tmpdir(), 'mec-wizard-repo-'))
    try {
      const res = await postJson(ctx.app, '/api/repositories', {
        urlOrPath: workdir,
        bootstrapCmds: ['pnpm install'],
        checkCmds: [{ name: 'typecheck', cmd: 'pnpm exec tsc --noEmit' }],
        trusted: false,
      })
      expect(res.statusCode).toBe(200)
      const saved = res.json() as {
        id: string
        url: string
        bootstrap: string[]
        checks: Array<{ name: string; cmd: string }>
        trust: boolean
      }
      expect(saved.id).toMatch(/^repo_/)
      expect(saved).toMatchObject({
        url: workdir,
        bootstrap: ['pnpm install'],
        checks: [{ name: 'typecheck', cmd: 'pnpm exec tsc --noEmit' }],
        trust: false,
      })
      expect(ctx.store.engines.get(saved.id)).toMatchObject({ url: workdir, trust: false })

      const list = await ctx.app.inject({ method: 'GET', url: '/api/repositories' })
      const entries = list.json() as Array<{ id: string }>
      expect(entries).toHaveLength(1)
      expect(entries[0]?.id).toBe(saved.id)

      // §21.2: the settings/repositories marker makes has_repository true.
      const status = await ctx.app.inject({ method: 'GET', url: '/api/status' })
      expect((status.json() as { setup: { has_repository: boolean } }).setup.has_repository).toBe(true)
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })

  it('repositories: an https URL with credentials is rejected; a clean one registers', async () => {
    const ctx = makeServer()
    const bad = await postJson(ctx.app, '/api/repositories', {
      urlOrPath: 'https://user:token@github.com/acme/ws.git',
      bootstrapCmds: [],
      checkCmds: [],
      trusted: false,
    })
    expect(bad.statusCode).toBe(400)
    expect((bad.json() as { error: string }).error).toMatch(/credential/)

    const good = await postJson(ctx.app, '/api/repositories', {
      urlOrPath: 'https://github.com/acme/ws.git',
      bootstrapCmds: [],
      checkCmds: [],
      trusted: false,
    })
    expect(good.statusCode).toBe(200)
  })

  it('repositories: shell-metachar commands are rejected and nothing is saved', async () => {
    const ctx = makeServer()
    const bootstrap = await postJson(ctx.app, '/api/repositories', {
      urlOrPath: 'https://github.com/acme/ws.git',
      bootstrapCmds: ['pnpm install; rm -rf /'],
      checkCmds: [],
      trusted: false,
    })
    expect(bootstrap.statusCode).toBe(400)
    expect((bootstrap.json() as { error: string }).error).toMatch(/argv/)

    const check = await postJson(ctx.app, '/api/repositories', {
      urlOrPath: 'https://github.com/acme/ws.git',
      bootstrapCmds: [],
      checkCmds: [{ name: 'tests', cmd: 'pnpm test && echo done' }],
      trusted: false,
    })
    expect(check.statusCode).toBe(400)
    expect((check.json() as { error: string }).error).toMatch(/argv/)

    const list = await ctx.app.inject({ method: 'GET', url: '/api/repositories' })
    expect(list.json()).toEqual([])
    const status = await ctx.app.inject({ method: 'GET', url: '/api/status' })
    expect((status.json() as { setup: { has_repository: boolean } }).setup.has_repository).toBe(false)
  })

  it('repositories: a missing local path (and a plain http URL) is rejected', async () => {
    const ctx = makeServer()
    const missing = await postJson(ctx.app, '/api/repositories', {
      urlOrPath: '/definitely/not/a/real/path',
      bootstrapCmds: [],
      checkCmds: [],
      trusted: true,
    })
    expect(missing.statusCode).toBe(400)
    expect((missing.json() as { error: string }).error).toMatch(/does not exist/)

    const http = await postJson(ctx.app, '/api/repositories', {
      urlOrPath: 'http://github.com/acme/ws.git',
      bootstrapCmds: [],
      checkCmds: [],
      trusted: true,
    })
    expect(http.statusCode).toBe(400)
    expect((http.json() as { error: string }).error).toMatch(/https/)
  })

  it('slots/link: creates a home_ready slot doc referencing the default home, env unset', async () => {
    const ctx = makeServer()
    const res = await postJson(ctx.app, '/api/slots/link', { engine: 'claude', label: 'max-0' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      id: 'slot_max-0',
      label: 'max-0',
      engine: 'claude',
      kind: 'claude-sub',
      state: 'home_ready',
      home: join(homedir(), '.claude'),
    })

    const doc = ctx.store.slots.get('slot_max-0')
    expect(doc).toMatchObject({
      engine: 'claude',
      kind: 'claude-sub',
      provider: 'anthropic',
      linkedDefault: true,
      env: {},
      state: 'home_ready',
      home: join(homedir(), '.claude'),
    })

    // §21.2: the slot doc flips has_slot on.
    const status = await ctx.app.inject({ method: 'GET', url: '/api/status' })
    expect((status.json() as { setup: { has_slot: boolean } }).setup.has_slot).toBe(true)

    const duplicate = await postJson(ctx.app, '/api/slots/link', { engine: 'claude', label: 'max-0' })
    expect(duplicate.statusCode).toBe(409)
    const otherEngine = await postJson(ctx.app, '/api/slots/link', { engine: 'codex', label: 'cx-0' })
    expect(otherEngine.statusCode).toBe(400)
    expect((otherEngine.json() as { error: string }).error).toMatch(/v0/)
  })

  it('meta-slot: persists the choice, GET returns it, an unknown slot is refused', async () => {
    const ctx = makeServer()
    const empty = await ctx.app.inject({ method: 'GET', url: '/api/wizard/meta-slot' })
    expect(empty.json()).toEqual({ slotId: null })

    await postJson(ctx.app, '/api/slots/link', { engine: 'claude', label: 'max-0' })

    const unknown = await postJson(ctx.app, '/api/wizard/meta-slot', { slotId: 'slot_none' })
    expect(unknown.statusCode).toBe(400)

    // M3.3 §6: a link that has not passed a probe is not usable yet.
    const unprobed = await postJson(ctx.app, '/api/wizard/meta-slot', { slotId: 'slot_max-0' })
    expect(unprobed.statusCode).toBe(400)
    const linked = ctx.store.slots.get('slot_max-0')
    if (linked === undefined) throw new Error('the link wrote no slot')
    ctx.store.slots.save({ ...linked, state: 'healthy' })

    const res = await postJson(ctx.app, '/api/wizard/meta-slot', { slotId: 'slot_max-0' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: 'settings/meta-slot', slotId: 'slot_max-0' })
    expect(ctx.store.engines.get('settings/meta-slot')).toMatchObject({ slotId: 'slot_max-0' })

    const got = await ctx.app.inject({ method: 'GET', url: '/api/wizard/meta-slot' })
    expect(got.json()).toEqual({ slotId: 'slot_max-0' })
  })

  it('slots/login: a label resolves a dedicated home under the keystore root', async () => {
    const spawns: SpawnCall[] = []
    const ctx = makeServer({ ptySpawn: fakePtySpawn(spawns) })

    const res = await postJson(ctx.app, '/api/slots/login', { engine: 'claude', label: 'dev-1' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ busy: false })

    const expectedHome = join(ctx.enginesRoot, 'engines', 'claude', 'dev-1')
    expect(spawns).toHaveLength(1)
    expect(spawns[0]?.cmd).toBe('claude')
    expect(spawns[0]?.args).toEqual(['auth', 'login'])
    expect(spawns[0]?.env.CLAUDE_CONFIG_DIR).toBe(expectedHome)
    expect(spawns[0]?.cwd).toBe(expectedHome)
  })
})
