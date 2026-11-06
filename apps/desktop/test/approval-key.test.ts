// Resolving a card, or agreeing to a repository, needs a key only the server and the owner's browser
// hold. The attacker these tests stand in for is a repo's check: it runs as the owner, reads the data
// dir and calls loopback. That is what the key closes; docs/known-limits.md says what it does not.
import { spawn } from 'node:child_process'
import { closeSync, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StoreDoc } from '@mec/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APPROVAL_HEADER,
  ApprovalKey,
  CODE_LIFE_MS,
  LINK_SPACING_MS,
  linkCommand,
  readApprovalKey,
} from '../src/approval'
import { brainThatNeverRuns, cleanUp, peek, type Rig, scratch, seedStore, serve } from './recovery-rig'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanUp()
})

const KEY = 'k'.repeat(64)
const CARD = 'cf_owner_only'

const ROUTES = [
  `/api/inbox/${CARD}/resolve`,
  `/api/release/push/${CARD}/resolve`,
  `/api/release/pr/${CARD}/resolve`,
  `/api/release/merge/${CARD}/resolve`,
]

const seedCard = (rig: Rig): void => {
  peek(rig, (store) => {
    store.atomic(() =>
      store.confirmations.save({
        id: CARD,
        cls: 'push',
        status: 'pending',
        operationHash: 'h',
        expiresAt: '2099-01-01T00:00:00.000Z',
        payload: { repoId: 'repo_a', branch: 'mec/x' },
      } as StoreDoc),
    )
  })
}

const resolve = (url: string, path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ answer: 'approve' }),
  })

const statusOf = (rig: Rig): unknown => peek(rig, (store) => store.confirmations.get(CARD)?.status)

const started = async (rig: Rig, opts: Parameters<typeof serve>[1] = {}) => {
  seedStore(rig, { preUpgrade: true, noAttempt: true, noRow: true })
  seedCard(rig)
  return serve(rig, { brain: brainThatNeverRuns, ...opts })
}

