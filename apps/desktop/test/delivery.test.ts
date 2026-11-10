// M2.3 end of the line: accepted tasks in the bare cache, one integration worktree, the push and
// PR cards, a recording fake gh, and real git against a local bare repository standing in for
// GitHub, reached through `insteadOf` because a local path is refused as an origin.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { StoreDoc } from '@mec/contracts'
import { DEFAULT_CAPS } from '@mec/domain'
import {
  FollowUps,
  holdWorkItem,
  integrationDocId,
  repoFields,
  saveProcessing,
  schedulePass,
  stopWorkItem,
  workResultOf,
} from '@mec/meta'
import { MemoryRepositories } from '@mec/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commitWork } from '../src/attempt-launch'
import { Delivery, deliveryDocId, movedWords, retryOffer } from '../src/delivery'
import {
  cardEvidence,
  createPrBehindCard,
  type GhResult,
  type GhRun,
  mergeBehindCard,
  openMergeCard,
  openPushCard,
  type ReleaseDeps,
  resolvePush,
  resolveReleaseCard,
} from '../src/release'

const REPO = 'repo_a'
const SLUG = 'owner/repo'
const URL_ON_GITHUB = `https://github.com/${SLUG}`
const WORK = 'wi_abcdef12'
const BRANCH = 'mec/abcdef12/integration'
const POLICY = '{"preAuthorised":{}}'
const AT = '2026-11-05T12:00:00.000Z'
const PR = 7

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()

const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string): GhResult => ({ code: 1, stdout: '', stderr })

type World = {
  prs: { number: number; headRefName: string; files: string[] }[]
  pr: { state: string; headRefOid: string; mergeStateStatus?: string } | undefined
  checks: GhResult
  target: string
  create: GhResult
}

function fakeGh(rig: { bare: () => string }, world: World) {
  const calls: (readonly string[])[] = []
  const run: GhRun = async (args) => {
    calls.push(args)
    const text = args.join(' ')
    if (args[0] === 'repo' && args[1] === 'view') {
      return ok(JSON.stringify({ url: URL_ON_GITHUB, defaultBranchRef: { name: 'main' } }))
    }
    if (text.includes('/git/ref/heads/main')) return ok(`${world.target}\n`)
    if (text.includes('/git/ref/heads/')) {
      const ref = args[1]?.split('/git/ref/heads/')[1] as string
      return ok(`${gitIn(rig.bare(), 'rev-parse', `refs/heads/${ref}`)}\n`)
    }
    if (args[0] === 'pr' && args[1] === 'list') return ok(JSON.stringify(world.prs))
    if (args[0] === 'pr' && args[1] === 'view' && text.includes('files')) {
      const pr = world.prs.find((row) => row.number === Number(args[2]))
      return ok(JSON.stringify({ files: (pr?.files ?? []).map((filename) => ({ filename })) }))
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      return world.pr === undefined
        ? fail('not found')
        : ok(
            JSON.stringify({
              mergeStateStatus: 'CLEAN',
              ...world.pr,
              title: 'T',
              headRefName: BRANCH,
            }),
          )
    }
    if (args[0] === 'pr' && args[1] === 'create') return world.create
    if (args[0] === 'pr' && args[1] === 'checks') return world.checks
    if (args[0] === 'api' && text.includes('/branches')) return ok('')
    return ok('')
  }
  return { run, calls }
}

const creates = (calls: (readonly string[])[]) => calls.filter((a) => a[0] === 'pr' && a[1] === 'create')
const merges = (calls: (readonly string[])[]) => calls.filter((a) => a[0] === 'pr' && a[1] === 'merge')

function rig(
  over: { checks?: { name: string; cmd: string }[]; world?: Partial<World>; bootstrap?: string[] } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'mec-delivery-'))
  roots.push(root)
  const dataDir = join(root, 'state')
  mkdirSync(dataDir)
  const bare = join(root, 'github.git')
  gitIn(root, 'init', '--quiet', '--bare', '-b', 'main', bare)
  const clone = join(root, 'clone')
  mkdirSync(clone)
  gitIn(clone, 'init', '--quiet', '-b', 'main')
  gitIn(clone, 'config', 'user.name', 'Repo Owner')
  gitIn(clone, 'config', 'user.email', 'owner@example.com')
  writeFileSync(join(clone, 'a.txt'), 'one\n')
  gitIn(clone, 'add', '--all')
  gitIn(clone, 'commit', '--quiet', '-m', 'baseline')
  gitIn(clone, 'remote', 'add', 'origin', bare)
  gitIn(clone, 'push', '--quiet', 'origin', 'main')
  gitIn(clone, 'remote', 'set-url', 'origin', `git@github.com:${SLUG}.git`)
  const cache = join(root, 'cache.git')
  gitIn(root, 'clone', '--quiet', '--bare', `file://${clone}`, cache)
  gitIn(cache, 'config', `url.${bare}.insteadOf`, URL_ON_GITHUB)
  const base = gitIn(cache, 'rev-parse', 'main')

  const store = new MemoryRepositories()
  store.atomic(() => {
    store.engines.save({
      id: REPO,
      url: clone,
      bootstrap: over.bootstrap ?? [],
      checks: over.checks ?? [{ name: 'unit', cmd: 'test -f a.txt' }],
      trust: false,
      hostRunAgreedAt: AT,
    })
    store.messages.save({ id: 'msg_1', text: 'Add the audit log', role: 'user' })
    store.workItems.save({
      id: WORK,
      state: 'integrating',
      mandate: { originMessageId: 'msg_1', status: 'active' },
      base_sha: base,
      default_branch: 'main',
      git_dir: cache,
      ...repoFields(store, REPO, POLICY),
    })
  })

  const world: World = {
    prs: [],
    pr: undefined,
    checks: ok('[{"name":"ci","state":"SUCCESS"}]'),
    target: base,
    create: ok(`${URL_ON_GITHUB}/pull/${PR}\n`),
    ...over.world,
  }
  const { run, calls } = fakeGh({ bare: () => bare }, world)
  const delivery = new Delivery({
    store,
    effects: store.effects,
    dataDir,
    policyText: POLICY,
    caps: DEFAULT_CAPS,
    run,
    pollMs: 0,
  })

  /** An accepted task, on its own branch in the cache, with what it changed committed. */
  const accepted = (id: string, file: string, text: string, from = base): void => {
    const path = join(root, `wt-${id}`)
    const branch = `mec/abcdef12/${id}/a1`
    gitIn(cache, 'worktree', 'add', '--quiet', '-b', branch, path, from)
    mkdirSync(dirname(join(path, file)), { recursive: true })
    writeFileSync(join(path, file), text)
    gitIn(path, 'add', '--all')
    gitIn(path, 'commit', '--quiet', '-m', id)
    store.atomic(() => {
      store.tasks.save({
        id,
        localKey: id,
        workItemId: WORK,
        repoId: REPO,
        role: 'implementer',
        status: 'accepted',
        dependsOn: [],
        basePolicy: 'integration',
        acceptanceChecks: ['unit'],
        acceptedHead: gitIn(path, 'rev-parse', 'HEAD'),
        acceptedBranch: branch,
      })
    })
  }

  const passes = async (n = 4): Promise<void> => {
    for (let index = 0; index < n; index += 1) await delivery.pass()
  }
  const doc = (): StoreDoc => store.engines.get(deliveryDocId(WORK)) as StoreDoc
  const integration = (): StoreDoc => store.engines.get(integrationDocId(WORK)) as StoreDoc
  const types = (stream: string) => store.events.read(stream).map((event) => event.type)
  const cards = (cls: string) => store.confirmations.list().filter((card) => card.cls === cls)
  const remote = (ref: string): string | undefined => {
    try {
      return gitIn(bare, 'rev-parse', '--verify', '-q', ref)
    } catch {
      return undefined
    }
  }
  return {
    root,
    dataDir,
    store,
    delivery,
    world,
    calls,
    cache,
    base,
    accepted,
    passes,
    doc,
    integration,
    types,
    cards,
    remote,
  }
}

type Rig = ReturnType<typeof rig>

async function localComplete(over?: Parameters<typeof rig>[0]): Promise<Rig> {
  const r = rig(over)
  r.accepted('task_a', 'b.txt', 'two\n')
  await r.passes()
  return r
}

async function approvedPush(over?: Parameters<typeof rig>[0]): Promise<Rig> {
  const r = await localComplete(over)
  const [card] = r.cards('push')
  await resolveReleaseCard(r.delivery.release, String(card?.id), 'approve')
  await r.delivery.idle()
  await r.passes(1)
  return r
}

async function openPr(over?: Parameters<typeof rig>[0]): Promise<Rig> {
  const r = await approvedPush(over)
  const [card] = r.cards('pr_create')
  await resolveReleaseCard(r.delivery.release, String(card?.id), 'approve')
  await r.delivery.idle()
  r.world.pr = { state: 'OPEN', headRefOid: String(r.integration().head) }
  return r
}

