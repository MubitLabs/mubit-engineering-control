/**
 * Login terminal cards — plan §5.6 "Terminal card".
 *
 * One card at a time runs the vendor's own login command inside a slot's
 * environment (§5.3 home vars), so the user signs in through the vendor's flow
 * and MEC never sees a credential. The card is:
 *
 * - **Serialised** — one login per machine (vendor CLIs share fixed loopback
 *   callback ports); a second `start()` while one runs returns the running
 *   card's id with `busy: true` and spawns nothing.
 * - **Bounded** — a card is killed after `timeoutMs` (default ten minutes) and
 *   reports `timeout`; `cancel(id)` kills it the same way, silently.
 * - **Never persisted** — the login stream goes to live `onData`/`subscribe`
 *   listeners only: no journal, no transcript, no replay buffer, no file. §5.6:
 *   "The login stream is never journaled or persisted; MEC records only the
 *   exit code and the subsequent probe result." A late subscriber gets nothing
 *   replayed — the stream is live-only.
 *
 * The pty itself is injected (`ptySpawn`). The plan §21.7 pins
 * `node-pty-prebuilt-multiarch` (^1.0.0-beta) for the default — a NATIVE
 * module that must stay EXTERNAL to any bundle — but no 1.x release exists in
 * the registry yet (latest 0.10.1-pre.5, checked 3 Nov 2026), so until that
 * pin resolves the default spawn throws and every caller (tests, the
 * composition root) supplies a spawn.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Which engine's CLI to drive, and the slot home its env must point at. */
export type LoginRequest = {
  engine: 'claude' | 'codex' | 'opencode'
  /** The slot's home directory (`EngineHome.homeDir` from `@mec/slots`, §5.3). */
  slotHome: string
}

/** What a card reports. Output and URLs flow as they happen; exit/timeout ends the card. */
export type CardEvent =
  | { kind: 'output'; data: string }
  | { kind: 'exit'; code: number }
  | { kind: 'timeout' }
  | { kind: 'url'; url: string }

/** The pty seam a card drives; `exitCode` settles exactly once when the process dies. */
export type PtyProcess = {
  write(input: string): void
  kill(): void
  onData(callback: (data: string) => void): void
  exitCode: Promise<number>
}

/**
 * Spawns `cmd` in a pty under `env`, working out of `cwd`. The default is the
 * plan's native module (see the module comment) — inject a fake in tests.
 */
export type PtySpawn = (cmd: string, args: string[], env: Record<string, string>, cwd: string) => PtyProcess

export type LoginCardManagerOptions = {
  /** §5.6 "Bounded": ten minutes by default. */
  timeoutMs?: number
  /** The pty's working directory; defaults to the request's slot home. */
  cwd?: string
  /** The pty factory; tests inject a fake. */
  ptySpawn?: PtySpawn
}

/**
 * The vendor's own login command (§5.6) plus the slot-home env vars for one
 * engine. These mirror `claudeHome`/`codexHome`/`opencodeHome` in
 * `packages/slots/src/homes.ts` — those take a root + slot name, while a card
 * is handed the home directory directly, so the vars are mirrored here and the
 * directories are created eagerly exactly as there (0o700; Codex refuses to
 * launch when `CODEX_HOME` does not exist).
 */
const ENGINE_LOGIN: Record<
  LoginRequest['engine'],
  { cmd: string; args: string[]; envFor: (slotHome: string) => Record<string, string> }
> = {
  claude: {
    cmd: 'claude',
    args: ['auth', 'login'],
    envFor: (slotHome) => ({ CLAUDE_CONFIG_DIR: slotHome }),
  },
  codex: {
    cmd: 'codex',
    args: ['login'],
    envFor: (slotHome) => ({ CODEX_HOME: slotHome }),
  },
  opencode: {
    cmd: 'opencode',
    args: ['auth', 'login', '--standalone'],
    envFor: (slotHome) => ({
      XDG_DATA_HOME: join(slotHome, 'data'),
      XDG_CONFIG_HOME: join(slotHome, 'config'),
      XDG_STATE_HOME: join(slotHome, 'state'),
      XDG_CACHE_HOME: join(slotHome, 'cache'),
      OPENCODE_CONFIG_DIR: join(slotHome, 'config'),
    }),
  },
}

