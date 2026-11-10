/**
 * One revision's screenshots, taken by MEC (spec §15): never by an engine, which may have no
 * shell (OpenCode) or no network (Codex, Claude). The revision is exported from the clone with
 * `git archive`, so nothing touches a worktree and nothing here can enter a commit. The real
 * application answers on loopback: the repository's own start command when it registers one (it
 * runs on this machine, so it needs the owner's agreement, as checks do), else MEC serves the
 * revision's files from a port it picks. Chromium is Playwright's, loaded only when needed.
 *
 * - **The page is data (§13.7).** Every request leaves only for the app's own origin; anything
 *   else is aborted, so a capture reaches no network and its result is the same on a rerun.
 * - **Bounded.** One viewport, at most `MAX_PATHS` paths, each PNG at most `MAX_PNG_BYTES`.
 * - **Never a pass by failing.** Anything that goes wrong is a `could_not` with its reason in
 *   words: the archive, the app, Chromium, a page, a size.
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
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
    newPage(): Promise<PageLike>
    close(): Promise<void>
  }>
  close(): Promise<void>
}
type RouteLike = { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }
type PageLike = {
  goto(url: string, options: Record<string, unknown>): Promise<{ status(): number } | null>
  waitForLoadState(state: string, options: Record<string, unknown>): Promise<void>
  screenshot(options: Record<string, unknown>): Promise<Buffer>
}

/** Playwright's Chromium, headless. Its absence is a reason, not a crash. */
export async function launchChromium(): Promise<BrowserLike> {
  const { chromium } = await import('playwright-core')
  return (await chromium.launch({ headless: true })) as unknown as BrowserLike
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
  launch?: () => Promise<BrowserLike>
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
  let browser: BrowserLike | undefined
  try {
    await exportRevision(spec.gitDir, spec.sha, dir)
    app = spec.setting.start === undefined ? await serveStatic(dir) : await startApp(spec, dir)
    try {
      browser = await (spec.launch ?? launchChromium)()
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
    await app?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
}
