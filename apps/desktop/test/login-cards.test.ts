import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { HealthBoard, Store } from '@mec/contracts'
import { MemoryRepositories } from '@mec/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type CardEvent, LoginCardManager, type PtyProcess, type PtySpawn } from '../src/login-cards'
import { buildServer, type ServerDeps } from '../src/server'
import { type ConfigServer, makeConfigServer } from './config-server'

/** Flushes pending microtasks (exitCode resolutions, .then callbacks). */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

type SpawnCall = { cmd: string; args: string[]; env: Record<string, string>; cwd: string }

/** The injected pty: records spawn calls, kills and writes; emits and exits on demand. */
class FakePty implements PtyProcess {
  killed = false
  readonly writes: string[] = []
  private dataCb: ((data: string) => void) | undefined
  private settle: ((code: number) => void) | undefined
  readonly exitCode: Promise<number>

  constructor() {
    this.exitCode = new Promise((resolve) => {
      this.settle = resolve
    })
  }

  write(input: string): void {
    this.writes.push(input)
  }

  kill(): void {
    this.killed = true
    this.settle?.(137) // a killed process does die — the manager must suppress that exit
  }

  onData(callback: (data: string) => void): void {
    this.dataCb = callback
  }

  emit(data: string): void {
    this.dataCb?.(data)
  }

  exit(code: number): void {
    this.settle?.(code)
  }
}

function fakePtyFactory(): { spawn: PtySpawn; spawned: FakePty[]; calls: SpawnCall[] } {
  const spawned: FakePty[] = []
  const calls: SpawnCall[] = []
  const spawn: PtySpawn = (cmd, args, env, cwd) => {
    calls.push({ cmd, args, env, cwd })
    const pty = new FakePty()
    spawned.push(pty)
    return pty
  }
  return { spawn, spawned, calls }
}

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), `mec-login-home-${randomBytes(4).toString('hex')}-`))
}