describe('the commit that ends an attempt (§14)', () => {
  function midMerge(): string {
    const r = rig()
    r.accepted('task_a', 'a.txt', 'left\n')
    r.accepted('task_b', 'a.txt', 'right\n')
    const worktree = join(r.root, 'wt-task_a')
    expect(() => gitIn(worktree, 'merge', '--no-edit', 'mec/abcdef12/task_b/a1')).toThrow()
    return worktree
  }
  const IDENTITY = { name: 'T', email: 't@example.com' }

  it('fails with no merge in progress and commits by commitAll, leaving .mec out', async () => {
    const r = rig()
    r.accepted('task_a', 'b.txt', 'two\n')
    const worktree = join(r.root, 'wt-task_a')
    writeFileSync(join(worktree, 'c.txt'), 'three\n')
    mkdirSync(join(worktree, '.mec'))
    writeFileSync(join(worktree, '.mec', 'mcp.json'), '{}')
    const sha = await commitWork(worktree, 'm', IDENTITY)
    expect(sha).toBe(gitIn(worktree, 'rev-parse', 'HEAD'))
    expect(gitIn(worktree, 'show', '--name-only', '--format=', 'HEAD')).toBe('c.txt')
  })

  it("a repair's commit in the integration worktree carries no bootstrap output", async () => {
    const r = rig({ bootstrap: ['cp a.txt package-lock.json'] })
    r.accepted('task_a', 'b.txt', 'two\n')
    await r.delivery.pass()
    const worktree = String(r.integration().worktree)
    expect(readFileSync(join(worktree, 'package-lock.json'), 'utf8')).toBe('one\n')
    writeFileSync(join(worktree, 'fix.txt'), 'fixed\n')
    await commitWork(worktree, 'm', IDENTITY)
    expect(gitIn(worktree, 'show', '--name-only', '--format=', 'HEAD')).toBe('fix.txt')
  })

  it("a repair's merge commit carries no bootstrap output", async () => {
    const r = rig({ bootstrap: ['cp a.txt package-lock.json'] })
    r.accepted('task_a', 'a.txt', 'left\n')
    r.accepted('task_b', 'a.txt', 'right\n')
    await r.delivery.pass()
    await r.delivery.pass()
    const worktree = String(r.integration().worktree)
    writeFileSync(join(worktree, 'a.txt'), 'both\n')
    await commitWork(worktree, 'm', IDENTITY)
    expect(gitIn(worktree, 'rev-parse', 'HEAD^@').split('\n')).toHaveLength(2)
    expect(gitIn(worktree, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('package-lock.json')
  })

  it('finishes a merge with two parents once the conflict is resolved', async () => {
    const worktree = midMerge()
    writeFileSync(join(worktree, 'a.txt'), 'both\n')
    const sha = await commitWork(worktree, 'm', IDENTITY)
    expect(sha).toBe(gitIn(worktree, 'rev-parse', 'HEAD'))
    expect(gitIn(worktree, 'rev-parse', 'HEAD^@').split('\n')).toHaveLength(2)
  })

  it('refuses to finish a merge whose markers are still there, and both sides stay', async () => {
    const worktree = midMerge()
    await expect(commitWork(worktree, 'm', IDENTITY)).rejects.toThrow('a.txt')
    expect(readFileSync(join(worktree, 'a.txt'), 'utf8')).toContain('right')
  })
})

describe('integration (§14)', () => {
  it('one integration branch per work item, from the pinned base, one task per pass', async () => {
    const r = rig()
    r.accepted('task_a', 'b.txt', 'two\n')
    r.accepted('task_b', 'c.txt', 'three\n')
    await r.delivery.pass()
    expect(r.store.tasks.get('task_a')?.status).toBe('integrated')
    expect(r.store.tasks.get('task_b')?.status).toBe('accepted')
    await r.delivery.pass()
    expect(r.store.tasks.get('task_b')?.status).toBe('integrated')
    expect(r.integration()).toMatchObject({ branch: BRANCH })
    const head = String(r.integration().head)
    expect(gitIn(r.cache, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(head)
    expect(r.integration().combined).toMatchObject({ sha: head, passed: true })
  })

  it('combined checks that fail open a repair task in the integration worktree', async () => {
    const r = rig({ checks: [{ name: 'unit', cmd: 'test ! -f b.txt' }] })
    r.accepted('task_a', 'b.txt', 'two\n')
    await r.passes(2)
    const repair = r.store.tasks.list().find((task) => task.repairOf === 'task_a')
    expect(repair).toMatchObject({ role: 'repair_agent', status: 'ready' })
    const next = repair?.next as Record<string, string>
    expect(next).toMatchObject({ kind: 'repair', branch: BRANCH, worktree: r.integration().worktree })
    expect(next.evidence).toContain(String(r.integration().head))
    expect(r.store.tasks.get('task_a')?.status).toBe('accepted')
    expect(workResultOf(r.store, WORK).complete).toBe(false)
  })

  it('a combined check gets no SSH agent socket', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
    const r = rig({ checks: [{ name: 'agent', cmd: 'printenv SSH_AUTH_SOCK' }] })
    r.accepted('task_a', 'b.txt', 'two\n')
    await r.passes(2)
    vi.unstubAllEnvs()
    expect(r.integration().combined).toMatchObject({ passed: false })
  })

  it('nothing merges or runs until the owner agrees, and then it does', async () => {
    const r = rig()
    r.accepted('task_a', 'b.txt', 'two\n')
    const agreed = r.store.engines.get(REPO) as StoreDoc
    const { hostRunAgreedAt: _agreed, ...unagreed } = agreed
    r.store.atomic(() => r.store.engines.save(unagreed as StoreDoc))
    await r.passes(2)
    expect(r.store.engines.get(integrationDocId(WORK))).toBeUndefined()
    r.store.atomic(() => r.store.engines.save(agreed))
    await r.passes(2)
    expect(r.integration().combined).toMatchObject({ passed: true })
  })

  it('a withdrawal between two checks runs neither the next one nor a verdict', async () => {
    const r = rig({
      checks: [
        { name: 'first', cmd: 'sleep 1' },
        { name: 'second', cmd: 'test -f a.txt' },
      ],
    })
    r.accepted('task_a', 'b.txt', 'two\n')
    const agreed = r.store.engines.get(REPO) as StoreDoc
    const { hostRunAgreedAt: _agreed, ...unagreed } = agreed
    const pass = r.passes(1)
    await new Promise((done) => setTimeout(done, 400))
    r.store.atomic(() => r.store.engines.save(unagreed as StoreDoc))
    await pass
    expect(r.store.engines.get(integrationDocId(WORK))?.combined).toBeUndefined()
    expect(r.store.workItems.get(WORK)?.state).not.toBe('blocked')
  })

  it('a failed setup command blocks the work and says so in one chat line', async () => {
    const r = rig({ bootstrap: ['sh -c "echo the environment is down; exit 3"'] })
    r.accepted('task_a', 'b.txt', 'two\n')
    await r.passes(3)
    expect(r.store.workItems.get(WORK)).toMatchObject({ state: 'blocked' })
    const notes = r.store.snapshot().effects.filter((row) => row.kind === 'note')
    expect(notes).toHaveLength(1)
    expect(notes[0]?.payload).toMatchObject({
      workItemId: WORK,
      text: expect.stringMatching(/^The integration could not start: .*the environment is down/),
    })
  })

  it('a withdrawal between two setup commands runs no further one', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'mec-marker-')), 'second')
    roots.push(dirname(marker))
    const r = rig({ bootstrap: ['sleep 1', `touch ${marker}`] })
    r.accepted('task_a', 'b.txt', 'two\n')
    const { hostRunAgreedAt: _agreed, ...unagreed } = r.store.engines.get(REPO) as StoreDoc
    const pass = r.passes(1)
    await new Promise((done) => setTimeout(done, 400))
    r.store.atomic(() => r.store.engines.save(unagreed as StoreDoc))
    await pass
    expect(existsSync(marker)).toBe(false)
    expect(r.store.engines.get(integrationDocId(WORK))).toBeUndefined()
  })

  it('a conflict leaves both sides for a repair task, and nothing else merges meanwhile', async () => {
    const r = rig()
    r.accepted('task_a', 'a.txt', 'left\n')
    r.accepted('task_b', 'a.txt', 'right\n')
    r.accepted('task_c', 'c.txt', 'three\n')
    await r.passes(4)
    const repair = r.store.tasks.list().find((task) => task.repairOf === 'task_b')
    expect((repair?.next as { evidence?: string } | undefined)?.evidence).toContain('a.txt')
    const text = readFileSync(join(String(r.integration().worktree), 'a.txt'), 'utf8')
    expect(text).toContain('left')
    expect(text).toContain('right')
    expect(r.store.tasks.get('task_c')?.status).toBe('accepted')
  })

  it('a repair that ends cancelled blocks its task: the work never just stops', async () => {
    const r = rig({ checks: [{ name: 'unit', cmd: 'test ! -f b.txt' }] })
    r.accepted('task_a', 'b.txt', 'two\n')
    await r.passes(2)
    r.store.atomic(() => {
      const repair = r.store.tasks.list().find((task) => task.repairOf === 'task_a') as StoreDoc
      const { next: _next, ...rest } = repair
      r.store.tasks.save({ ...rest, status: 'cancelled', cancelledReason: 'dropped by a replan' })
    })
    await r.passes(1)
    expect(r.store.tasks.get('task_a')?.status).toBe('blocked')
    expect(String(r.store.tasks.get('task_a')?.blockedReason)).toContain('dropped by a replan')
  })

  it('a repair past the cap blocks the task with what remains', async () => {
    const r = rig({ checks: [{ name: 'unit', cmd: 'test ! -f b.txt' }] })
    r.accepted('task_a', 'b.txt', 'two\n')
    r.store.atomic(() => {
      for (const id of ['att_1', 'att_2']) {
        r.store.attempts.save({
          id,
          taskId: 'task_a',
          workItemId: WORK,
          state: 'succeeded',
          continuation: { kind: 'repair' },
        })
      }
    })
    await r.passes(2)
    expect(r.store.tasks.list().filter((task) => task.repairOf === 'task_a')).toEqual([])
    expect(r.store.tasks.get('task_a')?.status).toBe('blocked')
    expect(String(r.store.tasks.get('task_a')?.blockedReason)).toContain('2 of 2')
  })

  it('work whose repository profile changed since admission runs no other commands', async () => {
    const r = rig()
    r.accepted('task_a', 'b.txt', 'two\n')
    r.store.atomic(() => {
      const repo = r.store.engines.get(REPO) as StoreDoc
      r.store.engines.save({ ...repo, checks: [{ name: 'unit', cmd: 'true' }] })
    })
    await r.passes(2)
    expect(r.store.engines.get(integrationDocId(WORK))).toBeUndefined()
    expect(r.store.workItems.get(WORK)).toMatchObject({
      state: 'blocked',
      blockedReason: expect.stringContaining('repo_profile_changed'),
    })
  })

  it('an accepted subset opens nothing', async () => {
    const r = rig()
    r.accepted('task_a', 'b.txt', 'two\n')
    r.store.atomic(() => {
      r.store.tasks.save({
        id: 'task_b',
        workItemId: WORK,
        repoId: REPO,
        role: 'implementer',
        status: 'active',
        dependsOn: [],
      })
    })
    await r.passes()
    expect(r.cards('push')).toEqual([])
    expect(r.store.engines.get(deliveryDocId(WORK))).toBeUndefined()
  })
})