describe('the resolve routes', { timeout: 60_000 }, () => {
  it.each(ROUTES)('%s refuses a caller with no key, and a wrong one', async (path) => {
    const rig = scratch([])
    const server = await started(rig, { approvalKey: KEY })
    for (const key of [undefined, 'nope', `${KEY}0`]) {
      const response = await resolve(server.url, path, key === undefined ? {} : { [APPROVAL_HEADER]: key })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'approval_required' })
    }
    expect(statusOf(rig)).toBe('pending')
  })

  it('a deny needs the key too', async () => {
    const rig = scratch([])
    const server = await started(rig, { approvalKey: KEY })
    const response = await fetch(`${server.url}/api/inbox/${CARD}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'deny' }),
    })
    expect(response.status).toBe(403)
  })

  it('the key lets a resolve through to the route, and a reload needs nothing new', async () => {
    const rig = scratch([])
    const server = await started(rig, { approvalKey: KEY })
    const [first, second] = [
      await resolve(server.url, '/api/inbox/cf_nothing/resolve', { [APPROVAL_HEADER]: KEY }),
      await resolve(server.url, '/api/inbox/cf_nothing/resolve', { [APPROVAL_HEADER]: KEY }),
    ]
    expect([first.status, second.status]).toEqual([404, 404])
  })

  it('agreeing needs the key, and withdrawing never does', async () => {
    const rig = scratch([])
    const server = await started(rig, { approvalKey: KEY })
    const agree = `${server.url}/api/repositories/repo_a/host-run/agree`
    expect((await fetch(agree, { method: 'POST' })).status).toBe(403)
    expect(peek(rig, (store) => store.engines.get('repo_a')?.hostRunAgreedAt)).toBeUndefined()
    const agreed = await fetch(agree, { method: 'POST', headers: { [APPROVAL_HEADER]: KEY } })
    expect(agreed.status).toBe(200)
    const withdrawn = await fetch(`${server.url}/api/repositories/repo_a/host-run/withdraw`, {
      method: 'POST',
    })
    expect(withdrawn.status).toBe(200)
    expect(peek(rig, (store) => store.engines.get('repo_a')?.hostRunAgreedAt)).toBeUndefined()
  })

  it('no environment variable stands in for the key', async () => {
    vi.stubEnv('MEC_APPROVAL_KEY', KEY)
    const rig = scratch([])
    const server = await started(rig, { openLink: () => {} })
    expect((await resolve(server.url, ROUTES[0] as string, { [APPROVAL_HEADER]: KEY })).status).toBe(403)
    vi.unstubAllEnvs()
  })
})

describe('a process running as the owner', { timeout: 60_000 }, () => {
  /** Everything a check can reach by reading the data dir and calling loopback, as a real child. */
  const SWEEP = `
const { readdirSync, readFileSync, statSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const [url, dataDir, out] = process.argv.slice(1)
const seen = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else { try { seen.push(readFileSync(path).toString('latin1')) } catch {} }
  }
}
const browser = { origin: url, 'sec-fetch-site': 'same-origin', 'x-mec-client': '1', referer: url + '/' }
const GETS = ['/', '/healthz', '/api/status', '/api/inbox', '/api/repositories', '/api/work', '/api/chat/messages',
  '/api/slots', '/api/setup/readiness', '/api/policy', '/api/approval', '/api/approval/key', '/api/inspect/snapshot']
;(async () => {
  walk(dataDir)
  for (const path of GETS) {
    for (const headers of [{}, browser]) {
      const response = await fetch(url + path, { headers }).catch(() => undefined)
      seen.push(response === undefined ? '' : await response.text())
    }
  }
  const link = await fetch(url + '/api/approval/link', { method: 'POST', headers: browser })
  seen.push(await link.text())
  const redeem = await fetch(url + '/api/approval/redeem', {
    method: 'POST',
    headers: { ...browser, 'content-type': 'application/json' },
    body: JSON.stringify({ code: '0'.repeat(64) }),
  })
  seen.push(await redeem.text())
  writeFileSync(out, JSON.stringify({ seen, redeem: redeem.status }))
})()
`

  it('finds no key in the data dir or on any route, browser headers or not', async () => {
    const rig = scratch([])
    const opened: string[] = []
    const server = await started(rig, { approvalKey: KEY, openLink: (url) => opened.push(url) })
    const out = join(rig.root, 'sweep.json')
    await new Promise<void>((done, failed) => {
      const child = spawn(process.execPath, ['-e', SWEEP, server.url, rig.dataDir, out], { stdio: 'ignore' })
      child.once('error', failed)
      child.once('exit', () => done())
    })
    const { seen, redeem } = JSON.parse(readFileSync(out, 'utf8')) as { seen: string[]; redeem: number }
    expect(seen.length).toBeGreaterThan(10)
    expect(seen.filter((text) => text.includes(KEY))).toEqual([])
    expect(redeem).toBe(403)
    // It may ask for a tab to open. The code goes to the browser, never to the one who asked.
    expect(opened).toHaveLength(1)
    const code = new URL(opened[0] as string).hash.slice('#pair='.length)
    expect(code).toMatch(/^[0-9a-f]{64}$/)
    expect(seen.filter((text) => text.includes(code))).toEqual([])
  })

  it('nothing the server prints carries the key', async () => {
    const log = vi.spyOn(console, 'log')
    const error = vi.spyOn(console, 'error')
    const rig = scratch([])
    await started(rig, { approvalKey: KEY })
    const printed = JSON.stringify([...log.mock.calls, ...error.mock.calls])
    expect(printed).not.toContain(KEY)
  })
})

describe('linking the browser', { timeout: 60_000 }, () => {
  const linked = async (rig: Rig, opened: string[]) => {
    const server = await started(rig, { openLink: (url) => opened.push(url) })
    expect((await fetch(`${server.url}/api/approval/link`, { method: 'POST' })).status).toBe(200)
    return { server, code: new URL(opened.at(-1) as string).hash.slice('#pair='.length) }
  }
  const redeem = (url: string, code: unknown): Promise<Response> =>
    fetch(`${url}/api/approval/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })

  it('a code gets the key once, and the link goes to our own origin whatever Host says', async () => {
    const rig = scratch([])
    const opened: string[] = []
    const server = await started(rig, { approvalKey: KEY, openLink: (url) => opened.push(url) })
    const port = new URL(server.url).port
    await new Promise<void>((done) => {
      void import('node:http').then(({ request }) => {
        request(
          { port, method: 'POST', path: '/api/approval/link', headers: { host: 'evil.example' } },
          (reply) => {
            reply.resume()
            reply.once('end', done)
          },
        ).end()
      })
    })
    expect(new URL(opened[0] as string).origin).toBe(new URL(server.url).origin)
    const code = new URL(opened[0] as string).hash.slice('#pair='.length)
    const first = await redeem(server.url, code)
    expect(await first.json()).toEqual({ key: KEY })
    expect((await redeem(server.url, code)).status).toBe(403)
  })

  it('a restart mints a new key and the old one stops working, and a new link gets the new one', async () => {
    const rig = scratch([])
    const opened: string[] = []
    const first = await linked(rig, opened)
    const key = ((await (await redeem(first.server.url, first.code)).json()) as { key: string }).key
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    await first.server.close()
    const server = await serve(rig, { brain: brainThatNeverRuns, openLink: (url) => opened.push(url) })
    expect((await resolve(server.url, ROUTES[0] as string, { [APPROVAL_HEADER]: key })).status).toBe(403)
    expect((await fetch(`${server.url}/api/approval/link`, { method: 'POST' })).status).toBe(200)
    const code = new URL(opened.at(-1) as string).hash.slice('#pair='.length)
    const fresh = ((await (await redeem(server.url, code)).json()) as { key: string }).key
    expect(fresh).not.toBe(key)
    expect(
      (await resolve(server.url, '/api/inbox/cf_nothing/resolve', { [APPROVAL_HEADER]: fresh })).status,
    ).toBe(404)
  })

  it('keys and codes', () => {
    const key = new ApprovalKey(KEY)
    expect(key.accepts(KEY)).toBe(true)
    expect(key.accepts(undefined)).toBe(false)
    expect(key.accepts([KEY])).toBe(false)
    expect(key.redeem('anything', 0)).toBeUndefined()
    const code = key.issueCode(1000) as string
    expect(key.issueCode(1000 + LINK_SPACING_MS - 1)).toBeUndefined()
    expect(key.redeem(code, 1000 + CODE_LIFE_MS + 1)).toBeUndefined()
    const next = key.issueCode(1000 + CODE_LIFE_MS + 2) as string
    expect(key.redeem(code, 1000 + CODE_LIFE_MS + 3)).toBeUndefined()
    expect(key.redeem(next, 1000 + CODE_LIFE_MS + 3)).toBe(KEY)
    expect(new ApprovalKey().accepts(KEY)).toBe(false)
  })

  it('a mac opens the link over stdin, so no process list ever shows the code', () => {
    const url = 'http://127.0.0.1:1234/#pair=abc'
    const mac = linkCommand(url, 'darwin')
    expect(mac.cmd).toBe('osascript')
    expect(JSON.stringify(mac.args)).not.toContain('abc')
    expect(mac.stdin).toContain(url)
    expect(linkCommand(url, 'linux')).toEqual({ cmd: 'xdg-open', args: [url] })
  })

  it('a starter can hand in a key on a descriptor, which is read once and closed', () => {
    const rig = scratch([])
    const path = join(rig.root, 'key')
    writeFileSync(path, `${KEY}\n`)
    const fd = openSync(path, 'r')
    expect(readApprovalKey(fd)).toBe(KEY)
    expect(() => fstatSync(fd)).toThrow()
    const short = openSync(path, 'w+')
    writeFileSync(short, 'short')
    closeSync(short)
    const again = openSync(path, 'r')
    expect(() => readApprovalKey(again)).toThrow(/at least 32/)
  })
})