describe('LoginCardManager (§5.6)', () => {
  it('runs the vendor login command in the slot env and reports url then exit', async () => {
    const home = tmpHome()
    const fake = fakePtyFactory()
    const manager = new LoginCardManager({ ptySpawn: fake.spawn })
    const events: CardEvent[] = []

    const started = manager.start({ engine: 'claude', slotHome: home }, (event) => events.push(event))
    expect(started.busy).toBe(false)
    expect(started.id).toMatch(/^login_/)
    expect(manager.active()).toEqual({ id: started.id, req: { engine: 'claude', slotHome: home } })
    expect(fake.calls[0]).toMatchObject({ cmd: 'claude', args: ['auth', 'login'] })
    expect(fake.calls[0]?.env.CLAUDE_CONFIG_DIR).toBe(home)

    const pty = fake.spawned[0]!
    pty.emit('Visit https://claude.ai/oauth/authorize?code=X-1 to sign in\r\n')
    // Same URL printed again (ANSI-coloured this time): still reported once.
    pty.emit('\u001b[1mVisit https://claude.ai/oauth/authorize?code=X-1 to sign in\u001b[0m\r\n')
    pty.exit(0)
    await settled()

    expect(events.filter((event) => event.kind !== 'output')).toEqual([
      { kind: 'url', url: 'https://claude.ai/oauth/authorize?code=X-1' },
      { kind: 'exit', code: 0 },
    ])
    expect(events.filter((event) => event.kind === 'output')).toHaveLength(2)
    expect(manager.active()).toBe(null)
  })

  it('serialises logins: a second start is busy with the same id; after exit a fresh id', async () => {
    const fake = fakePtyFactory()
    const manager = new LoginCardManager({ ptySpawn: fake.spawn })

    const first = manager.start({ engine: 'codex', slotHome: tmpHome() }, () => {})
    expect(first.busy).toBe(false)
    expect(fake.calls[0]?.env.CODEX_HOME).toBe(manager.active()?.req.slotHome)

    const second = manager.start({ engine: 'claude', slotHome: tmpHome() }, () => {})
    expect(second).toEqual({ id: first.id, busy: true })
    expect(fake.spawned).toHaveLength(1) // nothing was spawned for the refused request

    fake.spawned[0]!.exit(0)
    await settled()
    expect(manager.active()).toBe(null)

    const third = manager.start({ engine: 'claude', slotHome: tmpHome() }, () => {})
    expect(third.busy).toBe(false)
    expect(third.id).not.toBe(first.id)
    expect(fake.spawned).toHaveLength(2)
    manager.cancel(third.id)
  })

  it('is bounded: a silent card is killed at timeoutMs and reports timeout, not exit', async () => {
    const fake = fakePtyFactory()
    const manager = new LoginCardManager({ timeoutMs: 50, ptySpawn: fake.spawn })
    const events: CardEvent[] = []

    manager.start({ engine: 'claude', slotHome: tmpHome() }, (event) => events.push(event))
    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === 'timeout')).toBe(true)
    })

    const pty = fake.spawned[0]!
    expect(pty.killed).toBe(true)
    await settled()
    expect(events.filter((event) => event.kind === 'exit')).toEqual([])
    expect(manager.active()).toBe(null)
  })

  it('cancel kills the pty and suppresses the exit event', async () => {
    const home = tmpHome()
    const fake = fakePtyFactory()
    const manager = new LoginCardManager({ ptySpawn: fake.spawn })
    const events: CardEvent[] = []

    const { id } = manager.start({ engine: 'opencode', slotHome: home }, (event) => events.push(event))
    const env = fake.calls[0]?.env ?? {}
    expect(env.XDG_DATA_HOME).toBe(join(home, 'data'))
    expect(env.XDG_CONFIG_HOME).toBe(join(home, 'config'))
    expect(env.XDG_STATE_HOME).toBe(join(home, 'state'))
    expect(env.XDG_CACHE_HOME).toBe(join(home, 'cache'))
    expect(env.OPENCODE_CONFIG_DIR).toBe(join(home, 'config'))
    expect(fake.calls[0]?.cwd).toBe(home) // default cwd is the slot home

    const pty = fake.spawned[0]!
    manager.cancel('login_unknown') // unknown id: a no-op, the card keeps running
    expect(pty.killed).toBe(false)

    manager.cancel(id)
    expect(pty.killed).toBe(true)
    await settled()
    expect(events).toEqual([]) // the canceller knows; nobody is told the card "exited"
    expect(manager.active()).toBe(null)
  })

  it('subscribes live-only: a late subscriber sees new output, never a replay', async () => {
    const fake = fakePtyFactory()
    const manager = new LoginCardManager({ ptySpawn: fake.spawn })
    const events: CardEvent[] = []
    manager.start({ engine: 'claude', slotHome: tmpHome() }, (event) => events.push(event))
    const pty = fake.spawned[0]!
    pty.emit('first line with https://claude.ai/oauth/authorize?code=X-1\r\n')

    const late: CardEvent[] = []
    const detach = manager.subscribe((event) => late.push(event))
    expect(detach).toBeInstanceOf(Function)
    pty.emit('second line\r\n')
    pty.exit(0)
    await settled()

    expect(late.some((event) => event.kind === 'url')).toBe(false) // nothing replayed
    expect(late.at(-1)).toEqual({ kind: 'exit', code: 0 })
    detach?.()
  })

  it('reports exit only once the after-exit check settles, and still ends when the check fails', async () => {
    const fake = fakePtyFactory()
    const manager = new LoginCardManager({ ptySpawn: fake.spawn })
    let release: () => void = () => {}
    const checked = new Promise<void>((resolve) => {
      release = resolve
    })
    const events: CardEvent[] = []
    const codes: number[] = []
    manager.start(
      { engine: 'codex', slotHome: tmpHome() },
      (event) => events.push(event),
      async (code) => {
        codes.push(code)
        await checked
      },
    )
    fake.spawned[0]?.exit(0)
    await settled()
    expect(codes).toEqual([0])
    expect(events).toEqual([]) // the card has not ended for anyone yet
    expect(manager.active()).toBe(null) // but the machine is free for the next login
    release()
    await settled()
    expect(events).toEqual([{ kind: 'exit', code: 0 }])

    const failing: CardEvent[] = []
    manager.start(
      { engine: 'codex', slotHome: tmpHome() },
      (event) => failing.push(event),
      async () => {
        throw new Error('the status command broke')
      },
    )
    fake.spawned[1]?.exit(1)
    await settled()
    expect(failing).toEqual([{ kind: 'exit', code: 1 }])
  })

  it('never writes to disk: a login run with a tmpdir cwd leaves both it and the home empty', async () => {
    const cwd = mkdtempSync(join(tmpdir(), `mec-login-cwd-${randomBytes(4).toString('hex')}-`))
    const home = tmpHome()
    const fake = fakePtyFactory()
    const manager = new LoginCardManager({ cwd, ptySpawn: fake.spawn })

    manager.start({ engine: 'claude', slotHome: home }, () => {})
    expect(fake.calls[0]?.cwd).toBe(cwd)
    const pty = fake.spawned[0]!
    pty.emit('Visit https://claude.ai/oauth/authorize?code=Y to sign in\r\n')
    pty.exit(0)
    await settled()

    expect(readdirSync(cwd)).toEqual([]) // §5.6: the login stream is never persisted
    expect(readdirSync(home)).toEqual([]) // and the pre-existing claude home gained nothing
  })
})