describe('the result path (§14, #11, #12)', () => {
  it('local complete opens a push card and pushes nothing', async () => {
    const r = await localComplete()
    expect(r.cards('push')).toHaveLength(1)
    expect(r.cards('push')[0]).toMatchObject({ status: 'pending', inputSha: r.integration().head })
    expect(r.remote(`refs/heads/${BRANCH}`)).toBeUndefined()
    expect(r.doc()).toMatchObject({ stage: 'push_card', head: r.integration().head })
    expect(r.types(`work:${WORK}`)).toContain('local_result')
  })

  it('both delivery cards name their work, so its stage and Needs you can find them', async () => {
    const r = await approvedPush()
    expect(r.cards('push')[0]?.workItemId).toBe(WORK)
    expect(r.cards('pr_create')[0]?.workItemId).toBe(WORK)
  })

  it('integration branch in the cache is readable by the push card', async () => {
    const r = await localComplete()
    const card = r.cards('push')[0] as StoreDoc
    expect(card.inputSha).toBe(gitIn(r.cache, 'rev-parse', `refs/heads/${BRANCH}`))
    expect(card.payload).toMatchObject({ repo: SLUG, remoteUrl: URL_ON_GITHUB, branch: BRANCH })
  })

  it('approved push opens a PR card', async () => {
    const r = await localComplete()
    expect(r.cards('pr_create')).toEqual([])
    await resolveReleaseCard(r.delivery.release, String(r.cards('push')[0]?.id), 'approve')
    await r.delivery.idle()
    expect(r.remote(`refs/heads/${BRANCH}`)).toBe(r.integration().head)
    expect(r.cards('pr_create')).toHaveLength(1)
    const card = r.cards('pr_create')[0] as StoreDoc
    expect(card.status).toBe('pending')
    const body = String((card.payload as StoreDoc).body)
    expect(body).toContain('Add the audit log')
    expect(body).toContain(String(r.integration().head))
    expect(body).toContain('| unit | passed |')
    expect(creates(r.calls)).toEqual([])
  })

  it('the continuation does not depend on who answered', async () => {
    const r = await localComplete()
    await resolvePush(r.delivery.release, {
      confirmationId: String(r.cards('push')[0]?.id),
      answer: 'approve',
    })
    await r.delivery.idle()
    expect(r.cards('pr_create')).toHaveLength(1)
  })

  it('PR ready needs an open PR on the same head', async () => {
    const r = await openPr()
    expect(creates(r.calls)).toHaveLength(1)
    r.world.pr = { state: 'OPEN', headRefOid: 'f'.repeat(40) }
    await r.passes(1)
    expect(r.doc().stage).toBe('pr_open')
    r.world.pr = { state: 'CLOSED', headRefOid: String(r.integration().head) }
    await r.passes(1)
    expect(r.doc().stage).toBe('closed')
  })

  it('stage facts move only on green', async () => {
    const r = await openPr({ world: { checks: ok('[{"name":"ci","state":"PENDING"}]') } })
    await r.passes(1)
    expect(r.doc().stage).toBe('pr_open')
    r.world.checks = ok('[{"name":"ci","state":"SUCCESS"}]')
    await r.passes(1)
    expect(r.doc().stage).toBe('ready')
    expect(r.store.workItems.get(WORK)?.state).toBe('integrating')
    expect(merges(r.calls)).toEqual([])
  })

  it('going ready reaches the stream the page follows, once, after the stage moved', async () => {
    const r = await openPr({ world: { checks: ok('[{"name":"ci","state":"PENDING"}]') } })
    await r.passes(1)
    const stream = `work:${WORK}`
    const told = () => r.store.events.read(stream).filter((event) => event.type === 'pr_ready')
    expect(told()).toEqual([])

    const { events } = r.store
    const append = events.append.bind(events)
    const stageWhenTold: unknown[] = []
    events.append = (name, event) => {
      if (name === stream && event.type === 'pr_ready') stageWhenTold.push(r.doc().stage)
      append(name, event)
    }
    r.world.checks = ok('[{"name":"ci","state":"SUCCESS"}]')
    await r.passes(1)
    expect(stageWhenTold).toEqual(['ready'])
    expect(told()[0]?.body).toMatchObject({ workItemId: WORK, prNumber: PR, verdict: 'green' })

    await r.passes(1)
    expect(told()).toHaveLength(1)
  })

  it('a repository with no required checks is ready with that limit stated (#34)', async () => {
    const r = await openPr({
      world: { checks: { code: 1, stdout: '', stderr: 'no required checks reported' } },
    })
    await r.passes(1)
    expect(r.doc()).toMatchObject({ stage: 'ready', limit: 'no_required_checks' })
  })

  it('stores what the last read saw of CI, and forgets it when the head moves', async () => {
    const r = await openPr({ world: { checks: ok('[{"name":"ci","state":"PENDING"}]') } })
    await r.passes(1)
    expect(r.doc()).toMatchObject({ stage: 'pr_open', ci: 'ci_pending' })
    r.world.checks = ok('[{"name":"ci","state":"FAILURE"}]')
    await r.passes(1)
    expect(r.doc()).toMatchObject({ stage: 'pr_open', ci: 'ci_failed' })
    r.world.checks = ok('[{"name":"ci","state":"SUCCESS"}]')
    await r.passes(1)
    expect(r.doc()).toMatchObject({ stage: 'ready', ci: 'green' })
    expect(typeof r.doc().ciAt).toBe('string')
    r.world.pr = { state: 'OPEN', headRefOid: 'f'.repeat(40) }
    await r.passes(1)
    expect(r.doc().stage).toBe('pr_open')
    expect(r.doc().ci).toBeUndefined()
  })

  it('declined push keeps the result and opens nothing', async () => {
    const r = await localComplete()
    await resolveReleaseCard(r.delivery.release, String(r.cards('push')[0]?.id), 'deny')
    await r.delivery.idle()
    await r.passes()
    expect(r.doc()).toMatchObject({ stage: 'declined', prTarget: 'pending', head: r.integration().head })
    expect(r.cards('push')).toHaveLength(1)
    expect(r.cards('pr_create')).toEqual([])
    expect(r.remote(`refs/heads/${BRANCH}`)).toBeUndefined()
    expect(workResultOf(r.store, WORK).complete).toBe(true)
  })

  it('a failed push is visible with its stderr, the approval is spent, and no PR card opens', async () => {
    const r = await localComplete()
    gitIn(r.cache, 'config', '--unset-all', `url.${join(r.root, 'github.git')}.insteadOf`)
    gitIn(r.cache, 'config', `url.${join(r.root, 'nowhere.git')}.insteadOf`, URL_ON_GITHUB)
    await resolveReleaseCard(r.delivery.release, String(r.cards('push')[0]?.id), 'approve')
    await r.delivery.idle()
    await r.passes()
    expect(r.doc().stage).toBe('failed')
    expect(String(r.doc().error)).not.toBe('')
    expect(r.cards('push')).toHaveLength(1)
    expect(r.cards('pr_create')).toEqual([])
  })

  it('human duplicate PR gives dropped', async () => {
    const r = rig({ world: { prs: [{ number: 3, headRefName: 'human/fix', files: ['b.txt'] }] } })
    r.accepted('task_a', 'b.txt', 'two\n')
    await r.passes()
    expect(r.doc()).toMatchObject({ stage: 'dropped', yieldTo: 'human/fix' })
    expect(r.cards('push')).toEqual([])
  })

  it('merge card is not opened', async () => {
    const r = await openPr()
    await r.passes(3)
    expect(r.doc().stage).toBe('ready')
    expect(r.cards('pr_merge')).toEqual([])
    expect(merges(r.calls)).toEqual([])
  })

  it('merged comes only from GitHub, and only then is the work done (#29)', async () => {
    const r = await openPr()
    await r.passes(1)
    expect(r.store.workItems.get(WORK)?.state).toBe('integrating')
    r.world.pr = { state: 'MERGED', headRefOid: String(r.integration().head) }
    await r.passes(1)
    expect(r.doc().stage).toBe('merged')
    expect(r.store.workItems.get(WORK)?.state).toBe('done')
  })

  it('target movement takes a ready PR back until checks are read again', async () => {
    const r = await openPr()
    await r.passes(1)
    expect(r.doc().stage).toBe('ready')
    r.world.target = 'e'.repeat(40)
    r.world.checks = ok('[{"name":"ci","state":"PENDING"}]')
    await r.passes(1)
    expect(r.doc().stage).toBe('pr_open')
    expect(r.types(`release:${SLUG}:${BRANCH}`)).toContain('target_moved')
    await r.passes(1)
    expect(r.doc().stage).toBe('pr_open')
    r.world.checks = ok('[{"name":"ci","state":"SUCCESS"}]')
    await r.passes(1)
    expect(r.doc().stage).toBe('ready')
  })

  it('a commit on the integration branch stales the open card and a ready PR falls back', async () => {
    const r = await localComplete()
    const worktree = String(r.integration().worktree)
    const first = String(r.integration().head)
    writeFileSync(join(worktree, 'human.txt'), 'by hand\n')
    gitIn(worktree, 'add', '--all')
    gitIn(worktree, 'commit', '--quiet', '-m', 'by hand')
    const moved = gitIn(worktree, 'rev-parse', 'HEAD')
    await r.passes(2)
    const [old, fresh] = r.cards('push')
    expect(old).toMatchObject({ status: 'stale', inputSha: first })
    expect(fresh).toMatchObject({ status: 'pending', inputSha: moved })
    expect(r.remote(`refs/heads/${BRANCH}`)).toBeUndefined()
  })

  it('an approve racing the commit finds the card stale and runs nothing', async () => {
    const r = await localComplete()
    const worktree = String(r.integration().worktree)
    writeFileSync(join(worktree, 'human.txt'), 'by hand\n')
    gitIn(worktree, 'add', '--all')
    gitIn(worktree, 'commit', '--quiet', '-m', 'by hand')
    const out = await resolveReleaseCard(r.delivery.release, String(r.cards('push')[0]?.id), 'approve')
    expect(out).toMatchObject({ status: 'stale', reason: 'stale_head' })
    expect(r.remote(`refs/heads/${BRANCH}`)).toBeUndefined()
  })

  it('held work integrates nothing and opens nothing', async () => {
    const r = rig()
    r.accepted('task_a', 'b.txt', 'two\n')
    r.store.atomic(() => {
      const work = r.store.workItems.get(WORK) as StoreDoc
      r.store.workItems.save({ ...work, hold: { reason: 'wait', sourceMessageId: 'msg_1', at: AT } })
    })
    await r.passes()
    expect(r.store.engines.get(integrationDocId(WORK))).toBeUndefined()
    expect(existsSync(join(r.dataDir, 'work'))).toBe(false)
  })
})