/** §5.6 says MEC opens the login URL in the user's browser; this finds it in the stream. */
const URL_PATTERN = /https:\/\/\S+/g

/** Vendor CLIs colour their output; URLs are matched on visible text, not escape sequences. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: a CSI sequence starts with ESC — that is the thing being stripped.
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

type RunningCard = {
  id: string
  req: LoginRequest
  listeners: Set<(event: CardEvent) => void>
  proc: PtyProcess
  timer: ReturnType<typeof setTimeout> | undefined
  urls: Set<string>
  /** A terminal event was emitted (or the card was cancelled): report nothing further. */
  done: boolean
}

/**
 * Runs one vendor login at a time (§5.6). All output stays in memory, in the
 * card's live listeners — this class never writes login bytes anywhere.
 */
export class LoginCardManager {
  private current: RunningCard | null = null

  constructor(private readonly opts: LoginCardManagerOptions = {}) {}

  /**
   * Starts a login card for `req`. While a card runs, the call is refused, not
   * queued: it returns the running card's id with `busy: true` (the §5.6 queue
   * lives in the UI, which keeps the refused request). `onData` becomes the
   * card's first live subscriber.
   */
  start(req: LoginRequest, onData: (event: CardEvent) => void): { id: string; busy: boolean } {
    if (this.current !== null) return { id: this.current.id, busy: true }

    const engine = ENGINE_LOGIN[req.engine]
    const env: Record<string, string> = {}
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined) env[name] = value
    }
    Object.assign(env, engine.envFor(req.slotHome))

    // Spawn before anything is registered: a failed spawn (missing binary,
    // missing pty) is a caller-visible error, not a card event — nothing ran,
    // so nothing can be reported.
    const proc = (this.opts.ptySpawn ?? nodePtySpawn)(
      engine.cmd,
      engine.args,
      env,
      this.opts.cwd ?? req.slotHome,
    )
    const card: RunningCard = {
      id: `login_${randomBytes(6).toString('hex')}`,
      req,
      listeners: new Set([onData]),
      urls: new Set(),
      done: false,
      proc,
      timer: undefined,
    }
    // The slot home must exist before the process starts (§5.3, Codex). It is
    // idempotent — the slots layer created it at `home_created` — and it is a
    // directory, never login output.
    mkdirSlotHome(req)
    card.timer = setTimeout(() => this.expire(card), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    card.timer.unref()
    this.current = card
    proc.onData((data) => this.onChunk(card, data))
    void proc.exitCode.then((code) => this.onExit(card, code))
    return { id: card.id, busy: false }
  }

  /** The running card, or null when the machine is idle. */
  active(): { id: string; req: LoginRequest } | null {
    return this.current === null ? null : { id: this.current.id, req: this.current.req }
  }

  /**
   * Attaches a live subscriber to the running card; returns a detach function,
   * or null when no card is running. §5.6: the stream is live-only — there is
   * no backlog, so there is nothing to replay to a late subscriber.
   */
  subscribe(onEvent: (event: CardEvent) => void): (() => void) | null {
    if (this.current === null) return null
    this.current.listeners.add(onEvent)
    return () => {
      this.current?.listeners.delete(onEvent)
    }
  }

  /**
   * Kills the card's pty (§5.6 "cancel kills the process group"). The kill
   * suppresses the exit event — the canceller already knows the card is gone;
   * nobody else is told a cancelled login "exited".
   */
  cancel(id: string): void {
    const card = this.current
    if (card === null || card.id !== id || card.done) return
    card.done = true
    clearTimeout(card.timer)
    this.current = null
    card.proc.kill()
  }

  private onChunk(card: RunningCard, data: string): void {
    if (card.done) return
    this.emit(card, { kind: 'output', data })
    const visible = data.replace(ANSI_CSI, '')
    for (const url of visible.match(URL_PATTERN) ?? []) {
      if (card.urls.has(url)) continue // once per distinct URL per card
      card.urls.add(url)
      this.emit(card, { kind: 'url', url })
    }
  }

  private expire(card: RunningCard): void {
    if (card.done) return
    card.done = true
    this.clearIfCurrent(card)
    card.proc.kill()
    this.emit(card, { kind: 'timeout' })
  }

  private onExit(card: RunningCard, code: number): void {
    if (card.done) return
    card.done = true
    this.clearIfCurrent(card)
    this.emit(card, { kind: 'exit', code })
  }

  private clearIfCurrent(card: RunningCard): void {
    if (this.current === card) this.current = null
  }

  private emit(card: RunningCard, event: CardEvent): void {
    for (const listener of card.listeners) listener(event)
  }
}