describe('login card routes (§5.6)', () => {
  const apps: Array<ReturnType<typeof buildServer>> = []

  afterEach(async () => {
    for (const app of apps) await app.close()
    apps.length = 0
  })

  function makeServer(): { app: ReturnType<typeof buildServer>; manager: LoginCardManager } {
    const fake = fakePtyFactory()
    const manager = new LoginCardManager({ ptySpawn: fake.spawn })
    const store: Store = new MemoryRepositories()
    const health: HealthBoard = {
      claim: () => ({ starting: () => {}, ready: () => {}, paused: () => {}, error: () => {} }),
    }
    const deps: ServerDeps = {
      store,
      effects: store.effects,
      health,
      policyText: '{"preAuthorised":{}}',
      loginCards: manager,
    }
    const app = buildServer(deps)
    apps.push(app)
    return { app, manager }
  }

  it('POST /api/slots/login starts a card; a second POST is busy with the same id', async () => {
    const { app } = makeServer()
    const first = await app.inject({
      method: 'POST',
      url: '/api/slots/login',
      payload: { engine: 'codex', slotHome: tmpHome() },
    })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ busy: false })

    const second = await app.inject({
      method: 'POST',
      url: '/api/slots/login',
      payload: { engine: 'claude', slotHome: tmpHome() },
    })
    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual({ id: first.json().id, busy: true })
  })

  it('POST /api/slots/login validates engine and slotHome', async () => {
    const { app } = makeServer()
    const badEngine = await app.inject({
      method: 'POST',
      url: '/api/slots/login',
      payload: { engine: 'gemini', slotHome: tmpHome() },
    })
    expect(badEngine.statusCode).toBe(400)
    const noHome = await app.inject({
      method: 'POST',
      url: '/api/slots/login',
      payload: { engine: 'claude' },
    })
    expect(noHome.statusCode).toBe(400)
  })

  it('GET /api/slots/login/current is SSE while a card runs, 404 when idle', async () => {
    const { app } = makeServer()
    const idle = await app.inject({ method: 'GET', url: '/api/slots/login/current' })
    expect(idle.statusCode).toBe(404)

    await app.inject({
      method: 'POST',
      url: '/api/slots/login',
      payload: { engine: 'claude', slotHome: tmpHome() },
    })
    const live = await app.inject({ method: 'GET', url: '/api/slots/login/current' })
    expect(live.statusCode).toBe(200)
    expect(live.headers['content-type']).toContain('text/event-stream')
  })

  it('POST /api/slots/login/cancel cancels the running card; afterwards /current is 404', async () => {
    const { app, manager } = makeServer()
    const started = await app.inject({
      method: 'POST',
      url: '/api/slots/login',
      payload: { engine: 'opencode', slotHome: tmpHome() },
    })
    const { id } = started.json() as { id: string }

    const wrongId = await app.inject({
      method: 'POST',
      url: '/api/slots/login/cancel',
      payload: { id: 'login_unknown' },
    })
    expect(wrongId.statusCode).toBe(404)

    const cancelled = await app.inject({
      method: 'POST',
      url: '/api/slots/login/cancel',
      payload: { id },
    })
    expect(cancelled.statusCode).toBe(204)
    expect(manager.active()).toBe(null)
    const after = await app.inject({ method: 'GET', url: '/api/slots/login/current' })
    expect(after.statusCode).toBe(404)
  })
})

