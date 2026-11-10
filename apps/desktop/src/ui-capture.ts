/**
 * One revision's screenshots, taken by MEC (spec §15): never by an engine, which may have no
 * shell (OpenCode) or no network (Codex, Claude). The revision is exported from the clone with
 * `git archive`, so nothing touches a worktree and nothing here can enter a commit. The real
 * application answers on loopback: the repository's own start command when it registers one (it
 * runs on this machine, so it needs the owner's agreement, as checks do), else MEC serves the
 * revision's files from a port it picks. Chromium is Playwright's, loaded only when needed.
 *
 * - **No channel out of the page (§13, hard invariant 1).** Page script may be an engine's work, and
 *   the engine had no network: the browser must not give it one. Three fences, so no one of them is
 *   the only thing standing:
 *   1. Chromium's only proxy is a fence MEC runs on loopback, with no bypass (Playwright adds
 *      `<-loopback>`, so loopback goes through it too). It forwards to the app's own host and port
 *      and refuses everything else, whatever opened it: a redirect, a WebSocket (a CONNECT), a
 *      subresource. A port-specific bypass would be simpler, but Chromium ignores the port on an IP
 *      literal, which would let every loopback port through.
 *   2. WebRTC may send UDP only through the proxy, and an HTTP proxy carries none: no STUN leaves.
 *   3. Each request and WebSocket the page makes to another origin is refused before it starts.
 * - **Bounded.** One viewport, at most `MAX_PATHS` paths, each PNG at most `MAX_PNG_BYTES`.
 * - **Never a pass by failing.** Anything that goes wrong is a `could_not` with its reason in
 *   words: the archive, the app, Chromium, a page, a size.
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { type AddressInfo, connect as netConnect, type Socket } from 'node:net'
import { extname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { UI_VIEWPORT, type UiEvidenceSetting, type UiShot, type UiSide } from '@mec/domain'
import { git } from '@mec/git'
import { runCheck } from '@mec/runtime'
import { argvOf } from './attempt-launch'

const exec = promisify(execFile)

/** A viewport PNG of 1280x800 is well under this; a page that makes one larger is not normal. */
export const MAX_PNG_BYTES = 4 * 1024 * 1024
const START_WAIT_MS = 30_000
const PAGE_WAIT_MS = 20_000
const SETTLE_MS = 3_000
const REASON_CHARS = 300

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

/** What Playwright's `chromium` gives, as far as this file uses it. */
export type BrowserLike = {
  newContext(options: Record<string, unknown>): Promise<{
    route(url: string, handler: (route: RouteLike) => unknown): Promise<void>
    routeWebSocket(url: RegExp, handler: (ws: { close(): Promise<void> | void }) => unknown): Promise<void>
    newPage(): Promise<PageLike>
    close(): Promise<void>
  }>
  close(): Promise<void>
}

/** Where the browser may go: the app's own origin, and a proxy that goes nowhere for the rest. */
export type Fence = { origin: string; proxy: string }
type RouteLike = { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }
type PageLike = {
  goto(url: string, options: Record<string, unknown>): Promise<{ status(): number } | null>
  waitForLoadState(state: string, options: Record<string, unknown>): Promise<void>
  screenshot(options: Record<string, unknown>): Promise<Buffer>
}

/** WebRTC sends UDP only through the proxy, and an HTTP proxy carries none: no STUN or media leaves. */
const WEBRTC_FENCE = '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'

/** Playwright's Chromium, headless, behind the fence. Its absence is a reason, not a crash. */
export async function launchChromium(fence: Fence): Promise<BrowserLike> {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: fence.proxy },
    args: [WEBRTC_FENCE],
  })
  return browser as unknown as BrowserLike
}

/**
 * The browser's only way out: an HTTP proxy on loopback that forwards to `origin`'s host and port
 * and refuses anything else, plain requests and CONNECT tunnels alike.
 */