/**
 * node-pty's macOS prebuild carries a `spawn-helper` it executes for every pty, and npm and pnpm
 * both unpack it without the execute bit, so the first spawn dies with `posix_spawnp failed`. Its
 * own install script does not repair it. Platforms without a prebuilt helper have nothing to do.
 */
export function makeSpawnHelperExecutable(
  ptyDir: string,
  target = `${process.platform}-${process.arch}`,
): void {
  const helper = join(ptyDir, 'prebuilds', target, 'spawn-helper')
  const stat = statSync(helper, { throwIfNoEntry: false })
  if (stat !== undefined && (stat.mode & 0o111) === 0) chmodSync(helper, stat.mode | 0o111)
}

/**
 * The default spawn until the plan's pinned prebuilt pty release exists (§21.7
 * pins `node-pty-prebuilt-multiarch` ^1.0.0-beta; no such version is published
 * as of 3 Nov 2026). Fails loudly and before any card is registered, so a
 * missing pty can never look like a silent login failure.
 */
/**
 * The real pty: node-pty 1.1.x (plan §21.7 primary pin). The native module builds via
 * node-gyp when no prebuild matches the platform — the postinstall allowlist in the root
 * package.json covers it; a machine without a build toolchain fails LOUDLY here, never
 * silently (the login card shows the error).
 */
export function nodePtySpawn(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
): PtyProcess {
  // Deferred require: a missing/broken native module must surface at card start, not import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require('node-pty') as {
    spawn: (
      c: string,
      a: string[],
      o: { name: string; cwd: string; env: Record<string, string> },
    ) => {
      onData(cb: (d: string) => void): void
      onExit(cb: (e: { exitCode: number }) => void): void
      write(data: string): void
      kill(signal?: string): void
    }
  }
  makeSpawnHelperExecutable(dirname(dirname(require.resolve('node-pty'))))
  const proc = pty.spawn(cmd, args, { name: 'xterm-256color', cwd, env })
  let exited: (code: number) => void
  const exitCode = new Promise<number>((resolve) => {
    exited = resolve
  })
  proc.onExit(({ exitCode: code }) => exited(code))
  return {
    write: (data) => proc.write(data),
    kill: () => proc.kill(),
    onData: (cb) => proc.onData(cb),
    exitCode,
  }
}

/** Creates the slot home's directories exactly like `@mec/slots` homes do (§5.3). */
function mkdirSlotHome(req: LoginRequest): void {
  if (req.engine === 'opencode') {
    for (const sub of ['data', 'config', 'state', 'cache']) {
      mkdirSync(join(req.slotHome, sub), { recursive: true, mode: 0o700 })
    }
    return
  }
  mkdirSync(req.slotHome, { recursive: true, mode: 0o700 })
}
