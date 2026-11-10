// §15 on a real repository: real git, a real loopback server and real Chromium (Playwright's).
// The capture service takes the before screenshot at the task's base and the after at its head,
// stores both under MEC's data dir, and the scheduler then accepts. Anything it cannot take is a
// could-not-capture with its reason, and the task is never accepted on it.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { StoreDoc } from '@mec/contracts'
import { DEFAULT_CAPS } from '@mec/domain'
import { evidenceDocId, FollowUps, repoFields, schedulePass, screenshotsOffer } from '@mec/meta'
import { MemoryRepositories } from '@mec/testkit'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { serveStatic } from '../src/ui-capture'
import { capturesDir, registerScreenshotRoutes, UiEvidence } from '../src/ui-evidence'

const AT = '2026-11-10T12:00:00.000Z'
const REPO = 'repo_site'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const temp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `mec-uiev-${name}-`))
  dirs.push(dir)
  return dir
}

const run = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim()

const PAGE = (title: string, colour: string) =>
  `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body style="background:${colour}"><h1>${title}</h1><img src="https://example.invalid/tracker.png"><script src="app.js"></script></body></html>`

/** A static site at its base, then a commit that changes what users see. */
function site(
  extra: Record<string, string> = {},
  later: Record<string, string> = {},
): { gitDir: string; base: string; head: string } {
  const repo = temp('repo')
  run(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'index.html'), PAGE('Horses', 'white'))
  writeFileSync(join(repo, 'style.css'), 'h1 { color: black; }')
  writeFileSync(join(repo, 'app.js'), 'document.title = "horses"')
  for (const [file, text] of Object.entries(extra)) writeFileSync(join(repo, file), text)
  run(repo, 'add', '-A')
  run(repo, 'commit', '-qm', 'base')
  const base = run(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'index.html'), PAGE('Swipe right on horses', 'pink'))
  for (const [file, text] of Object.entries(later)) writeFileSync(join(repo, file), text)
  run(repo, 'add', '-A')
  run(repo, 'commit', '-qm', 'change')
  return { gitDir: repo, base, head: run(repo, 'rev-parse', 'HEAD') }
}

function rig(
  uiEvidence: StoreDoc,
  opts: { agreed?: boolean; extra?: Record<string, string>; later?: Record<string, string> } = {},
) {
  const store = new MemoryRepositories()
  const dataDir = temp('data')
  const { gitDir, base, head } = site(opts.extra, opts.later)
  store.atomic(() => {
    store.engines.save({
      id: REPO,
      url: gitDir,
      bootstrap: [],
      checks: [{ name: 'unit', cmd: 'true' }],
      trust: false,
      ...(opts.agreed !== false && { hostRunAgreedAt: AT }),
      uiEvidence,
    })
    store.workItems.save({
      id: 'wi_1',
      state: 'executing',
      git_dir: gitDir,
      mandate: { originMessageId: 'msg_1', status: 'active' },
      ...repoFields(store, REPO, '{"preAuthorised":{}}'),
    })
    store.tasks.save({
      id: 'task_a',
      workItemId: 'wi_1',
      repoId: REPO,
      role: 'implementer',
      status: 'active',
      dependsOn: [],
      createdAt: AT,
    })
    store.attempts.save({
      id: 'att_1',
      taskId: 'task_a',
      workItemId: 'wi_1',
      slotId: 'slot_a',
      state: 'succeeded',
      base_sha: base,
      head_sha: head,
      changed_paths: ['index.html'],
      checks: ['unit'],
      createdAt: AT,
    })
    store.engines.save({
      id: 'check/att_1/unit',
      attemptId: 'att_1',
      name: 'unit',
      status: 'passed',
      sha: head,
    })
  })
  const schedule = () =>
    store.atomic(() =>
      schedulePass(
        {
          store,
          effects: store.effects,
          caps: DEFAULT_CAPS,
          slots: () => [],
          table: () => undefined,
          followups: new FollowUps({ store, effects: store.effects, now: () => AT }),
        },
        { at: AT },
      ),
    )
  return { store, dataDir, gitDir, base, head, schedule }
}

const status = (store: MemoryRepositories) => store.tasks.get('task_a')?.status
const record = (store: MemoryRepositories) => store.engines.get(evidenceDocId('att_1'))