export async function openFence(origin: string): Promise<{ url: string; close(): Promise<void> }> {
  const app = new URL(origin)
  const appPort = Number(app.port || 80)
  const sockets = new Set<Socket>()
  const fence = createServer((request, response) => {
    let target: URL
    try {
      target = new URL(String(request.url))
    } catch {
      response.writeHead(400).end()
      return
    }
    if (target.protocol !== 'http:' || target.host !== app.host) {
      response.writeHead(403, { 'content-type': 'text/plain' }).end('MEC: no network from a capture')
      return
    }
    const upstream = httpRequest(
      {
        host: app.hostname.replace(/^\[|\]$/g, ''),
        port: appPort,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers: request.headers,
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(response)
      },
    )
    upstream.on('error', () => response.destroy())
    request.pipe(upstream)
  })
  fence.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  // A tunnel only to the app itself (its own WebSocket); any other is closed unanswered.
  fence.on('connect', (request, socket: Socket, head: Buffer) => {
    if (request.url !== app.host) {
      socket.destroy()
      return
    }
    const tunnel = netConnect(appPort, app.hostname.replace(/^\[|\]$/g, ''), () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      tunnel.write(head)
      tunnel.pipe(socket)
      socket.pipe(tunnel)
    })
    tunnel.on('error', () => socket.destroy())
    socket.on('error', () => tunnel.destroy())
  })
  fence.on('upgrade', (_request, socket: Socket) => socket.destroy())
  await new Promise<void>((done, fail) => {
    fence.once('error', fail)
    fence.listen(0, '127.0.0.1', () => done())
  })
  const { port } = fence.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy()
        fence.close(() => done())
      }),
  }
}

export type CaptureSpec = {
  /** The clone that holds the commit. */
  gitDir: string
  sha: string
  side: 'before' | 'after'
  setting: UiEvidenceSetting
  /** Where the PNGs land; only MEC's data dir, never a worktree. */
  outDir: string
  /** Scratch space for the exported revision; removed after. */
  tmpDir: string
  /** The repository's setup commands, run before its start command. */
  bootstrap: readonly string[]
  /** The scrubbed environment a repository's commands run in (decision #25). */
  env: Record<string, string>
  /** The owner agreed to run this repository's commands here. Only a start command needs it. */
  hostRunAgreed: boolean
  signal?: AbortSignal
  now?: () => string
  launch?: (fence: Fence) => Promise<BrowserLike>
  startWaitMs?: number
}

class CouldNot extends Error {}

const firstLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0]?.trim() || 'no detail'

const cut = (text: string): string =>
  text.length > REASON_CHARS ? `${text.slice(0, REASON_CHARS - 1)}…` : text

/** Serves `root` on a loopback port the OS picks. Nothing outside `root` is reachable. */
export async function serveStatic(root: string): Promise<{ origin: string; close(): Promise<void> }> {
  const base = resolve(root)
  const server: Server = createServer((request, response) => {
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    } catch {
      response.writeHead(400).end()
      return
    }
    let file = resolve(base, `.${pathname}`)
    if (file !== base && !file.startsWith(`${base}${sep}`)) {
      response.writeHead(404).end()
      return
    }
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html')
      const body = readFileSync(file)
      response.writeHead(200, {
        'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      })
      response.end(body)
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    }
  })
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => done())
  })
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

/** Exports one commit's tree into `dir`: real git, no worktree, no index. */
async function exportRevision(gitDir: string, sha: string, dir: string): Promise<void> {
  const tar = `${dir}.tar`
  const archived = await git(['archive', '--format=tar', '-o', tar, sha], { cwd: gitDir, allowFailure: true })
  if (archived.code !== 0) {
    throw new CouldNot(
      `MEC could not read commit ${sha.slice(0, 7)}: ${archived.stderr.trim() || 'git archive failed'}`,
    )
  }
  mkdirSync(dir, { recursive: true })
  await exec('tar', ['-xf', tar, '-C', dir])
  rmSync(tar, { force: true })
}

function stopGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    return
  }
  setTimeout(() => {
    try {
      if (child.pid !== undefined && child.exitCode === null) process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }, 2_000).unref()
}

async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000), redirect: 'manual' })
    return true
  } catch {
    return false
  }
}

