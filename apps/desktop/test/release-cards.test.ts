/**
 * The confirmation cards, end to end: a real server on a real socket, the workbench's own
 * `api.resolve` client (what the Approve button calls), a recording fake gh, and real git
 * against a local bare repository for the push card. No test reaches GitHub. §13: nothing
 * leaves the machine without a settled approval, and a settled approval always acts.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HealthBoard, HealthClaim, Store, StoreDoc } from '@mec/contracts'
import { fakeBrain, MetaAgentService, type MetaDecision } from '@mec/meta'
import { MemoryRepositories } from '@mec/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import type { GhResult, GhRun, GitExec, ReleaseDeps } from '../src/release'
import {
  createPrBehindCard,
  mergeBehindCard,
  openMergeCard,
  openPushCard,
  pushIntegrationBranch,
  resolvePrCreate,
} from '../src/release'
import { buildServer } from '../src/server'

const REPO = 'owner/repo'
const BRANCH = 'mec/wi1/integration'
const PR = 12
const HEAD = 'a'.repeat(40)
const MOVED = 'b'.repeat(40)
const SECRET = `sk-ant-${'a1B2c3D4'.repeat(6)}`
const GH_KEY = `ghp_${'a1B2'.repeat(8)}`
const REMOTE_URL = `https://github.com/${REPO}`

const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string, code = 1): GhResult => ({ code, stdout: '', stderr })

/** The GitHub the fake gh reports; a test edits it between the card opening and the answer. */
type World = {
  head: GhResult
  prHead: string
  prState: string
  mergeState: string
  title: string
  prBranch: string
  checks: GhResult
  create: GhResult
  merge: GhResult
  afterMerge: string
  remoteUrl: string
  defaultBranch: string
  repoView?: GhResult
  prView?: GhResult
  /** Milliseconds every gh read takes; a real gh is never instant, so answers can overlap. */
  latency?: number
}

const world = (over: Partial<World> = {}): World => ({
  head: ok(`${HEAD}\n`),
  prHead: HEAD,
  prState: 'OPEN',
  mergeState: 'CLEAN',
  title: 'Ship the smoke test',
  prBranch: BRANCH,
  checks: ok('[{"name":"unit","state":"SUCCESS"}]'),
  create: ok(`https://github.com/${REPO}/pull/${PR}\n`),
  merge: ok(''),
  afterMerge: 'MERGED',
  remoteUrl: REMOTE_URL,
  defaultBranch: 'main',
  ...over,
})

function fakeGh(state: World): { run: GhRun; calls: Array<readonly string[]> } {
  const calls: Array<readonly string[]> = []
  const run: GhRun = async (args) => {
    calls.push(args)
    if (state.latency !== undefined) await new Promise((done) => setTimeout(done, state.latency))
    const text = args.join(' ')
    if (text.includes('/git/ref/heads/')) return state.head
    if (args[0] === 'repo' && args[1] === 'view') {
      if (state.repoView !== undefined) return state.repoView
      return text.includes('defaultBranchRef')
        ? ok(JSON.stringify({ url: state.remoteUrl, defaultBranchRef: { name: state.defaultBranch } }))
        : ok(`${state.remoteUrl}\n`)
    }
    if (args[0] === 'pr' && args[1] === 'create') return state.create
    if (args[0] === 'pr' && args[1] === 'checks') return state.checks
    if (args[0] === 'pr' && args[1] === 'merge') return state.merge
    if (args[0] === 'pr' && args[1] === 'view') {
      if (state.prView !== undefined) return state.prView
      if (!text.includes('headRefOid')) return ok(JSON.stringify({ state: state.afterMerge }))
      return ok(
        JSON.stringify({
          state: state.prState,
          title: state.title,
          headRefName: state.prBranch,
          headRefOid: state.prHead,
          mergeStateStatus: state.mergeState,
        }),
      )
    }
    return ok('')
  }
  return { run, calls }
}

const merges = (calls: Array<readonly string[]>) => calls.filter((a) => a[0] === 'pr' && a[1] === 'merge')
const creates = (calls: Array<readonly string[]>) => calls.filter((a) => a[0] === 'pr' && a[1] === 'create')

const fakeHealth: HealthBoard = {
  claim(): HealthClaim {
    return { starting: () => {}, ready: () => {}, paused: () => {}, error: () => {} }
  },
}

type WebApi = {
  api: {
    resolve(id: string, answer: 'approve' | 'deny'): Promise<Record<string, unknown>>
    decisionDetail(id: string): Promise<never>
  }
  isAlreadyHandled(error: unknown): boolean
}

/** The workbench's real client module; a computed path because the desktop project's tsc stops at its rootDir. */
const WEB_API = new URL('../../web/src/api.ts', import.meta.url).href
const WEB_CARDS = new URL('../../web/src/release-cards.ts', import.meta.url).href

const cleanups: Array<() => Promise<void> | void> = []
const realFetch = globalThis.fetch
afterEach(async () => {
  globalThis.fetch = realFetch
  while (cleanups.length > 0) await cleanups.pop()?.()
})

type Harness = {
  store: Store
  web: WebApi
  post(url: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }>
  get(url: string): Promise<{ status: number; body: Record<string, unknown> }>
}