describe('a finished sign-in checks its own connection (§5.6 "the subsequent probe result")', () => {
  const servers: ConfigServer[] = []
  afterEach(async () => {
    while (servers.length > 0) await servers.pop()?.close()
  })

  /** A config server whose login cards run on the fake pty; Codex's status says signed in. */
  function signInServer(): {
    ctx: ConfigServer
    manager: LoginCardManager
    fake: ReturnType<typeof fakePtyFactory>
    probes: string[]
  } {
    const fake = fakePtyFactory()
    const manager = new LoginCardManager({ ptySpawn: fake.spawn })
    const ctx = makeConfigServer({ loginCards: manager })
    servers.push(ctx)
    const probes: string[] = []
    ctx.setProbe(async (cmd, args) => {
      probes.push(`${cmd} ${args.join(' ')}`)
      return args[0] === 'login'
        ? { code: 0, stdout: '', stderr: 'Logged in using ChatGPT' }
        : { code: 0, stdout: `${cmd} 9.9.9\n`, stderr: '' }
    })
    return { ctx, manager, fake, probes }
  }

  it('a Codex sign-in that exits turns its new connection Healthy with no Check again', async () => {
    const { ctx, manager, fake, probes } = signInServer()
    await ctx.post('/api/slots/dedicated', { engine: 'codex', label: 'cx' })
    expect(ctx.store.slots.get('slot_cx')).toMatchObject({ state: 'home_ready' })
    await ctx.post('/api/slots/login', { engine: 'codex', label: 'cx' })
    const seen: Array<{ event: CardEvent; state: unknown }> = []
    manager.subscribe((event) => seen.push({ event, state: ctx.store.slots.get('slot_cx')?.state }))

    fake.spawned[0]?.exit(0)
    await vi.waitFor(() => expect(seen.at(-1)?.event).toEqual({ kind: 'exit', code: 0 }))

    expect(probes).toContain('codex login status')
    expect(ctx.store.slots.get('slot_cx')).toMatchObject({ state: 'healthy' })
    expect(ctx.store.events.read('slot:cx').map((event) => event.type)).toContain('slot_healthy')
    // The card's end reaches the page only once the check is saved, so a refresh then reads Healthy.
    expect(seen.at(-1)?.state).toBe('healthy')
  })

  it('a sign-in that is cancelled checks nothing', async () => {
    const { ctx, fake, probes } = signInServer()
    await ctx.post('/api/slots/dedicated', { engine: 'codex', label: 'cx' })
    const started = (await ctx.post('/api/slots/login', { engine: 'codex', label: 'cx' })).json() as {
      id: string
    }
    await ctx.post('/api/slots/login/cancel', { id: started.id })
    await settled()
    expect(fake.spawned[0]?.killed).toBe(true)
    expect(probes.filter((probe) => probe.includes('login status'))).toEqual([])
    expect(ctx.store.slots.get('slot_cx')).toMatchObject({ state: 'home_ready' })
  })
})

describe('the pty helper (npm and pnpm unpack the macOS prebuild without its execute bit)', () => {
  const helperIn = (mode: number): { dir: string; helper: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'mec-pty-helper-'))
    const helper = join(dir, 'prebuilds', 'darwin-arm64', 'spawn-helper')
    mkdirSync(dirname(helper), { recursive: true })
    writeFileSync(helper, '')
    chmodSync(helper, mode)
    return { dir, helper }
  }

  it('restores the bit and keeps the rest of the mode', async () => {
    const { makeSpawnHelperExecutable } = await import('../src/login-cards')
    const { dir, helper } = helperIn(0o644)
    makeSpawnHelperExecutable(dir, 'darwin-arm64')
    expect(statSync(helper).mode & 0o777).toBe(0o755)
  })

  it('leaves a helper it can already run alone', async () => {
    const { makeSpawnHelperExecutable } = await import('../src/login-cards')
    const { dir, helper } = helperIn(0o700)
    makeSpawnHelperExecutable(dir, 'darwin-arm64')
    expect(statSync(helper).mode & 0o777).toBe(0o700)
  })

  it('does nothing where the platform has no prebuilt helper', async () => {
    const { makeSpawnHelperExecutable } = await import('../src/login-cards')
    const { dir } = helperIn(0o644)
    expect(() => makeSpawnHelperExecutable(dir, 'linux-x64')).not.toThrow()
  })
})

describe('the real node-pty (R1.3)', () => {
  it('drives a real interactive shell through the seam (no vendor command)', async () => {
    const { nodePtySpawn } = await import('../src/login-cards')
    const proc = nodePtySpawn('/bin/sh', ['-i'], { TERM: 'xterm' } as Record<string, string>, tmpdir())
    let out = ''
    proc.onData((d) => {
      out += d
    })
    proc.write('echo PTY-SEAM-OK\n')
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 15000
      const timer = setInterval(() => {
        if (out.includes('PTY-SEAM-OK') || Date.now() > deadline) {
          clearInterval(timer)
          resolve()
        }
      }, 50)
    })
    proc.write('exit 0\n')
    const code = await proc.exitCode
    expect(out).toContain('PTY-SEAM-OK')
    expect(code).toBe(0)
  }, 30000)
})