/** Runs setup, then the start command, and waits until its URL answers. */
async function startApp(spec: CaptureSpec, dir: string): Promise<{ origin: string; close(): Promise<void> }> {
  const start = spec.setting.start as NonNullable<UiEvidenceSetting['start']>
  if (!spec.hostRunAgreed) {
    throw new CouldNot(
      'its start command runs on this machine, and you have not agreed to run this repository’s commands here',
    )
  }
  for (const command of spec.bootstrap) {
    const [cmd = '', ...args] = argvOf(command)
    const outcome = await runCheck({ name: 'ui_setup', cmd, args, cwd: dir, env: spec.env }, spec.signal)
    if (outcome.status !== 'passed') {
      throw new CouldNot(`the setup command ${command} failed: ${outcome.logTail.trim().slice(-200)}`)
    }
  }
  const port = start.port ?? (start.url === undefined ? await freePort() : undefined)
  const url = start.url ?? `http://127.0.0.1:${port}/`
  const [cmd = '', ...args] = start.argv
  let tail = ''
  const child = spawn(cmd, args, {
    cwd: dir,
    env: { ...spec.env, ...(port !== undefined && { PORT: String(port) }) },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const keep = (chunk: Buffer): void => {
    tail = `${tail}${chunk.toString('utf8')}`.slice(-400)
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  let failed: string | undefined
  child.once('error', (error) => {
    failed = `the start command ${cmd} could not run: ${firstLine(error)}`
  })
  const close = async (): Promise<void> => stopGroup(child)
  const deadline = Date.now() + (spec.startWaitMs ?? START_WAIT_MS)
  const host = new URL(url).host
  while (Date.now() < deadline) {
    if (spec.signal?.aborted) break
    if (failed !== undefined) break
    if (child.exitCode !== null) {
      failed = `the start command exited with code ${child.exitCode}${tail.trim() === '' ? '' : `: ${tail.trim().slice(-200)}`}`
      break
    }
    if (await answers(url)) return { origin: new URL(url).origin, close }
    await new Promise((done) => setTimeout(done, 250))
  }
  stopGroup(child)
  const waited = Math.round((spec.startWaitMs ?? START_WAIT_MS) / 1000)
  throw new CouldNot(failed ?? `the app did not answer on ${host} within ${waited} s`)
}

/** Every request but the app's own origin is refused, so the page reaches no network. */
const ownOrigin = (origin: string, url: string): boolean => {
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return true
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

/** The screenshots of one revision, or why there are none. Cleans up after itself. */
export async function captureRevision(spec: CaptureSpec): Promise<UiSide> {
  const now = spec.now ?? (() => new Date().toISOString())
  mkdirSync(spec.tmpDir, { recursive: true })
  const dir = mkdtempSync(join(spec.tmpDir, `${spec.side}-`))
  let app: { origin: string; close(): Promise<void> } | undefined
  let fence: { url: string; close(): Promise<void> } | undefined
  let browser: BrowserLike | undefined
  try {
    await exportRevision(spec.gitDir, spec.sha, dir)
    app = spec.setting.start === undefined ? await serveStatic(dir) : await startApp(spec, dir)
    fence = await openFence(app.origin)
    try {
      browser = await (spec.launch ?? launchChromium)({ origin: app.origin, proxy: fence.url })
    } catch (error) {
      throw new CouldNot(`Chromium could not start: ${firstLine(error)}`)
    }
    const origin = app.origin
    const context = await browser.newContext({
      viewport: UI_VIEWPORT,
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
    })
    await context.route('**/*', (route) =>
      ownOrigin(origin, route.request().url()) ? route.continue() : route.abort(),
    )
    // `route` never sees a WebSocket; this does. The fence refuses one this misses.
    await context.routeWebSocket(/.*/, (ws) => ws.close())
    mkdirSync(spec.outDir, { recursive: true })
    const shots: UiShot[] = []
    for (const [index, path] of spec.setting.paths.entries()) {
      if (spec.signal?.aborted) throw new CouldNot('MEC stopped while taking it')
      const page = await context.newPage()
      let status: number | null = null
      try {
        const response = await page.goto(`${origin}${path}`, { waitUntil: 'load', timeout: PAGE_WAIT_MS })
        status = response?.status() ?? null
      } catch (error) {
        throw new CouldNot(`the page ${path} did not load: ${firstLine(error)}`)
      }
      // The result must show the page. Before the change it may not exist yet (a new page), so a
      // before capture keeps its status as evidence of that, and only the after side refuses it.
      if (spec.side === 'after' && status !== null && status >= 400) {
        throw new CouldNot(`the page ${path} answered HTTP ${status} at the result`)
      }
      await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {})
      const png = await page.screenshot({ type: 'png', animations: 'disabled' })
      if (png.length > MAX_PNG_BYTES) {
        throw new CouldNot(
          `the screenshot of ${path} is ${png.length} bytes, over the ${MAX_PNG_BYTES} limit`,
        )
      }
      const file = `${spec.side}-${index + 1}.png`
      writeFileSync(join(spec.outDir, file), png)
      shots.push({ path, file, bytes: png.length, at: now(), status })
    }
    await context.close()
    return { sha: spec.sha, status: 'captured', shots }
  } catch (error) {
    const reason = error instanceof CouldNot ? error.message : `something went wrong: ${firstLine(error)}`
    return { sha: spec.sha, status: 'could_not', reason: cut(reason) }
  } finally {
    await browser?.close().catch(() => {})
    await fence?.close().catch(() => {})
    await app?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
}