/** A real server on a real socket; `fetch` is the browser's: same origin, relative paths. */
async function harness(run: GhRun, gitExec?: GitExec): Promise<Harness> {
  const store: Store = new MemoryRepositories()
  const app = buildServer({
    store,
    effects: store.effects,
    health: fakeHealth,
    policyText: '{"preAuthorised":{}}',
    now: () => new Date(),
    ghRun: run,
    ...(gitExec !== undefined && { gitExec }),
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  cleanups.push(() => app.close())
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  globalThis.fetch = ((input: string | URL, init?: RequestInit) =>
    realFetch(`${origin}${String(input)}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), origin },
    })) as typeof fetch
  const web = (await import(/* @vite-ignore */ WEB_API)) as WebApi
  const send = async (url: string, init?: RequestInit) => {
    const response = await globalThis.fetch(url, init)
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  return {
    store,
    web,
    post: (url, payload) =>
      send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mec-client': '1' },
        body: JSON.stringify(payload),
      }),
    get: (url) => send(url),
  }
}

const openPrCard = async (h: Harness): Promise<string> => {
  const res = await h.post('/api/release/pr', { repo: REPO, branch: BRANCH, title: 'T', body: 'B' })
  expect(res.status).toBe(200)
  return String(res.body.confirmationId)
}

const openMerge = async (h: Harness): Promise<string> => {
  const res = await h.post('/api/release/merge', { repo: REPO, prNumber: PR })
  expect(res.status).toBe(200)
  return String(res.body.confirmationId)
}

describe('the UI resolve path acts (§13: a settled approval is never a no-op)', () => {
  it('approving a pr_create card through api.resolve runs gh pr create and reports the PR', async () => {
    const { run, calls } = fakeGh(world())
    const h = await harness(run)
    const id = await openPrCard(h)
    const out = await h.web.api.resolve(id, 'approve')
    expect(out).toMatchObject({ status: 'approved', prNumber: PR, cls: 'pr_create' })
    expect(creates(calls)).toHaveLength(1)
    expect(h.store.confirmations.get(id)?.status).toBe('approved')
    await expect(h.web.api.resolve(id, 'deny')).rejects.toSatisfy(h.web.isAlreadyHandled)
    expect(creates(calls)).toHaveLength(1)
  })

  it('approving a pr_merge card through api.resolve squash-merges the bound head and reports merged', async () => {
    const { run, calls } = fakeGh(world())
    const h = await harness(run)
    const id = await openMerge(h)
    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({
      status: 'approved',
      merged: true,
      cls: 'pr_merge',
    })
    expect(merges(calls)).toEqual([
      ['pr', 'merge', '-R', REPO, '--squash', '--match-head-commit', HEAD, String(PR)],
    ])
  })

  it('a merge held by CI stays pending and says why; the answer is not spent', async () => {
    const state = world({ checks: ok('[{"name":"unit","state":"PENDING"}]') })
    const { run, calls } = fakeGh(state)
    const h = await harness(run)
    const id = await openMerge(h)
    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({
      status: 'pending',
      reason: 'ci_pending',
    })
    expect(merges(calls)).toHaveLength(0)
    expect(h.store.confirmations.get(id)?.status).toBe('pending')
    state.checks = ok('[{"name":"unit","state":"SUCCESS"}]')
    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({ merged: true })
  })

  it('gh refusing the merge is reported as spent, with the failure, never as success', async () => {
    const { run } = fakeGh(world({ merge: fail('GraphQL: Pull Request is not mergeable') }))
    const h = await harness(run)
    const id = await openMerge(h)
    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({
      status: 'approved',
      merged: false,
      reason: 'gh_merge_failed',
    })
  })

  it('two approvals racing act once: both pass the pre-flight, the second is already handled', async () => {
    const state = world()
    const { run, calls } = fakeGh(state)
    const h = await harness(run)
    const id = await openMerge(h)
    state.latency = 20
    const answers = await Promise.allSettled([
      h.web.api.resolve(id, 'approve'),
      h.web.api.resolve(id, 'approve'),
    ])
    expect(answers.map((answer) => answer.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(calls.filter((args) => args[1] === 'checks')).toHaveLength(2)
    expect(merges(calls)).toHaveLength(1)
  })

  it.each(['push', 'pr_merge', 'pr_create', 'branch_delete', 'force_op', 'pr_edit'])(
    'an always-confirm %s card with nothing to run refuses approve, stays pending, and can be denied',
    async (cls) => {
      const { run, calls } = fakeGh(world())
      const h = await harness(run)
      h.store.confirmations.save({
        id: 'conf_bare',
        cls,
        operationHash: 'op',
        status: 'pending',
        createdAt: '2026-11-05T00:00:00.000Z',
        expiresAt: '2999-01-01T00:00:00.000Z',
        payload: { operation: { class: cls }, evidence: {} },
      })
      const refused = await h.post('/api/inbox/conf_bare/resolve', { answer: 'approve' })
      expect(refused.status).toBe(422)
      expect(refused.body.error).toBe('no_executor')
      expect(h.store.confirmations.get('conf_bare')?.status).toBe('pending')
      expect(calls).toHaveLength(0)
      const denied = await h.post('/api/inbox/conf_bare/resolve', { answer: 'deny' })
      expect(denied.status).toBe(200)
      expect(h.store.confirmations.get('conf_bare')?.status).toBe('denied')
    },
  )

  it('a card the planner opened for an ordinary class still settles as before', async () => {
    const { run, calls } = fakeGh(world())
    const h = await harness(run)
    h.store.confirmations.save({
      id: 'conf_install',
      cls: 'install',
      operationHash: 'op',
      status: 'pending',
      createdAt: '2026-11-05T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      payload: { operation: { command: 'pnpm add x' }, evidence: { reason: 'the task needs it' } },
    })
    const out = await h.post('/api/inbox/conf_install/resolve', { answer: 'approve' })
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ id: 'conf_install', status: 'approved' })
    expect(calls).toHaveLength(0)
  })
})

describe('head binding and the merge pre-flight (§13 input SHA)', () => {
  it('a PR head that moved after the card opened stales the card and merges nothing', async () => {
    const state = world()
    const { run, calls } = fakeGh(state)
    const h = await harness(run)
    const id = await openMerge(h)
    expect(h.store.confirmations.get(id)?.inputSha).toBe(HEAD)
    state.prHead = MOVED
    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({
      status: 'stale',
      merged: false,
      reason: 'stale_head',
    })
    expect(merges(calls)).toHaveLength(0)
    expect(h.store.confirmations.get(id)?.status).toBe('stale')
  })

  it('a branch head that moved after the card opened stales the PR card and opens nothing', async () => {
    const state = world()
    const { run, calls } = fakeGh(state)
    const h = await harness(run)
    const id = await openPrCard(h)
    expect(h.store.confirmations.get(id)?.inputSha).toBe(HEAD)
    state.head = ok(`${MOVED}\n`)
    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({
      status: 'stale',
      reason: 'stale_head',
    })
    expect(creates(calls)).toHaveLength(0)
  })

  it('an unreadable head at approve leaves the PR card pending; at open no card is made', async () => {
    const state = world()
    const { run, calls } = fakeGh(state)
    const h = await harness(run)
    const id = await openPrCard(h)
    state.head = fail('HTTP 502')
    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({
      status: 'pending',
      reason: 'head_unreadable',
    })
    expect(creates(calls)).toHaveLength(0)
    const refused = await h.post('/api/release/pr', { repo: REPO, branch: BRANCH, title: 'T', body: 'B' })
    expect(refused.status).toBe(422)
    expect(refused.body.error).toBe('head_unreadable')
    expect(h.store.confirmations.list({ status: 'pending' })).toHaveLength(1)
  })

  it('a card from before head binding cannot act, but can be denied', async () => {
    const { run, calls } = fakeGh(world())
    const h = await harness(run)
    for (const [id, cls, payload] of [
      ['conf_old_pr', 'pr_create', { repo: REPO, branch: BRANCH, title: 'T', body: 'B' }],
      ['conf_old_merge', 'pr_merge', { repo: REPO, prNumber: PR }],
    ] as const) {
      h.store.confirmations.save({
        id,
        cls,
        operationHash: 'op',
        status: 'pending',
        createdAt: '2026-11-05T00:00:00.000Z',
        expiresAt: '2999-01-01T00:00:00.000Z',
        payload,
      })
      await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({
        status: 'pending',
        reason: 'card_unbound',
      })
      await expect(h.web.api.resolve(id, 'deny')).resolves.toMatchObject({ status: 'denied' })
    }
    expect(merges(calls)).toHaveLength(0)
    expect(creates(calls)).toHaveLength(0)
  })

  it('BEHIND refuses without spending the card; once updated it merges', async () => {
    const state = world({ mergeState: 'BEHIND' })
    const { run, calls } = fakeGh(state)
    const h = await harness(run)
    const id = await openMerge(h)
    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({
      status: 'pending',
      merged: false,
      reason: 'behind',
    })
    expect(merges(calls)).toHaveLength(0)
    expect(h.store.confirmations.get(id)?.status).toBe('pending')
    state.mergeState = 'CLEAN'
    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({ merged: true })
  })

  it.each([
    ['BLOCKED', 'blocked'],
    ['DIRTY', 'dirty'],
    ['DRAFT', 'draft'],
    ['UNKNOWN', 'merge_state_unknown'],
    ['SOMETHING_NEW', 'merge_state_unknown'],
  ])('merge state %s holds the card as %s', async (mergeState, reason) => {
    const { run, calls } = fakeGh(world({ mergeState }))
    const h = await harness(run)
    const id = await openMerge(h)
    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({ status: 'pending', reason })
    expect(merges(calls)).toHaveLength(0)
  })

  it.each(['CLEAN', 'HAS_HOOKS', 'UNSTABLE'])('merge state %s may merge', async (mergeState) => {
    const { run } = fakeGh(world({ mergeState }))
    const h = await harness(run)
    const id = await openMerge(h)
    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({ merged: true })
  })

  it('a PR GitHub no longer reports open is not merged and the card is not spent', async () => {
    const state = world()
    const { run, calls } = fakeGh(state)
    const h = await harness(run)
    const id = await openMerge(h)
    state.prState = 'CLOSED'
    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({
      status: 'pending',
      reason: 'pr_not_open',
    })
    state.prView = fail('HTTP 502')
    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({
      status: 'pending',
      reason: 'pr_unreadable',
    })
    expect(merges(calls)).toHaveLength(0)
  })

  it('opening a merge card on an unreadable PR is refused; no bare hash card exists', async () => {
    const { run } = fakeGh(world({ prView: fail('HTTP 404') }))
    const h = await harness(run)
    const res = await h.post('/api/release/merge', { repo: REPO, prNumber: PR })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('pr_unreadable')
    expect(h.store.confirmations.list({ status: 'pending' })).toHaveLength(0)
  })

  it('refuses a repo or branch that is not one plain name', async () => {
    const { run, calls } = fakeGh(world())
    const h = await harness(run)
    for (const payload of [
      { repo: '--web', branch: BRANCH, title: 'T' },
      { repo: REPO, branch: '../../evil', title: 'T' },
      { repo: REPO, branch: '-x', title: 'T' },
    ]) {
      const res = await h.post('/api/release/pr', payload)
      expect(res.status).toBe(422)
      expect(res.body.error).toBe('invalid_ref')
    }
    expect(calls).toHaveLength(0)
  })
})

describe('the merge gate reads required checks (§14), fail-closed', () => {
  const gate = async (checks: GhResult) => {
    const { run, calls } = fakeGh(world({ checks }))
    const h = await harness(run)
    const id = await openMerge(h)
    const out = await h.web.api.resolve(id, 'approve')
    return { out, calls, status: h.store.confirmations.get(id)?.status }
  }

  it('asks gh for required checks only', async () => {
    const { calls } = await gate(ok('[{"name":"unit","state":"SUCCESS"}]'))
    const read = calls.find((args) => args[0] === 'pr' && args[1] === 'checks')
    expect(read).toEqual(['pr', 'checks', '-R', REPO, '--required', '--json', 'name,state', String(PR)])
  })

  it.each(['SKIPPED', 'NEUTRAL', 'skipped'])('%s beside a success does not hold the merge', async (state) => {
    const { out } = await gate(
      ok(
        JSON.stringify([
          { name: 'a', state: 'SUCCESS' },
          { name: 'b', state },
        ]),
      ),
    )
    expect(out).toMatchObject({ merged: true })
  })

  it.each(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED'])(
    'a required %s check holds as ci_pending',
    async (state) => {
      const { out, calls, status } = await gate(
        ok(
          JSON.stringify([
            { name: 'a', state: 'SUCCESS' },
            { name: 'b', state },
          ]),
        ),
      )
      expect(out).toMatchObject({ status: 'pending', reason: 'ci_pending' })
      expect(merges(calls)).toHaveLength(0)
      expect(status).toBe('pending')
    },
  )

  it.each(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE', 'SOMETHING_NEW'])(
    'a required %s check holds as ci_failed',
    async (state) => {
      const { out, calls } = await gate(
        ok(
          JSON.stringify([
            { name: 'a', state: 'SUCCESS' },
            { name: 'b', state },
          ]),
        ),
      )
      expect(out).toMatchObject({ status: 'pending', reason: 'ci_failed' })
      expect(merges(calls)).toHaveLength(0)
    },
  )

  it('rows beside gh exit 8 (pending) still read as pending', async () => {
    const { out } = await gate({ code: 8, stdout: '[{"name":"a","state":"PENDING"}]', stderr: '' })
    expect(out).toMatchObject({ status: 'pending', reason: 'ci_pending' })
  })

  it('unreadable checks are fail-closed: an error, garbage, or green rows on a failed exit', async () => {
    for (const checks of [
      fail('HTTP 502'),
      ok('not json'),
      ok('{"name":"not an array"}'),
      { code: 1, stdout: '[{"name":"a","state":"SUCCESS"}]', stderr: '' },
    ]) {
      const { out, calls } = await gate(checks)
      expect(out).toMatchObject({ status: 'pending', reason: 'ci_unreadable' })
      expect(merges(calls)).toHaveLength(0)
    }
  })

  it('gh reporting no required checks holds; it does not read as green', async () => {
    const { out, calls } = await gate(fail("no required checks reported on the 'x' branch"))
    expect(out).toMatchObject({ status: 'pending', reason: 'no_required_checks' })
    expect(merges(calls)).toHaveLength(0)
  })
})

describe('deny and expiry are honoured before any gate', () => {
  it('deny under red CI settles denied and reads nothing from GitHub', async () => {
    const { run, calls } = fakeGh(world({ checks: ok('[{"name":"unit","state":"FAILURE"}]') }))
    const h = await harness(run)
    const id = await openMerge(h)
    calls.length = 0
    await expect(h.web.api.resolve(id, 'deny')).resolves.toMatchObject({
      status: 'denied',
      merged: false,
      reason: 'denied',
    })
    expect(calls).toHaveLength(0)
    expect(h.store.confirmations.get(id)?.status).toBe('denied')
  })

  it('the merge route honours deny under red CI too', async () => {
    const { run } = fakeGh(world({ checks: fail('HTTP 502') }))
    const h = await harness(run)
    const id = await openMerge(h)
    const res = await h.post(`/api/release/merge/${id}/resolve`, { answer: 'deny' })
    expect(res.body).toMatchObject({ merged: false, reason: 'denied' })
  })

  it('an approve after expiry expires the card and reads nothing', async () => {
    const { run, calls } = fakeGh(world({ checks: ok('[{"name":"unit","state":"FAILURE"}]') }))
    const store: Store = new MemoryRepositories()
    const deps: ReleaseDeps = {
      run,
      store,
      effects: store.effects,
      now: () => new Date('2026-11-05T00:00:00Z'),
    }
    const { confirmationId } = await openMergeCard(deps, { repo: REPO, prNumber: PR })
    calls.length = 0
    const later = { ...deps, now: () => new Date('2026-11-07T00:00:00Z') }
    const out = await mergeBehindCard(later, { confirmationId, repo: REPO, prNumber: PR, answer: 'approve' })
    expect(out).toEqual({ merged: false, reason: 'expired' })
    expect(store.confirmations.get(confirmationId)?.status).toBe('expired')
    expect(calls).toHaveLength(0)
  })
})

/**
 * A real clone of a real bare repository. Its origin is a GitHub remote, and git rewrites the
 * URL gh reports onto the bare path: the push is real and no test reaches GitHub.
 */
function gitWorld(): {
  bare: string
  work: string
  git(...args: string[]): string
  reroute(url: string): void
  unroute(): void
  headOf(ref: string): string
} {
  const root = mkdtempSync(join(tmpdir(), 'mec-release-cards-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const bare = join(root, 'owner', 'repo.git')
  mkdirSync(bare, { recursive: true })
  const work = join(root, 'work')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
  execFileSync('git', ['clone', '-q', bare, work], { stdio: 'ignore' })
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8',
    }).trim()
  git('checkout', '-q', '-B', 'main')
  writeFileSync(join(work, 'a.txt'), 'one\n')
  git('add', '.')
  git('commit', '-q', '-m', 'one')
  git('push', '-q', 'origin', 'main')
  git('checkout', '-q', '-b', BRANCH)
  writeFileSync(join(work, 'a.txt'), 'two\n')
  git('commit', '-q', '-am', 'two')
  git('remote', 'set-url', 'origin', `git@github.com:${REPO}.git`)
  const reroute = (url: string): void => {
    git('config', '--add', `url.${bare}.insteadOf`, url)
  }
  reroute(REMOTE_URL)
  return {
    bare,
    work,
    git,
    reroute,
    unroute: () => {
      git('config', '--remove-section', `url.${bare}`)
    },
    headOf: (ref) =>
      execFileSync('git', ['-C', bare, 'rev-parse', '--verify', '-q', ref], { encoding: 'utf8' }).trim(),
  }
}

const register = async (h: Harness, urlOrPath: string): Promise<string> => {
  const res = await h.post('/api/repositories', {
    urlOrPath,
    trusted: false,
    bootstrapCmds: [],
    checkCmds: [],
  })
  expect(res.status).toBe(200)
  return String(res.body.id)
}

describe('the push card (§13: git push always confirms)', () => {
  it('round trip: card binds the head, approve pushes exactly it to a real bare repo', async () => {
    const g = gitWorld()
    const { run } = fakeGh(world())
    const h = await harness(run)
    const repoId = await register(h, g.work)
    const head = g.git('rev-parse', 'HEAD')

    const opened = await h.post('/api/release/push', { repoId, branch: BRANCH })
    expect(opened.status).toBe(200)
    const id = String(opened.body.confirmationId)
    const card = h.store.confirmations.get(id) as StoreDoc
    expect(card).toMatchObject({ cls: 'push', status: 'pending', inputSha: head })
    expect(() => g.headOf(`refs/heads/${BRANCH}`)).toThrow()

    const inbox = await h.get('/api/inbox')
    expect(JSON.stringify(inbox.body)).toContain(id)

    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({
      status: 'approved',
      cls: 'push',
      pushed: true,
      headSha: head,
    })
    expect(g.headOf(`refs/heads/${BRANCH}`)).toBe(head)
    await expect(h.web.api.resolve(id, 'approve')).rejects.toSatisfy(h.web.isAlreadyHandled)
  })

  it('the dedicated resolve route pushes too, and answers already_handled on replay', async () => {
    const g = gitWorld()
    const { run } = fakeGh(world())
    const h = await harness(run)
    const repoId = await register(h, g.work)
    const opened = await h.post('/api/release/push', { repoId, branch: BRANCH })
    const id = String(opened.body.confirmationId)
    const first = await h.post(`/api/release/push/${id}/resolve`, { answer: 'approve' })
    expect(first.body).toMatchObject({ status: 'approved', pushed: true })
    const replay = await h.post(`/api/release/push/${id}/resolve`, { answer: 'approve' })
    expect(replay.status).toBe(409)
    expect(replay.body).toMatchObject({ error: 'already_handled' })
  })

  it.each([
    ['ssh', 'git@github.com:owner/repo.git'],
    ['https', 'https://github.com/owner/repo.git'],
    ['https without .git', 'https://github.com/owner/repo'],
    ['a trailing slash', 'https://github.com/owner/repo/'],
    ['ssh://', 'ssh://git@github.com/owner/repo.git'],
    ['another letter case', 'https://github.com/Owner/Repo.git'],
  ])('the GitHub repository comes from the clone origin, %s', async (_, origin) => {
    const g = gitWorld()
    g.unroute()
    g.git('remote', 'set-url', 'origin', origin)
    const { run, calls } = fakeGh(world())
    const h = await harness(run)
    const repoId = await register(h, g.work)
    const opened = await h.post('/api/release/push', { repoId, branch: BRANCH })
    expect(opened.status).toBe(200)
    expect(calls[0]?.slice(0, 2)).toEqual(['repo', 'view'])
    expect(String(calls[0]?.[2]).toLowerCase()).toBe(REPO)
  })

  it.each([
    ['a long flag', 'https://x/--branch=a/b'],
    ['a short flag that fits the slug characters', 'https://github.com/-b/x'],
    ['a flag over ssh', 'git@github.com:--web/repo.git'],
  ])('an origin that gh would read as a flag never reaches gh, %s', async (_, origin) => {
    const g = gitWorld()
    g.git('remote', 'set-url', 'origin', origin)
    const { run, calls } = fakeGh(world())
    const h = await harness(run)
    const repoId = await register(h, g.work)
    const res = await h.post('/api/release/push', { repoId, branch: BRANCH })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('invalid_ref')
    expect(calls).toHaveLength(0)
    expect(h.store.confirmations.list({ status: 'pending' })).toHaveLength(0)
  })

  it('an origin turned into a flag after the card opened holds the card; gh never sees it', async () => {
    const g = gitWorld()
    const { run, calls } = fakeGh(world())
    const h = await harness(run)
    const repoId = await register(h, g.work)
    const opened = await h.post('/api/release/push', { repoId, branch: BRANCH })
    const id = String(opened.body.confirmationId)
    g.git('remote', 'set-url', 'origin', 'https://x/--branch=a/b')
    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({
      status: 'pending',
      reason: 'invalid_ref',
    })
    expect(calls.flat()).not.toContain('--branch=a/b')
    expect(() => g.headOf(`refs/heads/${BRANCH}`)).toThrow()
  })

  it('a caller-named repo that gh would read as a flag is refused too', async () => {
    const { run, calls } = fakeGh(world())
    const h = await harness(run)
    const res = await h.post('/api/release/merge', { repo: '-b/x', prNumber: PR })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('invalid_ref')
    expect(calls).toHaveLength(0)
  })

  it.each([
    ['another host', 'https://ghe.corp.example/owner/repo.git'],
    ['a lookalike host', 'https://github.com.evil.example/owner/repo'],
    ['a deeper path', 'https://gitlab.com/group/owner/repo.git'],
    ['a local path', '/tmp/x/owner/repo.git'],
    ['a file url', 'file:///tmp/x/owner/repo.git'],
    ['plain http', 'http://github.com/owner/repo.git'],
    ['ssh to another host', 'git@gitlab.com:owner/repo.git'],
  ])('a same-named repository is not the origin: %s opens no card', async (_, origin) => {
    const g = gitWorld()
    g.git('remote', 'set-url', 'origin', origin)
    const { run } = fakeGh(world())
    const h = await harness(run)
    const repoId = await register(h, g.work)
    const res = await h.post('/api/release/push', { repoId, branch: BRANCH })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('remote_unreadable')
    expect(JSON.stringify(res.body)).not.toContain(origin)
    expect(h.store.confirmations.list({ status: 'pending' })).toHaveLength(0)
  })

  it('gh naming another repository than the origin opens no card', async () => {
    const g = gitWorld()
    const { run } = fakeGh(world({ remoteUrl: 'https://github.com/someone/repo' }))
    const h = await harness(run)
    const repoId = await register(h, g.work)
    const res = await h.post('/api/release/push', { repoId, branch: BRANCH })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('remote_unreadable')
  })

  it('an origin on the host gh serves is that repository, enterprise hosts included', async () => {
    const g = gitWorld()
    g.git('remote', 'set-url', 'origin', 'https://ghe.corp.example/owner/repo.git')
    const { run } = fakeGh(world({ remoteUrl: 'https://ghe.corp.example/owner/repo' }))
    const h = await harness(run)
    const repoId = await register(h, g.work)
    const res = await h.post('/api/release/push', { repoId, branch: BRANCH })
    expect(res.status).toBe(200)
  })

  it('the card names the remote, and a same-named repository on another host does not satisfy it', async () => {
    const g = gitWorld()
    const state = world()
    const { run } = fakeGh(state)
    const h = await harness(run)
    const repoId = await register(h, g.work)
    const opened = await h.post('/api/release/push', { repoId, branch: BRANCH })
    const id = String(opened.body.confirmationId)
    const detail = await h.get(`/api/inbox/${id}/detail`)
    expect(detail.body.facts).toContainEqual({ label: 'Remote', value: REMOTE_URL, mono: true })

    const moved = 'https://ghe.corp.example/owner/repo'
    g.reroute(moved)
    g.git('remote', 'set-url', 'origin', 'git@ghe.corp.example:owner/repo.git')
    state.remoteUrl = moved
    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({
      status: 'pending',
      reason: 'remote_unreadable',
    })
    expect(() => g.headOf(`refs/heads/${BRANCH}`)).toThrow()
  })

  it('approve pushes to the URL it checked: gh is asked once, not again at the push', async () => {
    const g = gitWorld()
    const { run, calls } = fakeGh(world())
    const h = await harness(run)
    const repoId = await register(h, g.work)
    const opened = await h.post('/api/release/push', { repoId, branch: BRANCH })
    calls.length = 0
    await expect(h.web.api.resolve(String(opened.body.confirmationId), 'approve')).resolves.toMatchObject({
      pushed: true,
    })
    expect(calls.filter((a) => a[0] === 'repo' && a[1] === 'view')).toHaveLength(1)
  })

  it('a key-shaped branch or repository is refused, and the refusal does not repeat it', async () => {
    const g = gitWorld()
    g.git('branch', GH_KEY)
    const { run, calls } = fakeGh(world())
    const h = await harness(run)
    const repoId = await register(h, g.work)
    const pushed = await h.post('/api/release/push', { repoId, branch: GH_KEY })
    const pr = await h.post('/api/release/pr', { repo: REPO, branch: GH_KEY, title: 'T', body: 'B' })
    const repo = await h.post('/api/release/pr', {
      repo: `owner/${GH_KEY}`,
      branch: BRANCH,
      title: 'T',
      body: 'B',
    })
    for (const res of [pushed, pr, repo]) {
      expect(res.status).toBe(422)
      expect(res.body.error).toBe('invalid_ref')
      expect(JSON.stringify(res.body)).not.toContain(GH_KEY)
    }
    expect(calls).toHaveLength(0)
    expect(h.store.confirmations.list({ status: 'pending' })).toHaveLength(0)
  })

  it('a clone whose origin changed after the card opened does not push', async () => {
    const g = gitWorld()
    const state = world()
    const { run } = fakeGh(state)
    const h = await harness(run)
    const repoId = await register(h, g.work)
    const opened = await h.post('/api/release/push', { repoId, branch: BRANCH })
    const id = String(opened.body.confirmationId)
    g.reroute('https://github.com/someone/else')
    g.git('remote', 'set-url', 'origin', 'git@github.com:someone/else.git')
    state.remoteUrl = 'https://github.com/someone/else'
    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({
      status: 'pending',
      reason: 'remote_unreadable',
    })
    expect(() => g.headOf(`refs/heads/${BRANCH}`)).toThrow()
  })

  it('deny pushes nothing', async () => {
    const g = gitWorld()
    const { run } = fakeGh(world())
    const h = await harness(run)
    const repoId = await register(h, g.work)
    const opened = await h.post('/api/release/push', { repoId, branch: BRANCH })
    const id = String(opened.body.confirmationId)
    await expect(h.web.api.resolve(id, 'deny')).resolves.toMatchObject({ status: 'denied' })
    expect(() => g.headOf(`refs/heads/${BRANCH}`)).toThrow()
  })

  it('never takes a path from the caller: the repo must be registered', async () => {
    const g = gitWorld()
    const { run } = fakeGh(world())
    const h = await harness(run)
    const res = await h.post('/api/release/push', { repoId: 'repo_nope', gitDir: g.work, branch: BRANCH })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('unknown_repo')
    const noId = await h.post('/api/release/push', { gitDir: g.work, branch: BRANCH })
    expect(noId.status).toBe(400)
    expect(h.store.confirmations.list({ status: 'pending' })).toHaveLength(0)
  })

  it('a repository registered by url has no local git dir to push from', async () => {
    const { run } = fakeGh(world())
    const h = await harness(run)
    const repoId = await register(h, 'https://github.com/owner/repo')
    const res = await h.post('/api/release/push', { repoId, branch: BRANCH })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('repo_not_local')
  })

  it('no caller can supply the push directory', async () => {
    const { run } = fakeGh(world())
    const g = gitWorld()
    const elsewhere = mkdtempSync(join(tmpdir(), 'mec-elsewhere-'))
    cleanups.push(() => rmSync(elsewhere, { recursive: true, force: true }))
    execFileSync('git', ['init', '-q', '-b', 'main', elsewhere])
    const store: Store = new MemoryRepositories()
    store.atomic(() => store.engines.save({ id: 'repo_a', url: g.work }))
    const deps: ReleaseDeps = { run, store, effects: store.effects, now: () => new Date() }
    const head = g.git('rev-parse', 'HEAD')
    const card = await openPushCard(deps, {
      repoId: 'repo_a',
      branch: BRANCH,
      gitDir: elsewhere,
      worktree: elsewhere,
    } as never)
    expect(card.headSha).toBe(head)

    const h = await harness(run)
    h.store.atomic(() => h.store.engines.save({ id: 'repo_a', url: g.work }))
    const res = await h.post('/api/release/push', { repoId: 'repo_a', branch: BRANCH, gitDir: elsewhere })
    expect(res.body.headSha).toBe(head)
  })

  it('a branch built in the cache pushes from there, with the slug from the clone', async () => {
    const { run } = fakeGh(world())
    const g = gitWorld()
    const cache = mkdtempSync(join(tmpdir(), 'mec-cache-'))
    cleanups.push(() => rmSync(cache, { recursive: true, force: true }))
    execFileSync('git', ['clone', '-q', '--bare', g.work, cache], { stdio: 'ignore' })
    execFileSync('git', ['-C', cache, 'branch', 'mec/ab/integration', 'refs/heads/main'])
    const main = execFileSync('git', ['-C', cache, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()
    const store: Store = new MemoryRepositories()
    store.atomic(() => store.engines.save({ id: 'repo_a', url: g.work }))
    const deps: ReleaseDeps = {
      run,
      store,
      effects: store.effects,
      now: () => new Date(),
      pushSource: () => ({ gitDir: cache }),
    }
    const card = await openPushCard(deps, { repoId: 'repo_a', branch: 'mec/ab/integration' })
    expect(card.headSha).toBe(main)
    expect(store.confirmations.get(card.confirmationId)?.payload).toMatchObject({ repo: REPO })
  })

  it('a URL-registered repository can push from the cache, its slug from the URL', async () => {
    const { run } = fakeGh(world())
    const g = gitWorld()
    const cache = mkdtempSync(join(tmpdir(), 'mec-cache-'))
    cleanups.push(() => rmSync(cache, { recursive: true, force: true }))
    execFileSync('git', ['clone', '-q', '--bare', g.work, cache], { stdio: 'ignore' })
    execFileSync('git', ['-C', cache, 'branch', 'mec/ab/integration', 'refs/heads/main'])
    const store: Store = new MemoryRepositories()
    store.atomic(() => store.engines.save({ id: 'repo_a', url: `${REMOTE_URL}.git` }))
    const deps: ReleaseDeps = {
      run,
      store,
      effects: store.effects,
      now: () => new Date(),
      pushSource: () => ({ gitDir: cache }),
    }
    const card = await openPushCard(deps, { repoId: 'repo_a', branch: 'mec/ab/integration' })
    expect(store.confirmations.get(card.confirmationId)?.payload).toMatchObject({ repo: REPO })
    // Any branch but a cache branch still has no directory to push from.
    const without = { ...deps, pushSource: () => undefined }
    await expect(openPushCard(without, { repoId: 'repo_a', branch: 'feat/x' })).rejects.toThrow(
      'repo_not_local',
    )
  })

  it('default branch still refused', async () => {
    const { run } = fakeGh(world({ defaultBranch: 'mec/ab/integration' }))
    const g = gitWorld()
    const cache = mkdtempSync(join(tmpdir(), 'mec-cache-'))
    cleanups.push(() => rmSync(cache, { recursive: true, force: true }))
    execFileSync('git', ['clone', '-q', '--bare', g.work, cache], { stdio: 'ignore' })
    const store: Store = new MemoryRepositories()
    store.atomic(() => store.engines.save({ id: 'repo_a', url: g.work }))
    const deps: ReleaseDeps = {
      run,
      store,
      effects: store.effects,
      now: () => new Date(),
      pushSource: () => ({ gitDir: cache }),
    }
    await expect(openPushCard(deps, { repoId: 'repo_a', branch: 'mec/ab/integration' })).rejects.toThrow(
      'default_branch',
    )
  })

  it('refuses the default branch, whatever it is called', async () => {
    const g = gitWorld()
    const { run } = fakeGh(world({ defaultBranch: BRANCH }))
    const h = await harness(run)
    const repoId = await register(h, g.work)
    const res = await h.post('/api/release/push', { repoId, branch: BRANCH })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('default_branch')
    expect(h.store.confirmations.list({ status: 'pending' })).toHaveLength(0)
  })

  it('the default branch cannot be read: no card (fail-closed)', async () => {
    const g = gitWorld()
    const { run } = fakeGh(world({ repoView: fail('HTTP 502') }))
    const h = await harness(run)
    const repoId = await register(h, g.work)
    const res = await h.post('/api/release/push', { repoId, branch: BRANCH })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('remote_unreadable')
  })

  it('a stated head that is not the local head is refused; a missing branch is refused', async () => {
    const g = gitWorld()
    const { run } = fakeGh(world())
    const h = await harness(run)
    const repoId = await register(h, g.work)
    const stale = await h.post('/api/release/push', { repoId, branch: BRANCH, headSha: MOVED })
    expect(stale.status).toBe(422)
    expect(stale.body.error).toBe('stale_head')
    const missing = await h.post('/api/release/push', { repoId, branch: 'no/such-branch' })
    expect(missing.status).toBe(422)
    expect(missing.body.error).toBe('head_unreadable')
  })

  it('a head that moved after the card opened stales the card and pushes nothing', async () => {
    const g = gitWorld()
    const { run } = fakeGh(world())
    const h = await harness(run)
    const repoId = await register(h, g.work)
    const opened = await h.post('/api/release/push', { repoId, branch: BRANCH })
    const id = String(opened.body.confirmationId)
    writeFileSync(join(g.work, 'a.txt'), 'three\n')
    g.git('commit', '-q', '-am', 'three')
    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({
      status: 'stale',
      reason: 'stale_head',
    })
    expect(() => g.headOf(`refs/heads/${BRANCH}`)).toThrow()
  })

  it('an unreachable remote at approve leaves the card pending', async () => {
    const g = gitWorld()
    const state = world()
    const { run } = fakeGh(state)
    const h = await harness(run)
    const repoId = await register(h, g.work)
    const opened = await h.post('/api/release/push', { repoId, branch: BRANCH })
    const id = String(opened.body.confirmationId)
    state.repoView = fail('HTTP 502')
    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({
      status: 'pending',
      reason: 'remote_unreadable',
    })
    expect(h.store.confirmations.get(id)?.status).toBe('pending')
  })

  it('never forces: a diverged remote rejects, the remote keeps its head, the failure is on record', async () => {
    const g = gitWorld()
    const { run } = fakeGh(world())
    const h = await harness(run)
    const repoId = await register(h, g.work)
    // The remote branch diverges from what the card will push.
    const local = g.git('rev-parse', 'HEAD')
    g.git('checkout', '-q', '-b', 'other', 'main')
    writeFileSync(join(g.work, 'b.txt'), 'theirs\n')
    g.git('add', '.')
    g.git('commit', '-q', '-m', 'theirs')
    g.git('push', '-q', g.bare, `other:refs/heads/${BRANCH}`)
    const theirs = g.headOf(`refs/heads/${BRANCH}`)

    const opened = await h.post('/api/release/push', { repoId, branch: BRANCH, headSha: local })
    const id = String(opened.body.confirmationId)
    const out = await h.web.api.resolve(id, 'approve')
    expect(out).toMatchObject({ status: 'approved', pushed: false })
    expect(String(out.error)).toContain('rejected')
    expect(g.headOf(`refs/heads/${BRANCH}`)).toBe(theirs)
    const events = h.store.events.read(`release:${REPO}:${BRANCH}`)
    expect(events.map((event) => event.type)).toEqual(['push_card_opened', 'push_failed'])
    expect(JSON.stringify(events.at(-1)?.body)).toContain('rejected')
  })

  it('a key-shaped string in git output is redacted before the failure is stored', async () => {
    const g = gitWorld()
    const exec: GitExec = async (args) =>
      args.includes('push')
        ? fail(`remote: bad token ${SECRET}`)
        : ok(execFileSync('git', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
    const { run } = fakeGh(world())
    const h = await harness(run, exec)
    const repoId = await register(h, g.work)
    const opened = await h.post('/api/release/push', { repoId, branch: BRANCH })
    const out = await h.web.api.resolve(String(opened.body.confirmationId), 'approve')
    expect(JSON.stringify(out)).not.toContain(SECRET)
    expect(JSON.stringify(h.store.events.read(`release:${REPO}:${BRANCH}`))).not.toContain(SECRET)
  })

  it('an uncertain push reconciles by head before reporting (§20 gh / git push failure)', async () => {
    const { run } = fakeGh(world())
    const seen: string[] = []
    const out = await pushIntegrationBranch(
      run,
      REPO,
      '/tmp/git',
      { branch: BRANCH, headSha: HEAD },
      async (args) => {
        seen.push(String(args[2]))
        return args[2] === 'push' ? fail('', -1) : ok(`${HEAD}\trefs/heads/${BRANCH}\n`)
      },
    )
    expect(out).toEqual({ pushed: true })
    expect(seen).toEqual(['push', 'ls-remote'])
  })
})

describe('nothing key-shaped from GitHub becomes durable (§13 invariant 3)', () => {
  it('a key-shaped PR head branch is stored and shown redacted', async () => {
    const { run } = fakeGh(world({ prBranch: GH_KEY }))
    const h = await harness(run)
    const id = await openMerge(h)
    expect(JSON.stringify(h.store.confirmations.get(id))).not.toContain(GH_KEY)
    const detail = await h.get(`/api/inbox/${id}/detail`)
    expect(JSON.stringify(detail.body)).not.toContain(GH_KEY)
  })

  it('key-shaped check rows are redacted in the ci_observed event', async () => {
    const checks = ok(JSON.stringify([{ name: GH_KEY, state: `PENDING ${GH_KEY}` }]))
    const { run } = fakeGh(world({ checks }))
    const h = await harness(run)
    const id = await openMerge(h)
    await expect(h.web.api.resolve(id, 'approve')).resolves.toMatchObject({ status: 'pending' })
    const events = h.store.events.read(`release:${REPO}:pr-${PR}`)
    expect(events.map((event) => event.type)).toContain('ci_observed')
    expect(JSON.stringify(events)).not.toContain(GH_KEY)
  })
})

describe('the card shows exactly what is approved (§13 "the exact diff or command")', () => {
  const factsOf = (detail: Record<string, unknown>): Record<string, string> =>
    Object.fromEntries(
      (detail.facts as Array<{ label: string; value: string }>).map((fact) => [fact.label, fact.value]),
    )

  it('serves repo, branch, head, title and body for a pr_create card', async () => {
    const { run } = fakeGh(world())
    const h = await harness(run)
    const id = await openPrCard(h)
    const res = await h.get(`/api/inbox/${id}/detail`)
    expect(res.status).toBe(200)
    expect(factsOf(res.body)).toMatchObject({
      Repository: REPO,
      Branch: BRANCH,
      Head: HEAD,
      Title: 'T',
      Body: 'B',
    })
    expect(res.body.operation).toBe(h.store.confirmations.get(id)?.operationHash)
    expect(String(res.body.what)).toContain('pull request')
    expect(res.body.verb).toBe('open the PR')
  })

  it('serves repo, PR number, title, branch and head for a pr_merge card, naming the squash', async () => {
    const { run } = fakeGh(world())
    const h = await harness(run)
    const id = await openMerge(h)
    const res = await h.get(`/api/inbox/${id}/detail`)
    expect(factsOf(res.body)).toMatchObject({
      Repository: REPO,
      'Pull request': `#${PR}`,
      Title: 'Ship the smoke test',
      Branch: BRANCH,
      Head: HEAD,
    })
    expect(String(res.body.what).toLowerCase()).toContain('squash')
    expect(res.body.verb).toBe('squash-merge')
  })

  it('serves repo, branch and head for a push card, and never claims to open a PR', async () => {
    const g = gitWorld()
    const { run } = fakeGh(world())
    const h = await harness(run)
    const repoId = await register(h, g.work)
    const opened = await h.post('/api/release/push', { repoId, branch: BRANCH })
    const res = await h.get(`/api/inbox/${String(opened.body.confirmationId)}/detail`)
    expect(factsOf(res.body)).toMatchObject({
      Repository: REPO,
      Branch: BRANCH,
      Head: g.git('rev-parse', 'HEAD'),
    })
    expect(res.body.verb).toBe('push')
    expect(JSON.stringify(res.body)).not.toMatch(/open(ing|s)? (a|the) (PR|pull request)/i)
  })

  it('answers 404 for a card with no release payload and for an unknown id', async () => {
    const { run } = fakeGh(world())
    const h = await harness(run)
    h.store.confirmations.save({
      id: 'conf_install',
      cls: 'install',
      operationHash: 'op',
      status: 'pending',
      createdAt: '2026-11-05T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
    })
    expect((await h.get('/api/inbox/conf_install/detail')).status).toBe(404)
    expect((await h.get('/api/inbox/conf_missing/detail')).status).toBe(404)
  })

  describe('a card the meta agent opened with request_confirmation (§13 hard invariant 2)', () => {
    const REPO_ID = 'repo_main'
    const openPlannerCard = async (
      h: Harness,
      draft: Partial<NonNullable<MetaDecision['confirmations']>[number]>,
    ): Promise<string> => {
      const id = 'conf_planner1'
      h.store.atomic(() => {
        h.store.engines.save({
          id: REPO_ID,
          url: 'https://example.test/main',
          bootstrap: [],
          checks: [],
          trust: true,
        })
      })
      const service = new MetaAgentService({
        store: h.store,
        effects: h.store.effects,
        brain: fakeBrain({
          ack: 'On it.',
          confirmations: [
            {
              id,
              cls: 'frontier_model',
              operationHash: 'f'.repeat(64),
              expiresAt: '2999-01-01T00:00:00.000Z',
              operation: { class: 'frontier_model', model: 'the-frontier-model' },
              evidence: { reason: 'The migration needs it', tasks: ['t1', 't2'] },
              ...draft,
            },
          ],
        }),
      })
      await service.onUserMessage({ messageId: 'msg_1', text: 'plan it', repoId: REPO_ID })
      expect(h.store.confirmations.get(id)?.status).toBe('pending')
      return id
    }
    const approvable = async (h: Harness, id: string): Promise<boolean> => {
      const cards = (await import(/* @vite-ignore */ WEB_CARDS)) as { canApprove(detail: unknown): boolean }
      return cards.canApprove(await h.web.api.decisionDetail(id))
    }

    it('serves the operation and evidence it was opened with, so it stays approvable', async () => {
      const { run } = fakeGh(world())
      const h = await harness(run)
      const id = await openPlannerCard(h, {})
      const res = await h.get(`/api/inbox/${id}/detail`)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        what: 'The meta agent asks for: frontier model',
        verb: 'approve',
        operation: 'f'.repeat(64),
        requestedBy: 'The meta agent',
      })
      expect(factsOf(res.body)).toMatchObject({
        Class: 'frontier_model',
        'Operation: model': 'the-frontier-model',
        'Evidence: reason': 'The migration needs it',
        'Evidence: tasks': '["t1","t2"]',
      })
      expect(factsOf(res.body)).not.toHaveProperty('Operation: class')
      expect(await approvable(h, id)).toBe(true)
      expect((await h.web.api.resolve(id, 'approve')).status).toBe('approved')
    })

    it('an always-confirm class says nothing here can run it, and the approve stays refused', async () => {
      const { run, calls } = fakeGh(world())
      const h = await harness(run)
      const id = await openPlannerCard(h, { cls: 'push', operation: { class: 'push', branch: 'main' } })
      const res = await h.get(`/api/inbox/${id}/detail`)
      expect(res.status).toBe(200)
      expect(JSON.stringify(res.body.consequences)).toContain('Nothing here can run')
      const approve = await h.post(`/api/inbox/${id}/resolve`, { answer: 'approve' })
      expect(approve.status).toBe(422)
      expect(calls).toEqual([])
    })

    it('never shows a key-shaped string the agent put in its evidence', async () => {
      const { run } = fakeGh(world())
      const h = await harness(run)
      const id = await openPlannerCard(h, { evidence: { pasted: `key ${SECRET}` } })
      expect(JSON.stringify((await h.get(`/api/inbox/${id}/detail`)).body)).not.toContain(SECRET)
    })

    it('field names and the class are redacted too, on a card stored before writes were', async () => {
      const { run } = fakeGh(world())
      const h = await harness(run)
      const id = await openPlannerCard(h, {
        cls: `frontier ${SECRET}`,
        operation: { class: 'frontier_model', [`op ${SECRET}`]: 'x' },
        evidence: { [`why ${SECRET}`]: 'y' },
      })
      // The service redacts on the way in, so this is the row an older build left.
      const stored = h.store.confirmations.get(id)
      h.store.confirmations.save({
        ...stored,
        id,
        cls: `frontier ${SECRET}`,
        payload: {
          operation: { class: 'frontier_model', [`op ${SECRET}`]: 'x' },
          evidence: { [`why ${SECRET}`]: 'y' },
        },
      })
      expect(JSON.stringify((await h.get(`/api/inbox/${id}/detail`)).body)).not.toContain(SECRET)
    })

    it('a card that carries no evidence has none to serve: not approvable, still deniable', async () => {
      const { run } = fakeGh(world())
      const h = await harness(run)
      const id = await openPlannerCard(h, { operation: { class: 'frontier_model' }, evidence: {} })
      expect((await h.get(`/api/inbox/${id}/detail`)).status).toBe(404)
      expect(await approvable(h, id)).toBe(false)
      expect((await h.web.api.resolve(id, 'deny')).status).toBe('denied')
    })
  })

  it('a server failure on the evidence stays a failure to retry, never the no-evidence answer', async () => {
    const { run } = fakeGh(world())
    const h = await harness(run)
    const served = globalThis.fetch
    globalThis.fetch = (async () => new Response('{}', { status: 503 })) as typeof fetch
    await expect(h.web.api.decisionDetail('conf_any')).rejects.toThrow()
    globalThis.fetch = served
  })

  it('a key-shaped string in a PR title or body never becomes durable', async () => {
    const { run, calls } = fakeGh(world())
    const h = await harness(run)
    const res = await h.post('/api/release/pr', {
      repo: REPO,
      branch: BRANCH,
      title: `t ${SECRET}`,
      body: `b ${SECRET}`,
    })
    const id = String(res.body.confirmationId)
    expect(JSON.stringify(h.store.confirmations.get(id))).not.toContain(SECRET)
    await h.web.api.resolve(id, 'approve')
    expect(JSON.stringify(calls)).not.toContain(SECRET)
  })
})