const stop = (r: Rig): void => {
  r.store.atomic(() => stopWorkItem(r.store, WORK, { reason: 'wrong change', at: AT }))
}
const hold = (r: Rig): void => {
  r.store.atomic(() => holdWorkItem(r.store, WORK, { reason: 'wait', at: AT }))
}
const lift = (r: Rig): void => {
  r.store.atomic(() => {
    const work = r.store.workItems.get(WORK) as StoreDoc
    r.store.workItems.save({ ...work, hold: { ...(work.hold as object), liftedAt: AT } })
  })
}
const settled = (r: Rig, id: string): StoreDoc => r.store.confirmations.get(id) as StoreDoc

/** A merge of PR `number`, which GitHub then reports merged; any PR the fake is asked about agrees. */
async function mergeOn(r: Rig, number: number): Promise<{ merged: boolean; reason?: string }> {
  const headRefOid = String(r.integration().head)
  const deps: ReleaseDeps = {
    ...r.delivery.release,
    run: async (args, opts) => {
      if (args[1] === 'merge') r.world.pr = { state: 'MERGED', headRefOid }
      return r.delivery.release.run(args, opts)
    },
  }
  const { confirmationId } = await openMergeCard(deps, { repo: SLUG, prNumber: number })
  return mergeBehindCard(deps, { confirmationId, repo: SLUG, prNumber: number, answer: 'approve' })
}

describe('a stop or hold reaches an open card (§10, §12, §13)', () => {
  it('a stop leaves a push card nothing to push, settled by policy', async () => {
    const r = await localComplete()
    const id = String(r.cards('push')[0]?.id)
    stop(r)
    const out = await resolveReleaseCard(r.delivery.release, id, 'approve')
    expect(out).toMatchObject({ status: 'stale', reason: 'mandate_withdrawn' })
    expect(settled(r, id)).toMatchObject({ status: 'stale', resolvedBy: 'policy' })
    expect(r.remote(`refs/heads/${BRANCH}`)).toBeUndefined()
    expect(r.types(`release:${SLUG}:${BRANCH}`)).toContain('card_withdrawn')
    expect(r.types(`release:${SLUG}:${BRANCH}`)).not.toContain('pushed')
  })

  it('a stop leaves a PR card nothing to open', async () => {
    const r = await approvedPush()
    const id = String(r.cards('pr_create')[0]?.id)
    stop(r)
    const out = await resolveReleaseCard(r.delivery.release, id, 'approve')
    expect(out).toMatchObject({ status: 'stale', reason: 'mandate_withdrawn' })
    expect(settled(r, id)).toMatchObject({ status: 'stale', resolvedBy: 'policy' })
    expect(creates(r.calls)).toEqual([])
  })

  it('a stop that lands while the approve reads the remote still runs nothing', async () => {
    const r = await approvedPush()
    const id = String(r.cards('pr_create')[0]?.id)
    const deps: ReleaseDeps = {
      ...r.delivery.release,
      run: async (args, opts) => {
        if (args[0] === 'api') stop(r)
        return r.delivery.release.run(args, opts)
      },
    }
    const out = await resolveReleaseCard(deps, id, 'approve')
    expect(out).toMatchObject({ status: 'stale', reason: 'mandate_withdrawn' })
    expect(creates(r.calls)).toEqual([])
  })

  it('a hold keeps a push card pending with the reason, and the lift lets it run', async () => {
    const r = await localComplete()
    const id = String(r.cards('push')[0]?.id)
    hold(r)
    const out = await resolveReleaseCard(r.delivery.release, id, 'approve')
    expect(out).toMatchObject({ status: 'pending', reason: 'held' })
    expect(settled(r, id).status).toBe('pending')
    expect(r.remote(`refs/heads/${BRANCH}`)).toBeUndefined()
    lift(r)
    await resolveReleaseCard(r.delivery.release, id, 'approve')
    expect(r.remote(`refs/heads/${BRANCH}`)).toBe(r.integration().head)
  })

  it('a hold keeps a PR card pending with the reason', async () => {
    const r = await approvedPush()
    const id = String(r.cards('pr_create')[0]?.id)
    hold(r)
    const out = await resolveReleaseCard(r.delivery.release, id, 'approve')
    expect(out).toMatchObject({ status: 'pending', reason: 'held' })
    expect(settled(r, id).status).toBe('pending')
    expect(creates(r.calls)).toEqual([])
  })

  it('a stop or a hold reaches a merge card for the delivery PR', async () => {
    const r = await openPr()
    hold(r)
    expect(await mergeOn(r, PR)).toEqual({ merged: false, reason: 'held' })
    lift(r)
    stop(r)
    expect(await mergeOn(r, PR)).toEqual({ merged: false, reason: 'mandate_withdrawn' })
    expect(merges(r.calls)).toEqual([])
  })

  it('a deny still settles as the answer on stopped and held work', async () => {
    const r = await localComplete()
    const id = String(r.cards('push')[0]?.id)
    hold(r)
    await resolveReleaseCard(r.delivery.release, id, 'deny')
    expect(settled(r, id)).toMatchObject({ status: 'denied', resolvedBy: 'user' })
  })
})

describe('a card speaks only for its own delivery (§14)', () => {
  it('a merge of another PR with the same head name ends nothing', async () => {
    const r = await openPr()
    expect(await mergeOn(r, 11)).toEqual({ merged: true })
    expect(r.doc()).toMatchObject({ stage: 'pr_open', prNumber: PR })
    expect(r.store.workItems.get(WORK)?.state).toBe('integrating')
  })

  it('a merge of the delivery PR ends the work', async () => {
    const r = await openPr()
    expect(await mergeOn(r, PR)).toEqual({ merged: true })
    expect(r.doc().stage).toBe('merged')
    expect(r.store.workItems.get(WORK)?.state).toBe('done')
  })

  it('a manually opened push card cannot decline the delivery', async () => {
    const r = await localComplete()
    const own = r.doc().pushCardId
    const other = await openPushCard(r.delivery.release, { repoId: REPO, branch: BRANCH })
    await resolveReleaseCard(r.delivery.release, other.confirmationId, 'deny')
    await r.delivery.idle()
    expect(r.doc()).toMatchObject({ stage: 'push_card', pushCardId: own })
  })

  it('a manually opened PR card cannot decline the delivery', async () => {
    const r = await approvedPush()
    const own = r.doc().prCardId
    const other = await createPrBehindCard(r.delivery.release, {
      repo: SLUG,
      branch: BRANCH,
      title: 'By hand',
      body: 'By hand',
    })
    await resolveReleaseCard(r.delivery.release, other.confirmationId, 'deny')
    await r.delivery.idle()
    expect(r.doc()).toMatchObject({ stage: 'pr_card', prCardId: own })
  })
})

