/**
 * The release agent's GitHub leg (§14/R1.7) on fakes only: a recording GhRun, a
 * MemoryRepositories store, an injectable git exec. No test touches a real repository or
 * a real gh — the assertions are about the confirmation discipline (§13: pr_create and
 * pr_merge are always-confirm; nothing leaves the machine unresolved) and about merged
 * being confirmed by GitHub's own state, never by the merge call's exit.
 */
import { createHash } from 'node:crypto'
import type { HealthBoard, HealthClaim, Store, StoreDoc } from '@mec/contracts'
import { MemoryRepositories } from '@mec/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildPrBody,
  createPrBehindCard,
  type GhResult,
  type GhRun,
  mergeBehindCard,
  openMergeCard,
  pushIntegrationBranch,
  type ReleaseDeps,
  resolvePrCreate,
  yieldCheck,
} from '../src/release'
import { buildServer, type ServerDeps } from '../src/server'

const AT = '2026-11-03T12:00:00.000Z'
const NOW = (): Date => new Date(AT)
const REPO = 'owner/repo'
const BRANCH = 'mec/wi1/integration'
const FLOW_ID = `prflow:${REPO}:${BRANCH}`
const TITLE = 'Ship the smoke test'
const BODY = '## Request\n\nship it\n'
const HEAD = 'a'.repeat(40)

type Call = { args: readonly string[]; stdin?: string }

const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string): GhResult => ({ code: 1, stdout: '', stderr })

/**
 * A recording fake: every call is captured; the responder routes by the joined argv text.
 * The branch-head read answers HEAD unless the responder takes it: a card binds the head it
 * shows (§13), so every pr_create card reads it once when it opens.
 */
function fakeGh(respond: (args: readonly string[]) => GhResult | undefined): { run: GhRun; calls: Call[] } {
  const calls: Call[] = []
  const run: GhRun = async (args, opts) => {
    calls.push({ args, stdin: opts?.stdin })
    if (args.join(' ').includes('/git/ref/heads/')) return ok(`${HEAD}\n`)
    return respond(args) ?? ok('')
  }
  return { run, calls }
}

/** The calls that change something on GitHub; reads are not side effects (§13 invariant 1). */
const writes = (calls: Call[]): Call[] =>
  calls.filter((call) => call.args[0] === 'pr' && ['create', 'merge'].includes(String(call.args[1])))

/** A PR as `gh pr view --json …` reports it: open, mergeable, on the bound head. */
const PR_FACTS = JSON.stringify({
  state: 'OPEN',
  title: TITLE,
  headRefName: BRANCH,
  headRefOid: HEAD,
  mergeStateStatus: 'CLEAN',
})
const prFacts = (args: readonly string[]): GhResult | undefined =>
  args[0] === 'pr' && args[1] === 'view' && args.join(' ').includes('headRefOid') ? ok(PR_FACTS) : undefined