describe('the inbox hears release cards (the tray refreshes without a reload)', () => {
  it('every card opening and settling lands on the fixed inbox stream', async () => {
    const { run } = fakeGh(world())
    const h = await harness(run)
    const id = await openMerge(h)
    expect(h.store.events.read('inbox').map((event) => event.type)).toEqual(['merge_card_opened'])
    await h.web.api.resolve(id, 'approve')
    expect(h.store.events.read('inbox').map((event) => event.type)).toEqual([
      'merge_card_opened',
      'merged_on_github',
    ])
  })
})

describe('resolvePrCreate keeps its direct shape', () => {
  it('reports stale without a gh write', async () => {
    const state = world()
    const { run, calls } = fakeGh(state)
    const store: Store = new MemoryRepositories()
    const deps: ReleaseDeps = { run, store, effects: store.effects, now: () => new Date() }
    const { confirmationId } = await createPrBehindCard(deps, {
      repo: REPO,
      branch: BRANCH,
      title: 'T',
      body: 'B',
    })
    state.head = ok(`${MOVED}\n`)
    await expect(resolvePrCreate(deps, { confirmationId, answer: 'approve' })).resolves.toEqual({
      status: 'stale',
      reason: 'stale_head',
    })
    expect(creates(calls)).toHaveLength(0)
  })
})