describe('UI evidence on a real repository (§15)', () => {
  it('takes before at the base and after at the head, then the task is accepted', async () => {
    const { store, dataDir, gitDir, base, head, schedule } = rig({ required: true })
    schedule()
    expect(status(store)).toBe('active')

    const service = new UiEvidence({ store, dataDir })
    await service.pass()
    const doc = record(store) as StoreDoc
    expect(doc).toMatchObject({
      state: 'taken',
      viewport: { width: 1280, height: 800 },
      paths: ['/'],
      before: { sha: base, status: 'captured' },
      after: { sha: head, status: 'captured' },
    })
    const dir = capturesDir(dataDir, 'wi_1', 'att_1')
    const before = readFileSync(join(dir, 'before-1.png'))
    const after = readFileSync(join(dir, 'after-1.png'))
    expect(before.subarray(1, 4).toString()).toBe('PNG')
    expect(after.subarray(1, 4).toString()).toBe('PNG')
    // Two revisions of the same scenario: the pages differ, so the images do.
    expect(before.equals(after)).toBe(false)
    // Nothing reached the repository: no capture can enter a commit.
    expect(run(gitDir, 'status', '--porcelain')).toBe('')
    expect(dir.startsWith(dataDir)).toBe(true)

    schedule()
    expect(status(store)).toBe('accepted')
  })

  it('takes nothing again once taken', async () => {
    const { store, dataDir } = rig({ required: true })
    const service = new UiEvidence({ store, dataDir })
    await service.pass()
    const first = record(store)?.takenAt
    await service.pass()
    expect(record(store)?.takenAt).toBe(first)
  })

  it('flag off: nothing is captured, and the task is accepted as before', async () => {
    const { store, dataDir, schedule } = rig({ required: false })
    await new UiEvidence({ store, dataDir }).pass()
    expect(record(store)).toBeUndefined()
    schedule()
    expect(status(store)).toBe('accepted')
  })

  it('Chromium missing: could not capture, with the reason, and never accepted', async () => {
    const { store, dataDir, schedule } = rig({ required: true })
    const launch = async () => {
      throw new Error("Executable doesn't exist at /nowhere/chrome\nmore")
    }
    await new UiEvidence({ store, dataDir, launch }).pass()
    expect(record(store)).toMatchObject({
      state: 'could_not',
      before: {
        status: 'could_not',
        reason: "Chromium could not start: Executable doesn't exist at /nowhere/chrome",
      },
    })
    schedule()
    expect(status(store)).toBe('active')
    expect(screenshotsOffer(store, store.workItems.get('wi_1') as StoreDoc)?.reason).toBe(
      "Couldn't take the before screenshot: Chromium could not start: Executable doesn't exist at /nowhere/chrome",
    )
  })

  it('the repository’s start command serves the real app on the port MEC gives it', async () => {
    const server = [
      "const http = require('node:http'); const fs = require('node:fs')",
      "http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(fs.readFileSync('index.html')) })",
      "  .listen(Number(process.env.PORT), '127.0.0.1')",
    ].join('\n')
    const { store, dataDir, schedule } = rig(
      { required: true, start: { argv: [process.execPath, 'server.cjs'] } },
      { extra: { 'server.cjs': server } },
    )
    await new UiEvidence({ store, dataDir }).pass()
    expect(record(store)).toMatchObject({
      state: 'taken',
      before: { status: 'captured' },
      after: { status: 'captured' },
    })
    schedule()
    expect(status(store)).toBe('accepted')
  })

  it('an app that will not start is could-not-capture, saying how it ended', async () => {
    const { store, dataDir, schedule } = rig(
      { required: true, start: { argv: [process.execPath, 'fail.cjs'] } },
      { extra: { 'fail.cjs': 'console.error("port in use")\nprocess.exit(3)\n' } },
    )
    await new UiEvidence({ store, dataDir }).pass()
    expect(record(store)).toMatchObject({
      state: 'could_not',
      before: { status: 'could_not', reason: 'the start command exited with code 3: port in use' },
    })
    schedule()
    expect(status(store)).toBe('active')
  })

  it('before taken and after not is could-not-capture, never taken', async () => {
    const serve = [
      "const http = require('node:http'); const fs = require('node:fs')",
      "http.createServer((q, r) => r.end(fs.readFileSync('index.html'))).listen(Number(process.env.PORT), '127.0.0.1')",
    ].join('\n')
    const { store, dataDir, schedule } = rig(
      { required: true, start: { argv: [process.execPath, 'server.cjs'] } },
      { extra: { 'server.cjs': serve }, later: { 'server.cjs': 'process.exit(4)\n' } },
    )
    await new UiEvidence({ store, dataDir }).pass()
    expect(record(store)).toMatchObject({
      state: 'could_not',
      before: { status: 'captured' },
      after: { status: 'could_not', reason: 'the start command exited with code 4' },
    })
    schedule()
    expect(status(store)).toBe('active')
  })

  it('an app that never answers times out as could-not-capture', async () => {
    const { store, dataDir } = rig(
      { required: true, start: { argv: [process.execPath, 'idle.cjs'], port: 1 } },
      { extra: { 'idle.cjs': 'setInterval(() => {}, 1000)\n' } },
    )
    await new UiEvidence({ store, dataDir, startWaitMs: 1_500 }).pass()
    expect(
      String((record(store) as StoreDoc).before && ((record(store) as StoreDoc).before as StoreDoc).reason),
    ).toBe('the app did not answer on 127.0.0.1:1 within 2 s')
  })

  it('a start command waits for the owner’s agreement; static serving runs nothing of the repo', async () => {
    const { store, dataDir } = rig({ required: true, start: { argv: ['true'] } }, { agreed: false })
    await new UiEvidence({ store, dataDir }).pass()
    expect(
      String((record(store) as StoreDoc).before && ((record(store) as StoreDoc).before as StoreDoc).reason),
    ).toMatch(/not agreed/)
  })

  it('the routes list the captures by short commit, and serve only the files the record names', async () => {
    const { store, dataDir, base, head } = rig({ required: true })
    await new UiEvidence({ store, dataDir }).pass()
    const app = Fastify()
    registerScreenshotRoutes(app, store, dataDir)
    const list = await app.inject({ url: '/api/work/wi_1/screenshots' })
    expect(list.statusCode).toBe(200)
    const [item] = list.json().items
    expect(item).toMatchObject({
      taskId: 'task_a',
      state: 'taken',
      before: { sha: base, short: base.slice(0, 7), status: 'captured' },
      after: { sha: head, short: head.slice(0, 7), status: 'captured' },
    })
    const png = await app.inject({ url: item.after.shots[0].url })
    expect(png.statusCode).toBe(200)
    expect(png.headers['content-type']).toBe('image/png')
    // A PNG on disk the record does not name is not served either.
    writeFileSync(join(capturesDir(dataDir, 'wi_1', 'att_1'), 'after-2.png'), 'stray')
    expect((await app.inject({ url: '/api/work/wi_1/screenshots/att_1/after-2.png' })).statusCode).toBe(404)
    for (const url of [
      '/api/work/wi_1/screenshots/att_1/..%2F..%2F..%2Fetc%2Fpasswd',
      '/api/work/wi_1/screenshots/att_1/after-9.png',
      '/api/work/wi_other/screenshots/att_1/after-1.png',
      '/api/work/wi_1/screenshots/..%2Fatt_1/after-1.png',
    ]) {
      expect((await app.inject({ url })).statusCode, url).toBe(404)
    }
    expect((await app.inject({ url: '/api/work/wi_nope/screenshots' })).statusCode).toBe(404)
    await app.close()
  })
})