describe('a person retries what blocked (§11: blocked work and failed deliveries, never a loop)', () => {
  const KEY = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const LOCK = 'package-lock.json'
  /** The merge refuses for a reason nothing here can clear: the worktree's index is locked. */
  const lockIndex = (r: Rig): string => {
    const lock = join(r.cache, 'worktrees', `integration-${WORK}`, 'index.lock')
    writeFileSync(lock, '')
    return lock
  }
  async function refusedMerge(over?: Parameters<typeof rig>[0]): Promise<{ r: Rig; lock: string }> {
    const r = rig(over)
    r.accepted('task_a', 'b.txt', 'two\n')
    r.accepted('task_b', 'c.txt', 'three\n')
    await r.delivery.pass()
    const lock = lockIndex(r)
    await r.delivery.pass()
    return { r, lock }
  }
  const work = (r: Rig): StoreDoc => r.store.workItems.get(WORK) as StoreDoc
  const events = (r: Rig) => r.store.events.read(`work:${WORK}`)
  const count = (r: Rig, type: string) => r.types(`work:${WORK}`).filter((seen) => seen === type).length

  it("a blocked integration carries git's own words, redacted before the write", async () => {
    // `.mec/` is the one place making room for a merge does not look, so git really refuses here.
    const r = rig()
    r.accepted('task_a', 'b.txt', 'two\n')
    r.accepted('task_b', `.mec/${KEY}.txt`, 'three\n')
    await r.delivery.pass()
    const worktree = String(r.integration().worktree)
    mkdirSync(join(worktree, '.mec'))
    writeFileSync(join(worktree, '.mec', `${KEY}.txt`), 'in the way\n')
    await r.delivery.pass()
    expect(work(r).state).toBe('blocked')
    expect(String(work(r).blockedReason)).toContain('would be overwritten by merge')
    expect(JSON.stringify([work(r), events(r)])).not.toContain(KEY)
  })

  it('a retry waits for the agreement: nothing is offered, and nothing moves', async () => {
    const { r, lock } = await refusedMerge()
    rmSync(lock)
    const { hostRunAgreedAt: _agreed, ...unagreed } = r.store.engines.get(REPO) as StoreDoc
    r.store.atomic(() => r.store.engines.save(unagreed as StoreDoc))
    expect(retryOffer(r.store, work(r))).toBeUndefined()
    expect(r.delivery.retry(WORK)).toEqual({ status: 'refused', error: 'host_run_unagreed' })
    expect(work(r).state).toBe('blocked')
    expect(count(r, 'retry_requested')).toBe(0)
  })

  it('a retry runs the integration once more and clears the reason', async () => {
    const { r, lock } = await refusedMerge()
    rmSync(lock)
    expect(r.delivery.retry(WORK)).toEqual({ status: 'retrying', kind: 'integration' })
    expect(work(r).state).toBe('integrating')
    expect(work(r).blockedReason).toBeUndefined()
    expect(count(r, 'retry_requested')).toBe(1)
    await r.delivery.idle()
    await r.passes()
    expect(r.store.tasks.get('task_b')?.status).toBe('integrated')
    expect(r.cards('push')).toHaveLength(1)
  })

  it('a second press of the same retry does nothing', async () => {
    const { r, lock } = await refusedMerge()
    rmSync(lock)
    r.delivery.retry(WORK)
    expect(r.delivery.retry(WORK)).toEqual({ status: 'refused', error: 'nothing_to_retry' })
    expect(count(r, 'retry_requested')).toBe(1)
  })

  it('a retry that fails again blocks again with its reason, and nothing retries by itself', async () => {
    const { r } = await refusedMerge()
    r.delivery.retry(WORK)
    await r.delivery.idle()
    await r.passes()
    expect(work(r).state).toBe('blocked')
    expect(String(work(r).blockedReason)).toContain('Unable to write index')
    expect(count(r, 'work_blocked')).toBe(2)
  })

  it('held work is not retried, and a hold landing after the retry still holds the pass', async () => {
    const { r, lock } = await refusedMerge()
    rmSync(lock)
    r.store.atomic(() => holdWorkItem(r.store, WORK, { reason: 'wait', at: AT }))
    expect(r.delivery.retry(WORK)).toEqual({ status: 'refused', error: 'held' })
    expect(work(r).state).toBe('blocked')

    const clean = await refusedMerge()
    rmSync(clean.lock)
    expect(clean.r.delivery.retry(WORK).status).toBe('retrying')
    clean.r.store.atomic(() => holdWorkItem(clean.r.store, WORK, { reason: 'wait', at: AT }))
    await clean.r.delivery.idle()
    await clean.r.passes()
    expect(clean.r.store.tasks.get('task_b')?.status).toBe('accepted')
    expect(clean.r.cards('push')).toEqual([])
  })

  it('stopped work and an expired mandate are refused', async () => {
    const { r } = await refusedMerge()
    r.store.atomic(() => stopWorkItem(r.store, WORK, { reason: 'no', at: AT }))
    expect(r.delivery.retry(WORK)).toEqual({ status: 'refused', error: 'mandate_withdrawn' })

    const late = await refusedMerge()
    late.r.store.atomic(() => {
      const doc = work(late.r)
      const mandate = { ...(doc.mandate as object), expiresAt: '2020-01-01T00:00:00.000Z' }
      late.r.store.workItems.save({ ...doc, mandate })
    })
    expect(late.r.delivery.retry(WORK)).toEqual({ status: 'refused', error: 'mandate_expired' })
    expect(work(late.r).state).toBe('blocked')
  })

  it('a retry is not offered once the repository commands changed: the press would be refused (§14, #41)', async () => {
    const { r, lock } = await refusedMerge()
    rmSync(lock)
    expect(retryOffer(r.store, work(r))).toMatchObject({ kind: 'integration' })
    r.store.atomic(() => {
      const repo = r.store.engines.get(REPO) as StoreDoc
      r.store.engines.save({ ...repo, checks: [{ name: 'unit', cmd: 'true' }] })
    })
    expect(retryOffer(r.store, work(r))).toBeUndefined()
    expect(r.delivery.retry(WORK)).toEqual({ status: 'refused', error: 'repo_profile_changed' })
    expect(work(r).state).toBe('blocked')
    expect(count(r, 'retry_requested')).toBe(0)
  })

  it('a block a retry cannot answer is not offered', async () => {
    const r = rig()
    r.accepted('task_a', 'b.txt', 'two\n')
    r.store.atomic(() => {
      r.store.workItems.save({ ...work(r), state: 'blocked', blockedReason: 'repo_profile_changed: other' })
    })
    expect(r.delivery.retry(WORK)).toEqual({ status: 'refused', error: 'nothing_to_retry' })
    expect(r.delivery.retry('wi_missing')).toEqual({ status: 'missing' })
  })

  it('a task integration refused goes back to accepted, and only then merges', async () => {
    const r = rig()
    r.accepted('task_a', 'b.txt', 'two\n')
    r.store.atomic(() => {
      const task = r.store.tasks.get('task_a') as StoreDoc
      r.store.tasks.save({ ...task, status: 'blocked', blockedReason: 'could not run unit on abc' })
      r.store.workItems.save({ ...work(r), state: 'blocked', blockedReason: 'could not run unit on abc' })
    })
    expect(r.delivery.retry(WORK).status).toBe('retrying')
    expect(r.store.tasks.get('task_a')).toMatchObject({ status: 'accepted' })
    expect(r.store.tasks.get('task_a')?.blockedReason).toBeUndefined()
    await r.delivery.idle()
    await r.passes(1)
    expect(r.store.tasks.get('task_a')?.status).toBe('integrated')
  })

  /** A task whose repairs ran out, as the scheduler leaves it: blocked, with an attempt behind it. */
  const usedUp = (r: Rig): void => {
    const reason = 'repairs used up (2 of 2). What remains:\nCheck unit failed on abc:\nred'
    r.store.atomic(() => {
      r.store.tasks.save({
        id: 'task_c',
        localKey: 'task_c',
        workItemId: WORK,
        repoId: REPO,
        role: 'implementer',
        status: 'blocked',
        blockedReason: reason,
        dependsOn: [],
        basePolicy: 'integration',
        acceptanceChecks: ['unit'],
      })
      r.store.attempts.save({
        id: 'att_9',
        taskId: 'task_c',
        workItemId: WORK,
        state: 'checks_failed',
        worktree: '/work/att_9',
        branch: 'mec/abcdef12/task_c/a1',
        createdAt: AT,
      })
      r.store.workItems.save({ ...work(r), state: 'blocked', blockedReason: reason })
    })
  }

  it('used-up repairs offer Try again: one fresh repair, asked once (owner ruling 2026-11-07)', () => {
    const r = rig()
    usedUp(r)
    expect(retryOffer(r.store, work(r))).toMatchObject({ kind: 'repair' })
    expect(r.delivery.retry(WORK)).toEqual({ status: 'retrying', kind: 'repair' })
    expect(r.store.tasks.get('task_c')).toMatchObject({
      status: 'ready',
      next: { kind: 'repair', origin: 'owner' },
    })
    expect(work(r).state).not.toBe('blocked')
    expect(r.delivery.retry(WORK)).toEqual({ status: 'refused', error: 'nothing_to_retry' })
    expect(count(r, 'retry_requested')).toBe(1)
  })

  it('Try again is not offered once the repository commands changed: its launch would be refused', () => {
    const r = rig()
    usedUp(r)
    r.store.atomic(() => {
      const repo = r.store.engines.get(REPO) as StoreDoc
      r.store.engines.save({ ...repo, bootstrap: [{ name: 'setup', cmd: 'true' }] })
    })
    expect(retryOffer(r.store, work(r))).toBeUndefined()
    expect(r.delivery.retry(WORK)).toEqual({ status: 'refused', error: 'repo_profile_changed' })
    expect(r.store.tasks.get('task_c')?.status).toBe('blocked')
  })

  it('Try again honours a hold and waits for the agreement', () => {
    const held = rig()
    usedUp(held)
    held.store.atomic(() => holdWorkItem(held.store, WORK, { reason: 'wait', at: AT }))
    expect(retryOffer(held.store, work(held))).toBeUndefined()
    expect(held.delivery.retry(WORK)).toEqual({ status: 'refused', error: 'held' })

    const unagreed = rig()
    usedUp(unagreed)
    const { hostRunAgreedAt: _agreed, ...repo } = unagreed.store.engines.get(REPO) as StoreDoc
    unagreed.store.atomic(() => unagreed.store.engines.save(repo as StoreDoc))
    expect(unagreed.delivery.retry(WORK)).toEqual({ status: 'refused', error: 'host_run_unagreed' })
    expect(unagreed.store.tasks.get('task_c')?.status).toBe('blocked')
  })

  it("a repair that ended is the plan's to answer, not a retry's", async () => {
    const r = rig()
    r.accepted('task_a', 'b.txt', 'two\n')
    await r.delivery.pass()
    r.store.atomic(() => {
      const task = r.store.tasks.get('task_a') as StoreDoc
      r.store.tasks.save({ ...task, status: 'blocked', blockedReason: 'its repair ended: cancelled' })
      r.store.workItems.save({ ...work(r), state: 'blocked', blockedReason: 'integration: a repair ended' })
      r.store.engines.save({
        ...r.integration(),
        failed: { taskId: 'task_a', reason: 'checks_failed', repairing: true },
      })
    })
    expect(r.delivery.retry(WORK)).toEqual({ status: 'refused', error: 'nothing_to_retry' })
  })

  it('work blocked by the old build, on its old worktree and task commit, integrates after upgrade', async () => {
    // What 0.3.0 left: a task commit with the bootstrap's file in it, the same file untracked in
    // an integration worktree with no record of its bootstrap, and a reason with no git in it.
    const r = rig({ bootstrap: [`cp a.txt ${LOCK}`] })
    r.accepted('task_a', LOCK, '{"swept":true}\n')
    const worktree = join(r.dataDir, 'work', `integration-${WORK}`)
    gitIn(r.cache, 'worktree', 'add', '--quiet', '-b', BRANCH, worktree, r.base)
    writeFileSync(join(worktree, LOCK), 'one\n')
    r.store.atomic(() => {
      r.store.engines.save({
        id: integrationDocId(WORK),
        workItemId: WORK,
        repoId: REPO,
        branch: BRANCH,
        worktree,
        gitDir: r.cache,
        head: r.base,
        integrated: {},
        updatedAt: AT,
      })
      r.store.workItems.save({
        ...work(r),
        state: 'blocked',
        blockedReason: 'integration: merge failed without leaving a merge in progress',
      })
    })
    expect(r.delivery.retry(WORK)).toEqual({ status: 'retrying', kind: 'integration' })
    await r.delivery.idle()
    await r.passes()
    expect(work(r).state).toBe('integrating')
    expect(r.store.tasks.get('task_a')?.status).toBe('integrated')
    expect(gitIn(worktree, 'show', `HEAD:${LOCK}`)).toBe('{"swept":true}')
    expect(r.cards('push')).toHaveLength(1)
  })

  it('a declined push asks again with one new card, and pushes nothing', async () => {
    const r = await localComplete()
    await resolveReleaseCard(r.delivery.release, String(r.cards('push')[0]?.id), 'deny')
    await r.delivery.idle()
    await r.passes()
    expect(r.delivery.retry(WORK)).toEqual({ status: 'retrying', kind: 'push' })
    expect(r.delivery.retry(WORK)).toEqual({ status: 'refused', error: 'nothing_to_retry' })
    await r.delivery.idle()
    await r.passes()
    expect(r.cards('push').map((card) => card.status)).toEqual(['denied', 'pending'])
    expect(r.doc()).toMatchObject({ stage: 'push_card', pushCardId: r.cards('push')[1]?.id })
    expect(r.doc().prTarget).toBeUndefined()
    expect(r.doc().answer).toBeUndefined()
    expect(r.remote(`refs/heads/${BRANCH}`)).toBeUndefined()
    expect(count(r, 'local_result')).toBe(1)
  })

  // Live, 9 November 2026 (wi_mw9kvv161fy597y, installed 0.3.7): the owner denied the push, a
  // follow-up's task was accepted while two older tasks were blocked, and the work blocked with an
  // old reason. The planner cancelled both; the work stayed blocked, nothing integrated the accepted
  // task, and no button could clear it. What 0.3.7 left on disk clears on the next pass, untouched.
  it('blocked work whose blocked tasks were cancelled integrates its accepted task and asks to push the new head', async () => {
    const r = await localComplete()
    await resolveReleaseCard(r.delivery.release, String(r.cards('push')[0]?.id), 'deny')
    await r.delivery.idle()
    await r.passes()
    const built = String(r.integration().head)
    const OLD = 'attempt att_13 reported blocked: the rename broke the page'
    r.accepted('task_popup', 'c.txt', 'three\n', built)
    r.store.atomic(() => {
      for (const [id, reason] of [
        ['task_fix_top', OLD],
        ['task_zindex', 'attempt att_14 reported blocked: still red'],
      ] as const) {
        r.store.tasks.save({ id, localKey: id, workItemId: WORK, repoId: REPO, role: 'implementer' })
        r.store.tasks.save({
          ...(r.store.tasks.get(id) as StoreDoc),
          status: 'blocked',
          blockedReason: reason,
        })
      }
      r.store.workItems.save({ ...work(r), state: 'blocked', blockedReason: OLD })
      const stream = `work:${WORK}`
      const seq = (r.store.events.read(stream).at(-1)?.seq ?? 0) + 1
      const body = { taskId: 'task_fix_top', reason: OLD, at: AT }
      r.store.events.append(stream, { stream, seq, at: AT, type: 'task_blocked', body })
    })
    const followups = new FollowUps({ store: r.store, effects: r.store.effects, now: () => AT })
    const settle = () =>
      r.store.atomic(() =>
        schedulePass(
          {
            store: r.store,
            effects: r.store.effects,
            caps: DEFAULT_CAPS,
            slots: () => [],
            table: () => undefined,
            followups,
          },
          { at: AT },
        ),
      )
    settle()
    await r.passes()
    expect(r.store.tasks.get('task_popup')?.status).toBe('accepted')

    r.store.atomic(() => {
      for (const id of ['task_fix_top', 'task_zindex']) {
        const doc = r.store.tasks.get(id) as StoreDoc
        r.store.tasks.save({ ...doc, status: 'cancelled', cancelledReason: 'cancelled by the planner' })
      }
    })
    settle()
    expect(work(r)).toMatchObject({ state: 'integrating' })
    expect(work(r).blockedReason).toBeUndefined()
    await r.passes()
    expect(r.store.tasks.get('task_popup')?.status).toBe('integrated')
    const head = String(r.integration().head)
    expect(head).not.toBe(built)
    expect(r.integration().combined).toMatchObject({ sha: head, passed: true })
    expect(r.cards('push').map((card) => [card.status, card.inputSha])).toEqual([
      ['denied', built],
      ['pending', head],
    ])
    expect(r.doc()).toMatchObject({ stage: 'push_card', head })
    expect(r.remote(`refs/heads/${BRANCH}`)).toBeUndefined()
  })

  it('a declined PR card asks again with one new card, and the push is not asked again', async () => {
    const r = await approvedPush()
    await resolveReleaseCard(r.delivery.release, String(r.cards('pr_create')[0]?.id), 'deny')
    await r.delivery.idle()
    await r.passes()
    expect(r.doc().stage).toBe('declined')
    expect(r.delivery.retry(WORK)).toEqual({ status: 'retrying', kind: 'pr' })
    await r.delivery.idle()
    await r.passes()
    expect(r.cards('pr_create').map((card) => card.status)).toEqual(['denied', 'pending'])
    expect(r.cards('push')).toHaveLength(1)
    expect(creates(r.calls)).toEqual([])
  })

  it('a failed push is a new card, never a replay of the spent approval', async () => {
    const r = await localComplete()
    const remote = join(r.root, 'github.git')
    gitIn(r.cache, 'config', '--unset-all', `url.${remote}.insteadOf`)
    gitIn(r.cache, 'config', `url.${join(r.root, 'nowhere.git')}.insteadOf`, URL_ON_GITHUB)
    await resolveReleaseCard(r.delivery.release, String(r.cards('push')[0]?.id), 'approve')
    await r.delivery.idle()
    await r.passes()
    expect(r.doc().stage).toBe('failed')
    expect(r.delivery.retry(WORK)).toEqual({ status: 'retrying', kind: 'push' })
    // The press itself starts the pass: nothing here waits for the timer.
    await r.delivery.idle()
    expect(r.doc().error).toBeUndefined()
    expect(r.cards('push').map((card) => card.status)).toEqual(['approved', 'pending'])
  })

  it('a retry while processing is paused waits for the resume', async () => {
    const r = await localComplete()
    await resolveReleaseCard(r.delivery.release, String(r.cards('push')[0]?.id), 'deny')
    await r.delivery.idle()
    r.store.atomic(() => saveProcessing(r.store, { paused: true }, AT))
    expect(r.delivery.retry(WORK).status).toBe('retrying')
    await r.delivery.idle()
    await r.passes()
    expect(r.cards('push')).toHaveLength(1)
    r.store.atomic(() => saveProcessing(r.store, { paused: false }, AT))
    await r.passes()
    expect(r.cards('push')).toHaveLength(2)
  })

  it('a held delivery keeps its declined stage and opens nothing', async () => {
    const r = await localComplete()
    await resolveReleaseCard(r.delivery.release, String(r.cards('push')[0]?.id), 'deny')
    await r.delivery.idle()
    r.store.atomic(() => holdWorkItem(r.store, WORK, { reason: 'wait', at: AT }))
    expect(r.delivery.retry(WORK)).toEqual({ status: 'refused', error: 'held' })
    await r.passes()
    expect(r.doc().stage).toBe('declined')
    expect(r.cards('push')).toHaveLength(1)
  })
})