function makeDeps(run: GhRun): { store: Store; deps: ReleaseDeps } {
  const store: Store = new MemoryRepositories()
  return { store, deps: { run, store, effects: store.effects, now: NOW } }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Minimal HealthBoard double — the release routes never read it, buildServer requires it. */
const fakeHealth: HealthBoard = {
  claim(): HealthClaim {
    return { starting: () => {}, ready: () => {}, paused: () => {}, error: () => {} }
  },
}

function makeServer(run: GhRun): { store: Store; app: ReturnType<typeof buildServer> } {
  const store: Store = new MemoryRepositories()
  const deps: ServerDeps = {
    store,
    effects: store.effects,
    health: fakeHealth,
    policyText: '{"preAuthorised":{}}',
    now: NOW,
    ghRun: run,
  }
  const app = buildServer(deps)
  servers.push(app)
  return { store, app }
}

const servers: ReturnType<typeof buildServer>[] = []
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

describe('yieldCheck (§14 yield-to-duplicate first)', () => {
  it('yields to an open PR whose files are a strict superset of the change', async () => {
    const { run } = fakeGh((args) => {
      const text = args.join(' ')
      if (text.includes('pr list')) return ok(JSON.stringify([{ number: 7, headRefName: 'human/fix' }]))
      if (text.includes('pr view'))
        return ok(JSON.stringify({ files: [{ filename: 'a.ts' }, { filename: 'b.ts' }] }))
      return ok('')
    })
    await expect(yieldCheck(run, REPO, ['a.ts'])).resolves.toEqual({ yieldTo: 'human/fix' })
  })

  it('partial overlap is related work, not a duplicate', async () => {
    const { run } = fakeGh((args) => {
      const text = args.join(' ')
      if (text.includes('pr list')) return ok(JSON.stringify([{ number: 7, headRefName: 'human/fix' }]))
      if (text.includes('pr view')) return ok(JSON.stringify({ files: [{ filename: 'a.ts' }] }))
      if (text.includes('/branches')) return ok('main\nhuman/fix\n')
      if (text.includes('/compare/')) return ok('a.ts\nc.ts\n')
      return ok('')
    })
    await expect(yieldCheck(run, REPO, ['a.ts', 'b.ts'])).resolves.toEqual({ yieldTo: null })
  })

  it('falls back to remote branches and yields when one contains every changed file', async () => {
    const { run } = fakeGh((args) => {
      const text = args.join(' ')
      if (text.includes('pr list')) return ok('[]')
      if (text.includes('/branches')) return ok('main\nfeat/everything\n')
      if (text.includes('/compare/')) return ok('a.ts\nb.ts\n')
      return ok('')
    })
    await expect(yieldCheck(run, REPO, ['a.ts', 'b.ts'])).resolves.toEqual({ yieldTo: 'feat/everything' })
  })

  it('an empty change set never yields', async () => {
    const { run, calls } = fakeGh(() => ok('[]'))
    await expect(yieldCheck(run, REPO, [])).resolves.toEqual({ yieldTo: null })
    expect(calls).toHaveLength(0)
  })
})

describe('buildPrBody (§14 evidence in the PR body)', () => {
  it('carries the request verbatim and every section', () => {
    const request = 'Ship the smoke test\nwith a second line, "quoted" & <bracketed>'
    const body = buildPrBody({
      request,
      tasks: [
        { id: 'task_impl', role: 'implementer', acceptedSha: 'a'.repeat(40) },
        { id: 'task_rev', role: 'code_reviewer' },
      ],
      integrationSha: 'b'.repeat(40),
      checks: [
        { name: 'unit', status: 'passed' },
        { name: 'typecheck', status: 'passed' },
      ],
      findings: ['medium: the error path swallows the cause'],
      decisions: ['accepted: finding routed to a repair task'],
    })
    expect(body).toContain(request)
    expect(body).toContain('## Request')
    expect(body).toContain('## Tasks')
    expect(body).toContain(`| task_impl | implementer | ${'a'.repeat(40)} |`)
    expect(body).toContain('| task_rev | code_reviewer | — |')
    expect(body).toContain('## Integration')
    expect(body).toContain(`\`${'b'.repeat(40)}\``)
    expect(body).toContain('| unit | passed |')
    expect(body).toContain('| typecheck | passed |')
    expect(body).toContain('## Findings')
    expect(body).toContain('- medium: the error path swallows the cause')
    expect(body).toContain('## Decisions')
    expect(body).toContain('- accepted: finding routed to a repair task')
    expect(body).toContain('Opened by MEC (Mubit Engineering Control); every action behind a confirmed card.')
  })
})

describe('pr_create behind a card (§13: always confirm, never pre-authorisable)', () => {
  it('opens a pending pr_create confirmation bound to the branch head, and writes nothing', async () => {
    const { run, calls } = fakeGh(() => ok(''))
    const { store, deps } = makeDeps(run)
    const opened = await createPrBehindCard(deps, { repo: REPO, branch: BRANCH, title: TITLE, body: BODY })
    expect(opened.confirmationId).toMatch(/^conf_/)
    expect(writes(calls)).toHaveLength(0)
    const card = store.confirmations.get(opened.confirmationId) as StoreDoc
    expect(card.cls).toBe('pr_create')
    expect(card.status).toBe('pending')
    expect(card.operationHash).toBe(sha256(TITLE + BODY + BRANCH + HEAD))
    expect(card.inputSha).toBe(HEAD)
    // §14: integration complete → the delivery is ready for its PR.
    expect(store.engines.get(FLOW_ID)?.state).toBe('ready_for_pr')
  })

  it('approve → exactly one gh pr create, head/title flags, body by stdin, prflow pr_open', async () => {
    const { run, calls } = fakeGh((args) =>
      args.includes('create') ? ok('https://github.com/owner/repo/pull/12\n') : ok(''),
    )
    const { store, deps } = makeDeps(run)
    const { confirmationId } = await createPrBehindCard(deps, {
      repo: REPO,
      branch: BRANCH,
      title: TITLE,
      body: BODY,
    })
    const resolved = await resolvePrCreate(deps, { confirmationId, answer: 'approve' })
    expect(resolved).toEqual({
      status: 'approved',
      prNumber: 12,
      prUrl: 'https://github.com/owner/repo/pull/12',
    })
    const creates = calls.filter((call) => call.args.includes('create'))
    expect(creates).toHaveLength(1)
    const args = creates[0]?.args ?? []
    expect(args.slice(0, 2)).toEqual(['pr', 'create'])
    expect(args).toContain('-R')
    expect(args[args.indexOf('-R') + 1]).toBe(REPO)
    expect(args[args.indexOf('--head') + 1]).toBe(BRANCH)
    expect(args[args.indexOf('--title') + 1]).toBe(TITLE)
    expect(args).toContain('--body-file')
    expect(args[args.indexOf('--body-file') + 1]).toBe('-')
    // The body NEVER travels by argv (§14 argv discipline).
    expect(creates[0]?.stdin).toBe(BODY)
    expect(args).not.toContain(BODY)
    expect(store.confirmations.get(confirmationId)?.status).toBe('approved')
    const flow = store.engines.get(FLOW_ID) as StoreDoc
    expect(flow.state).toBe('pr_open')
    expect(flow.prNumber).toBe(12)
  })

  it('deny → resolved denied, gh never called, delivery stays ready_for_pr', async () => {
    const { run, calls } = fakeGh(() => ok(''))
    const { store, deps } = makeDeps(run)
    const { confirmationId } = await createPrBehindCard(deps, {
      repo: REPO,
      branch: BRANCH,
      title: TITLE,
      body: BODY,
    })
    calls.length = 0
    const resolved = await resolvePrCreate(deps, { confirmationId, answer: 'deny' })
    expect(resolved).toEqual({ status: 'denied' })
    expect(calls).toHaveLength(0)
    expect(store.confirmations.get(confirmationId)?.status).toBe('denied')
    expect(store.engines.get(FLOW_ID)?.state).toBe('ready_for_pr')
  })

  it('a gh failure after approve is reported; the approval is never replayed', async () => {
    const { run } = fakeGh(() => fail('gh: no default remote'))
    const { store, deps } = makeDeps(run)
    const { confirmationId } = await createPrBehindCard(deps, {
      repo: REPO,
      branch: BRANCH,
      title: TITLE,
      body: BODY,
    })
    const resolved = await resolvePrCreate(deps, { confirmationId, answer: 'approve' })
    expect(resolved.status).toBe('approved')
    expect(resolved.error).toContain('gh: no default remote')
    expect(store.confirmations.get(confirmationId)?.status).toBe('approved')
    expect(store.engines.get(FLOW_ID)?.state).toBe('ready_for_pr')
  })

  it('double-resolve: the first answer wins (already_handled)', async () => {
    const { run } = fakeGh(() => ok(''))
    const { store, deps } = makeDeps(run)
    const { confirmationId } = await createPrBehindCard(deps, {
      repo: REPO,
      branch: BRANCH,
      title: TITLE,
      body: BODY,
    })
    await resolvePrCreate(deps, { confirmationId, answer: 'deny' })
    await expect(resolvePrCreate(deps, { confirmationId, answer: 'approve' })).rejects.toThrow(
      /^already_handled/,
    )
    expect(store.confirmations.get(confirmationId)?.status).toBe('denied')
  })
})

describe('mergeBehindCard (§14: merge confirms, GitHub attests)', () => {
  /** One routed fake for the whole §14 leg: create → checks → merge → view. */
  const mergeGh = (
    checks: string,
    view: string,
    mergeResult: GhResult = ok(''),
  ): { run: GhRun; calls: Call[] } =>
    fakeGh((args) => {
      const facts = prFacts(args)
      if (facts !== undefined) return facts
      const text = args.join(' ')
      if (text.includes('create')) return ok('https://github.com/owner/repo/pull/12\n')
      if (text.includes('checks')) return ok(checks)
      if (text.includes('merge')) return mergeResult
      if (text.includes('view')) return ok(view)
      return ok('')
    })
  const PR = 12

  it('ci pending → no merge call, and the answer is not spent', async () => {
    const { run, calls } = mergeGh('[{"name":"unit","state":"pending"}]', '{"state":"OPEN"}')
    const { store, deps } = makeDeps(run)
    const { confirmationId } = await openMergeCard(deps, { repo: REPO, prNumber: PR })
    const out = await mergeBehindCard(deps, { confirmationId, repo: REPO, prNumber: PR, answer: 'approve' })
    expect(out).toEqual({ merged: false, reason: 'ci_pending' })
    expect(calls.filter((call) => call.args.includes('merge'))).toHaveLength(0)
    expect(store.confirmations.get(confirmationId)?.status).toBe('pending')
  })

  it('ci failed → reason ci_failed, card untouched', async () => {
    const { run } = mergeGh('[{"name":"unit","state":"failure"}]', '{"state":"OPEN"}')
    const { store, deps } = makeDeps(run)
    const { confirmationId } = await openMergeCard(deps, { repo: REPO, prNumber: PR })
    const out = await mergeBehindCard(deps, { confirmationId, repo: REPO, prNumber: PR, answer: 'approve' })
    expect(out).toEqual({ merged: false, reason: 'ci_failed' })
    expect(store.confirmations.get(confirmationId)?.status).toBe('pending')
  })

  it('no checks reported is pending, not green', async () => {
    const { run } = mergeGh('[]', '{"state":"OPEN"}')
    const { deps } = makeDeps(run)
    const { confirmationId } = await openMergeCard(deps, { repo: REPO, prNumber: PR })
    await expect(
      mergeBehindCard(deps, { confirmationId, repo: REPO, prNumber: PR, answer: 'approve' }),
    ).resolves.toEqual({ merged: false, reason: 'ci_pending' })
  })

  it('green + approve → merge, GitHub says MERGED, prflow reaches merged', async () => {
    const { run, calls } = mergeGh(
      '[{"name":"unit","state":"success"},{"name":"typecheck","state":"success"}]',
      '{"state":"MERGED"}',
    )
    const { store, deps } = makeDeps(run)
    // The full §14 lifecycle: card → PR → checks green → merge confirmed by GitHub.
    await createPrBehindCard(deps, { repo: REPO, branch: BRANCH, title: TITLE, body: BODY })
    const opened = await resolvePrCreateAwaitPr(deps)
    const mergeCard = await openMergeCard(deps, { repo: REPO, prNumber: opened.prNumber })
    const out = await mergeBehindCard(deps, {
      confirmationId: mergeCard.confirmationId,
      repo: REPO,
      prNumber: opened.prNumber,
      answer: 'approve',
    })
    expect(out).toEqual({ merged: true })
    expect(store.confirmations.get(mergeCard.confirmationId)?.status).toBe('approved')
    expect(store.engines.get(FLOW_ID)?.state).toBe('merged')
    const merges = calls.filter((call) => call.args.includes('merge'))
    expect(merges).toHaveLength(1)
    // Squash, because the repository requires linear history (decision #17); the head the
    // owner saw is the only head GitHub may merge (§13 input binding).
    expect(merges[0]?.args).toEqual([
      'pr',
      'merge',
      '-R',
      REPO,
      '--squash',
      '--match-head-commit',
      HEAD,
      '12',
    ])
    // And the state read that settled it came after the merge call.
    const mergeAt = calls.findIndex((call) => call.args.includes('merge'))
    const statesAfter = calls.slice(mergeAt + 1).filter((call) => call.args.includes('view'))
    expect(statesAfter).toHaveLength(1)
  })

  it('GitHub still says OPEN → merged false with the exact reason, flow stays ci_green', async () => {
    const { run } = mergeGh('[{"name":"unit","state":"success"}]', '{"state":"OPEN"}')
    const { store, deps } = makeDeps(run)
    await createPrBehindCard(deps, { repo: REPO, branch: BRANCH, title: TITLE, body: BODY })
    const opened = await resolvePrCreateAwaitPr(deps)
    const mergeCard = await openMergeCard(deps, { repo: REPO, prNumber: opened.prNumber })
    const out = await mergeBehindCard(deps, {
      confirmationId: mergeCard.confirmationId,
      repo: REPO,
      prNumber: opened.prNumber,
      answer: 'approve',
    })
    expect(out).toEqual({ merged: false, reason: 'merge unconfirmed by GitHub' })
    expect(store.engines.get(FLOW_ID)?.state).toBe('ci_green')
  })

  it('green + deny → no merge call, denied', async () => {
    const { run, calls } = mergeGh('[{"name":"unit","state":"success"}]', '{"state":"OPEN"}')
    const { store, deps } = makeDeps(run)
    const { confirmationId } = await openMergeCard(deps, { repo: REPO, prNumber: PR })
    const out = await mergeBehindCard(deps, { confirmationId, repo: REPO, prNumber: PR, answer: 'deny' })
    expect(out).toEqual({ merged: false, reason: 'denied' })
    expect(calls.filter((call) => call.args.includes('merge'))).toHaveLength(0)
    expect(store.confirmations.get(confirmationId)?.status).toBe('denied')
  })

  /** Opens the PR through its card on the same fake (the url carries PR #12). */
  async function resolvePrCreateAwaitPr(deps: ReleaseDeps): Promise<{ prNumber: number }> {
    const pending = deps.store.confirmations
      .list({ status: 'pending' })
      .find((doc) => doc.cls === 'pr_create') as StoreDoc | undefined
    expect(pending).toBeDefined()
    const resolved = await resolvePrCreate(deps, {
      confirmationId: String(pending?.id),
      answer: 'approve',
    })
    expect(resolved.prNumber).toBe(12)
    return { prNumber: resolved.prNumber ?? 12 }
  }
})

describe('pushIntegrationBranch', () => {
  it('pushes the integration branch to the gh-reported remote, argv-only', async () => {
    const { run } = fakeGh(() => ok('https://github.com/owner/repo\n'))
    const gitCalls: Array<readonly string[]> = []
    const out = await pushIntegrationBranch(
      run,
      REPO,
      '/tmp/mec/repos/owner/repo.git',
      { branch: BRANCH, headSha: HEAD },
      async (args) => {
        gitCalls.push(args)
        return ok('')
      },
    )
    expect(out).toEqual({ pushed: true })
    expect(gitCalls).toEqual([
      [
        '-C',
        '/tmp/mec/repos/owner/repo.git',
        'push',
        'https://github.com/owner/repo',
        `${HEAD}:refs/heads/${BRANCH}`,
      ],
    ])
  })

  it('reports a gh failure without running git', async () => {
    const { run } = fakeGh(() => fail('HTTP 404'))
    const gitCalls: Array<readonly string[]> = []
    const target = { branch: BRANCH, headSha: HEAD }
    const out = await pushIntegrationBranch(run, REPO, '/tmp/git', target, async (args) => {
      gitCalls.push(args)
      return ok('')
    })
    if (out.pushed) throw new Error('expected a gh failure')
    expect(out.error).toContain('gh repo view failed')
    expect(gitCalls).toHaveLength(0)
  })

  it('reports a git failure with stderr', async () => {
    const { run } = fakeGh(() => ok('https://github.com/owner/repo\n'))
    const target = { branch: BRANCH, headSha: HEAD }
    const out = await pushIntegrationBranch(run, REPO, '/tmp/git', target, async () =>
      fail(' ! [rejected] non-fast-forward'),
    )
    expect(out).toEqual({ pushed: false, error: '! [rejected] non-fast-forward' })
  })
})

describe('release routes (cards over HTTP, class-checked)', () => {
  it('POST /api/release/pr opens a card (no gh call); approve resolves and creates the PR; replay 409', async () => {
    const { run, calls } = fakeGh((args) =>
      args.includes('create') ? ok('https://github.com/owner/repo/pull/12\n') : ok(''),
    )
    const { store, app } = makeServer(run)

    const opened = await app.inject({
      method: 'POST',
      url: '/api/release/pr',
      payload: { repo: REPO, branch: BRANCH, title: TITLE, body: BODY },
    })
    expect(opened.statusCode).toBe(200)
    const card = opened.json() as { confirmationId: string }
    expect(card.confirmationId).toMatch(/^conf_/)
    expect(writes(calls)).toHaveLength(0)
    expect(store.confirmations.get(card.confirmationId)?.status).toBe('pending')

    const resolved = await app.inject({
      method: 'POST',
      url: `/api/release/pr/${card.confirmationId}/resolve`,
      payload: { answer: 'approve' },
    })
    expect(resolved.statusCode).toBe(200)
    expect(resolved.json()).toEqual({
      status: 'approved',
      prNumber: 12,
      prUrl: 'https://github.com/owner/repo/pull/12',
    })
    expect(calls.filter((call) => call.args.includes('create'))).toHaveLength(1)

    const replay = await app.inject({
      method: 'POST',
      url: `/api/release/pr/${card.confirmationId}/resolve`,
      payload: { answer: 'deny' },
    })
    expect(replay.statusCode).toBe(409)
    expect(replay.json()).toMatchObject({ error: 'already_handled' })
  })

  it('a pr_merge card cannot be resolved at the pr endpoint (class mismatch is a 400)', async () => {
    const { run } = fakeGh((args) => prFacts(args) ?? ok('[]'))
    const { app } = makeServer(run)
    const opened = await app.inject({
      method: 'POST',
      url: '/api/release/merge',
      payload: { repo: REPO, prNumber: 12 },
    })
    expect(opened.statusCode).toBe(200)
    const { confirmationId } = opened.json() as { confirmationId: string }
    const wrongDoor = await app.inject({
      method: 'POST',
      url: `/api/release/pr/${confirmationId}/resolve`,
      payload: { answer: 'approve' },
    })
    expect(wrongDoor.statusCode).toBe(400)
    expect(wrongDoor.json()).toMatchObject({ error: expect.stringContaining('pr_merge') })
  })

  it('merge route: ci pending leaves the card pending and answers the reason', async () => {
    const { run } = fakeGh(
      (args) =>
        prFacts(args) ?? (args.includes('checks') ? ok('[{"name":"unit","state":"pending"}]') : ok('')),
    )
    const { store, app } = makeServer(run)
    const opened = await app.inject({
      method: 'POST',
      url: '/api/release/merge',
      payload: { repo: REPO, prNumber: 12 },
    })
    const { confirmationId } = opened.json() as { confirmationId: string }
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/release/merge/${confirmationId}/resolve`,
      payload: { answer: 'approve' },
    })
    expect(resolved.statusCode).toBe(200)
    expect(resolved.json()).toEqual({ merged: false, reason: 'ci_pending' })
    expect(store.confirmations.get(confirmationId)?.status).toBe('pending')
  })

  it('validates the request and the unknown confirmation', async () => {
    const { run } = fakeGh(() => ok(''))
    const { app } = makeServer(run)
    const badPr = await app.inject({
      method: 'POST',
      url: '/api/release/pr',
      payload: { repo: REPO, branch: '', title: TITLE },
    })
    expect(badPr.statusCode).toBe(400)
    const badAnswer = await app.inject({
      method: 'POST',
      url: '/api/release/pr/conf_x/resolve',
      payload: { answer: 'maybe' },
    })
    expect(badAnswer.statusCode).toBe(400)
    const missing = await app.inject({
      method: 'POST',
      url: '/api/release/pr/conf_missing/resolve',
      payload: { answer: 'approve' },
    })
    expect(missing.statusCode).toBe(404)
    const badNumber = await app.inject({
      method: 'POST',
      url: '/api/release/merge',
      payload: { repo: REPO, prNumber: 'twelve' },
    })
    expect(badNumber.statusCode).toBe(400)
  })
})