describe('the page reaches no network (§13.7)', () => {
  it('a request to any other origin, loopback included, is refused', async () => {
    const seen: string[] = []
    const other = createServer((request, response) => {
      seen.push(String(request.url))
      response.end('x')
    })
    await new Promise<void>((done) => other.listen(0, '127.0.0.1', () => done()))
    const { port } = other.address() as AddressInfo
    try {
      const page = `<!doctype html><img src="http://127.0.0.1:${port}/pixel.png"><script>fetch('http://127.0.0.1:${port}/beacon')</script>`
      const { store, dataDir } = rig({ required: true }, { extra: { 'index.html': page } })
      await new UiEvidence({ store, dataDir }).pass()
      expect(record(store)?.state).toBe('taken')
      expect(seen).toEqual([])
    } finally {
      await new Promise<void>((done) => other.close(() => done()))
    }
  })
})

describe('the static server', () => {
  it('serves the tree and nothing outside it', async () => {
    const root = temp('root')
    writeFileSync(join(root, 'index.html'), '<h1>hi</h1>')
    const outside = temp('outside')
    writeFileSync(join(outside, 'secret.txt'), 'no')
    const served = await serveStatic(root)
    try {
      expect(await (await fetch(`${served.origin}/`)).text()).toBe('<h1>hi</h1>')
      expect((await fetch(`${served.origin}/../secret.txt`)).status).toBe(404)
      expect((await fetch(`${served.origin}/%2e%2e/secret.txt`)).status).toBe(404)
      // An encoded slash survives the client's own clean-up, so this reaches the server as `..`.
      const sibling = `/..%2F${basename(outside)}%2Fsecret.txt`
      expect((await fetch(`${served.origin}${sibling}`)).status).toBe(404)
      expect(served.origin.startsWith('http://127.0.0.1:')).toBe(true)
    } finally {
      await served.close()
    }
    expect(existsSync(root)).toBe(true)
  })
})