describe('a pull request head that moved on GitHub (owner, 9 November 2026: "Say + offer update")', () => {
  const BARE = (r: Rig): string => join(r.root, 'github.git')
  let clones = 0
  /** A clone of the GitHub stand-in, to do there what GitHub or a person does. */
  const onGitHub = (r: Rig): string => {
    clones += 1
    const path = join(r.root, `gh-${clones}`)
    gitIn(r.root, 'clone', '--quiet', BARE(r), path)
    return path
  }
  /** Another change lands on main; the fake gh reports it as the target. */
  const mainMoves = (r: Rig, file = 'm.txt', text = 'main\n'): string => {
    const path = onGitHub(r)
    writeFileSync(join(path, file), text)
    gitIn(path, 'add', '--all')
    gitIn(path, 'commit', '--quiet', '-m', `main: ${file}`)
    gitIn(path, 'push', '--quiet', 'origin', 'main')
    const sha = gitIn(path, 'rev-parse', 'HEAD')
    r.world.target = sha
    return sha
  }
  /** GitHub's Update branch: main merged into the PR branch, optionally with something extra in it. */
  const updateBranch = (r: Rig, extra?: { file: string; text: string }): string => {
    const path = onGitHub(r)
    gitIn(path, 'checkout', '--quiet', BRANCH)
    gitIn(path, 'merge', '--quiet', '--no-ff', '--no-commit', 'origin/main')
    if (extra !== undefined) {
      writeFileSync(join(path, extra.file), extra.text)
      gitIn(path, 'add', '--all')
    }
    gitIn(path, 'commit', '--quiet', '-m', "Merge branch 'main' into the PR")
    gitIn(path, 'push', '--quiet', 'origin', BRANCH)
    const sha = gitIn(path, 'rev-parse', 'HEAD')
    if (r.world.pr !== undefined) r.world.pr = { ...r.world.pr, headRefOid: sha, mergeStateStatus: 'CLEAN' }
    return sha
  }
  /** Somebody pushes their own commit to the PR branch. */
  const foreignCommit = (r: Rig): string => {
    const path = onGitHub(r)
    gitIn(path, 'checkout', '--quiet', BRANCH)
    writeFileSync(join(path, 'theirs.txt'), 'not checked by MEC\n')
    gitIn(path, 'add', '--all')
    gitIn(path, 'commit', '--quiet', '-m', 'theirs')
    gitIn(path, 'push', '--quiet', 'origin', BRANCH)
    const sha = gitIn(path, 'rev-parse', 'HEAD')
    if (r.world.pr !== undefined) r.world.pr = { ...r.world.pr, headRefOid: sha }
    return sha
  }
  const work = (r: Rig): StoreDoc => r.store.workItems.get(WORK) as StoreDoc
  const workEvents = (r: Rig, type: string) =>
    r.store.events.read(`work:${WORK}`).filter((event) => event.type === type)
  const short = (sha: string): string => sha.slice(0, 7)
  const repairs = (r: Rig) =>
    r.store.tasks.list({ workItemId: WORK }).filter((task) => task.repairOf !== undefined)

  async function readyPr(over?: Parameters<typeof rig>[0]): Promise<Rig> {
    const r = await openPr(over)
    await r.passes(1)
    expect(r.doc().stage).toBe('ready')
    return r
  }

  async function behind(over?: Parameters<typeof rig>[0], file?: string, text?: string) {
    const r = await readyPr(over)
    const before = String(r.doc().head)
    const target = mainMoves(r, file, text)
    r.world.pr = { state: 'OPEN', headRefOid: before, mergeStateStatus: 'BEHIND' }
    await r.passes(1)
    return { r, before, target }
  }

  describe("(c) GitHub's Update branch is adopted when it is only a merge of the target", () => {
    it('records the new head with why, pushes nothing, and the merge card pins the adopted head', async () => {
      const r = await readyPr()
      const pushed = String(r.doc().head)
      mainMoves(r)
      const adopted = updateBranch(r)
      await r.passes(3)
      expect(r.doc()).toMatchObject({ stage: 'ready', head: pushed, prHead: adopted })
      expect(r.doc().headMoved).toBeUndefined()
      expect(workEvents(r, 'head_adopted').map((event) => event.body)).toEqual([
        expect.objectContaining({ from: pushed, to: adopted }),
      ])
      expect(r.cards('push')).toHaveLength(1)
      expect(r.remote(`refs/heads/${BRANCH}`)).toBe(adopted)
      const { confirmationId } = await openMergeCard(r.delivery.release, {
        repo: SLUG,
        prNumber: PR,
        workItemId: WORK,
      })
      expect(r.store.confirmations.get(confirmationId)?.inputSha).toBe(adopted)
      await mergeBehindCard(r.delivery.release, {
        confirmationId,
        repo: SLUG,
        prNumber: PR,
        answer: 'approve',
      })
      const [merge] = merges(r.calls)
      expect(merge?.[merge.indexOf('--match-head-commit') + 1]).toBe(adopted)
    })

    it('a commit someone added is not adopted: the work says so in words, and is not ready', async () => {
      const r = await readyPr()
      const theirs = foreignCommit(r)
      await r.passes(3)
      expect(r.doc().stage).toBe('pr_open')
      expect(r.doc().prHead).toBeUndefined()
      expect(r.doc().headMoved).toMatchObject({ sha: theirs })
      expect(workEvents(r, 'head_moved_on_github')).toHaveLength(1)
      expect(workEvents(r, 'head_adopted')).toEqual([])
      await expect(
        openMergeCard(r.delivery.release, { repo: SLUG, prNumber: PR, workItemId: WORK }),
      ).rejects.toThrow('delivery_not_ready')
    })

    it("an Update branch on top of someone's commit is not adopted", async () => {
      const r = await readyPr()
      foreignCommit(r)
      mainMoves(r)
      const merged = updateBranch(r)
      await r.passes(3)
      expect(r.doc()).toMatchObject({ stage: 'pr_open', headMoved: { sha: merged, foreign: true } })
      expect(r.doc().prHead).toBeUndefined()
      expect(retryOffer(r.store, work(r))).toBeUndefined()
    })

    it('a base merge that carries a change of its own is not adopted', async () => {
      const r = await readyPr()
      mainMoves(r)
      const merged = updateBranch(r, { file: 'b.txt', text: 'edited in the merge\n' })
      await r.passes(3)
      expect(r.doc()).toMatchObject({ stage: 'pr_open', headMoved: { sha: merged, foreign: true } })
      expect(r.doc().prHead).toBeUndefined()
      expect(retryOffer(r.store, work(r))).toBeUndefined()
    })

    it('a merge whose other parent is not on the target is not adopted', async () => {
      const r = await readyPr()
      const path = onGitHub(r)
      // A commit that changes no file: only the parent rule tells this merge from an Update branch.
      gitIn(path, 'checkout', '--quiet', '-b', 'side', 'origin/main')
      gitIn(path, 'commit', '--quiet', '--allow-empty', '-m', 'side')
      gitIn(path, 'checkout', '--quiet', BRANCH)
      gitIn(path, 'merge', '--quiet', '--no-ff', '-m', 'merge side', 'side')
      gitIn(path, 'push', '--quiet', 'origin', BRANCH)
      const merged = gitIn(path, 'rev-parse', 'HEAD')
      r.world.pr = { state: 'OPEN', headRefOid: merged }
      await r.passes(3)
      expect(r.doc()).toMatchObject({ stage: 'pr_open', headMoved: { sha: merged, foreign: true } })
    })

    it('a rebase onto main is not adopted, whatever it changes: the pushed head is not in it', async () => {
      const r = await readyPr()
      const target = mainMoves(r)
      const path = onGitHub(r)
      gitIn(path, 'checkout', '--quiet', BRANCH)
      gitIn(path, 'rebase', '--quiet', target)
      gitIn(path, 'push', '--quiet', '--force', 'origin', BRANCH)
      const rebased = gitIn(path, 'rev-parse', 'HEAD')
      r.world.pr = { state: 'OPEN', headRefOid: rebased }
      await r.passes(3)
      expect(r.doc()).toMatchObject({
        stage: 'pr_open',
        headMoved: { sha: rebased, why: 'not_on_mec_head', foreign: true },
      })
      expect(r.doc().prHead).toBeUndefined()
    })

    it('a head MEC already looked at is not judged again on every read', async () => {
      const r = await readyPr()
      foreignCommit(r)
      await r.passes(4)
      expect(workEvents(r, 'head_moved_on_github')).toHaveLength(1)
    })

    it('a branch put back on the head MEC pushed reads as it did before', async () => {
      const r = await readyPr()
      const pushed = String(r.doc().head)
      foreignCommit(r)
      await r.passes(2)
      expect(r.doc().headMoved).toBeDefined()
      r.world.pr = { state: 'OPEN', headRefOid: pushed }
      await r.passes(2)
      expect(r.doc().headMoved).toBeUndefined()
      expect(r.doc().stage).toBe('ready')
    })
  })

  describe('(b) Bring up to date is withheld when someone else pushed to the branch (owner, 10 November 2026)', () => {
    it('a commit someone added is said in words, Bring up to date is not offered, and a retry is refused', async () => {
      const r = await readyPr()
      const theirs = foreignCommit(r)
      await r.passes(3)
      expect(r.doc().headMoved).toMatchObject({ sha: theirs, foreign: true })
      expect(workEvents(r, 'head_moved_on_github').map((event) => event.body)).toEqual([
        expect.objectContaining({ sha: theirs, foreign: true }),
      ])
      expect(movedWords(r.doc())).toBe(
        `Someone else pushed to this branch on GitHub (now ${short(theirs)}). MEC won’t merge over or replace their commits.`,
      )
      expect(retryOffer(r.store, work(r))).toBeUndefined()
      expect(r.delivery.retry(WORK)).toEqual({ status: 'refused', error: 'nothing_to_retry' })
      await r.delivery.idle()
      expect(r.doc().update).toBeUndefined()
      expect(r.cards('push')).toHaveLength(1)
      expect(r.remote(`refs/heads/${BRANCH}`)).toBe(theirs)
    })

    it('behind its target as well, a branch with their commits still offers nothing', async () => {
      const r = await readyPr()
      const theirs = foreignCommit(r)
      mainMoves(r)
      r.world.pr = { state: 'OPEN', headRefOid: theirs, mergeStateStatus: 'BEHIND' }
      await r.passes(3)
      expect(r.doc()).toMatchObject({ behind: true, headMoved: { sha: theirs, foreign: true } })
      expect(retryOffer(r.store, work(r))).toBeUndefined()
    })

    it('a branch reset to the target carries nobody’s commits: Bring up to date stays', async () => {
      const r = await readyPr()
      const target = mainMoves(r)
      gitIn(onGitHub(r), 'push', '--quiet', '--force', 'origin', `${target}:refs/heads/${BRANCH}`)
      r.world.pr = { state: 'OPEN', headRefOid: target }
      await r.passes(3)
      expect(r.doc().headMoved).toMatchObject({ sha: target, why: 'not_on_mec_head' })
      expect(r.doc().headMoved).not.toHaveProperty('foreign')
      expect(retryOffer(r.store, work(r))).toEqual({
        kind: 'update',
        reason: `The branch changed on GitHub (now ${short(target)}). MEC won’t merge commits it didn’t check.`,
      })
    })

    it('a branch put back on the head MEC pushed, under an adopted update, carries nobody’s commits', async () => {
      const r = await readyPr()
      const pushed = String(r.doc().head)
      mainMoves(r)
      const adopted = updateBranch(r)
      await r.passes(3)
      expect(r.doc().prHead).toBe(adopted)
      gitIn(onGitHub(r), 'push', '--quiet', '--force', 'origin', `${pushed}:refs/heads/${BRANCH}`)
      r.world.pr = { state: 'OPEN', headRefOid: pushed }
      await r.passes(3)
      expect(r.doc().headMoved).toMatchObject({ sha: pushed, why: 'not_on_mec_head' })
      expect(r.doc().headMoved).not.toHaveProperty('foreign')
      expect(retryOffer(r.store, work(r))?.kind).toBe('update')
    })
  })

  describe('(b) Bring up to date: merge the target here, check it, and ask with a push card', () => {
    it('is offered when GitHub says the pull request is behind, and not once it is not', async () => {
      const { r } = await behind()
      await r.passes(1)
      expect(r.doc().behind).toBe(true)
      expect(retryOffer(r.store, work(r))).toEqual({
        kind: 'update',
        reason: 'The pull request is behind main.',
      })
      r.world.pr = { ...(r.world.pr as NonNullable<World['pr']>), mergeStateStatus: 'CLEAN' }
      await r.passes(1)
      expect(r.doc().behind).toBeUndefined()
      expect(retryOffer(r.store, work(r))).toBeUndefined()
    })

    it('merges main locally, runs the checks on the result, and opens a push card for exactly it', async () => {
      const { r, before, target } = await behind()
      expect(r.delivery.retry(WORK)).toEqual({ status: 'retrying', kind: 'update' })
      expect(r.delivery.retry(WORK)).toEqual({ status: 'refused', error: 'nothing_to_retry' })
      await r.delivery.idle()
      await r.passes(3)
      const merged = String(r.integration().head)
      expect(merged).not.toBe(before)
      expect(gitIn(r.cache, 'rev-parse', `${merged}^1`, `${merged}^2`).split('\n')).toEqual([before, target])
      expect(r.integration().combined).toMatchObject({ sha: merged, passed: true })
      expect(gitIn(String(r.integration().worktree), 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${BRANCH}`)
      const card = r.cards('push').at(-1) as StoreDoc
      expect(card).toMatchObject({ status: 'pending', inputSha: merged })
      expect(r.cards('push')[0]?.status).toBe('approved')
      expect(r.remote(`refs/heads/${BRANCH}`)).toBe(before)
      expect(workEvents(r, 'brought_up_to_date').map((event) => event.body)).toEqual([
        expect.objectContaining({ from: before, to: merged, target }),
      ])
      // The card's diff is what the pull request changes against main, not main's own commits.
      const evidence = (await cardEvidence(r.delivery.release, card)) as {
        diff: { files: { path: string }[] }
        checks: { name: string; state: string }[]
      }
      expect(evidence.diff.files.map((file) => file.path)).toEqual(['b.txt'])
      expect(evidence.checks).toEqual([expect.objectContaining({ name: 'unit', state: 'passed' })])

      await resolveReleaseCard(r.delivery.release, String(card.id), 'approve')
      await r.delivery.idle()
      expect(r.remote(`refs/heads/${BRANCH}`)).toBe(merged)
      expect(r.cards('pr_create')).toHaveLength(1)
      r.world.pr = { state: 'OPEN', headRefOid: merged, mergeStateStatus: 'CLEAN' }
      await r.passes(2)
      expect(r.doc()).toMatchObject({ stage: 'ready', head: merged })
      expect(r.doc().update).toBeUndefined()
    })

    it('after adopting an Update branch, bringing up to date builds on it, so the push is a fast-forward', async () => {
      const r = await readyPr()
      mainMoves(r)
      const adopted = updateBranch(r)
      await r.passes(3)
      expect(r.doc().prHead).toBe(adopted)
      const target = mainMoves(r, 'n.txt')
      r.world.pr = { state: 'OPEN', headRefOid: adopted, mergeStateStatus: 'BEHIND' }
      await r.passes(1)
      expect(r.delivery.retry(WORK)).toEqual({ status: 'retrying', kind: 'update' })
      await r.delivery.idle()
      await r.passes(3)
      const merged = String(r.integration().head)
      expect(gitIn(r.cache, 'rev-parse', `${merged}^1`, `${merged}^2`).split('\n')).toEqual([adopted, target])
      await resolveReleaseCard(r.delivery.release, String(r.cards('push').at(-1)?.id), 'approve')
      await r.delivery.idle()
      expect(r.remote(`refs/heads/${BRANCH}`)).toBe(merged)
      // The pushed head speaks for itself now: the adopted one is history, not judged again.
      r.world.pr = { state: 'OPEN', headRefOid: merged, mergeStateStatus: 'CLEAN' }
      await r.passes(2)
      expect(r.doc()).toMatchObject({ stage: 'ready', head: merged })
      expect(r.doc().prHead).toBeUndefined()
      expect(workEvents(r, 'head_adopted')).toHaveLength(1)
    })

    it('a conflict says so in words, pushes nothing, and leaves the integration branch where it was', async () => {
      const { r, before } = await behind(undefined, 'b.txt', 'main wrote this\n')
      r.delivery.retry(WORK)
      await r.delivery.idle()
      await r.passes(2)
      expect(r.doc().update).toMatchObject({ status: 'conflict', paths: ['b.txt'] })
      expect(r.integration().head).toBe(before)
      const worktree = String(r.integration().worktree)
      expect(gitIn(worktree, 'rev-parse', 'HEAD')).toBe(before)
      expect(gitIn(worktree, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${BRANCH}`)
      expect(gitIn(worktree, 'status', '--porcelain')).toBe('')
      expect(r.cards('push')).toHaveLength(1)
      expect(r.remote(`refs/heads/${BRANCH}`)).toBe(before)
      expect(repairs(r)).toEqual([])
      expect(retryOffer(r.store, work(r))).toEqual({
        kind: 'update',
        reason: 'Bringing it up to date with main conflicted in b.txt. Nothing was pushed.',
      })
    })

    it('a failing check says so in words, pushes nothing, and leaves the integration branch where it was', async () => {
      const { r, before } = await behind({ checks: [{ name: 'unit', cmd: 'test ! -f m.txt' }] })
      r.delivery.retry(WORK)
      await r.delivery.idle()
      await r.passes(2)
      expect(r.doc().update).toMatchObject({ status: 'failed', failing: ['unit'] })
      expect(r.integration().head).toBe(before)
      expect(r.integration().combined).toMatchObject({ sha: before, passed: true })
      const worktree = String(r.integration().worktree)
      expect(gitIn(worktree, 'rev-parse', 'HEAD')).toBe(before)
      expect(gitIn(worktree, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${BRANCH}`)
      expect(r.cards('push')).toHaveLength(1)
      expect(repairs(r)).toEqual([])
      expect(String(retryOffer(r.store, work(r))?.reason)).toMatch(
        /^Bringing it up to date with main failed the checks on [0-9a-f]{7}: unit\. Nothing was pushed\.$/,
      )
    })

    it('an update a close interrupted is put back on the next start, and runs again', async () => {
      const { r, before, target } = await behind()
      // What a kill mid-check leaves: the worktree detached on the trial merge, the marker on record.
      const worktree = String(r.integration().worktree)
      gitIn(r.cache, 'fetch', '--quiet', URL_ON_GITHUB, 'main')
      gitIn(worktree, 'checkout', '--quiet', '--detach')
      gitIn(worktree, 'merge', '--quiet', '--no-ff', '-m', 'trial', target)
      r.store.atomic(() => {
        r.store.engines.save({ ...r.integration(), updating: { from: before, at: AT } })
        r.store.engines.save({ ...r.doc(), update: { status: 'requested', at: AT } })
      })
      await r.passes(1)
      expect(r.integration().updating).toBeUndefined()
      expect(repairs(r)).toEqual([])
      await r.passes(2)
      expect(r.integration().head).not.toBe(before)
      expect(r.cards('push').at(-1)).toMatchObject({ status: 'pending', inputSha: r.integration().head })
    })

    it('is not offered before the owner agreed to run the repository commands', async () => {
      const { r } = await behind()
      expect(retryOffer(r.store, work(r))?.kind).toBe('update')
      r.store.atomic(() => {
        const { hostRunAgreedAt: _agreed, ...repo } = r.store.engines.get(REPO) as StoreDoc
        r.store.engines.save(repo)
      })
      expect(retryOffer(r.store, work(r))).toBeUndefined()
    })
  })

  describe('(d) required checks GitHub has not finished say so, and since when', () => {
    it('records when the wait began and whether anything started, and forgets it once they pass', async () => {
      const r = await openPr({ world: { checks: ok('[{"name":"check","state":"QUEUED"}]') } })
      await r.passes(1)
      expect(r.doc()).toMatchObject({
        stage: 'pr_open',
        ci: 'ci_pending',
        ciQueued: true,
        ciSince: r.doc().ciAt,
      })
      // An earlier start on record stands: each read keeps when the wait began, not when it read.
      const since = AT
      r.store.atomic(() => r.store.engines.save({ ...r.doc(), ciSince: since }))
      await r.passes(1)
      expect(r.doc().ciSince).toBe(since)
      r.world.checks = ok('[{"name":"check","state":"IN_PROGRESS"}]')
      await r.passes(1)
      expect(r.doc()).toMatchObject({ ci: 'ci_pending', ciSince: since })
      expect(r.doc().ciQueued).toBeUndefined()
      r.world.checks = ok('[{"name":"check","state":"SUCCESS"}]')
      await r.passes(1)
      expect(r.doc().stage).toBe('ready')
      expect(r.doc().ciSince).toBeUndefined()
    })
  })
})
