// M2.3 end of the line: accepted tasks in the bare cache, one integration worktree, the push and
// PR cards, a recording fake gh, and real git against a local bare repository standing in for
// GitHub, reached through `insteadOf` because a local path is refused as an origin.
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StoreDoc } from '@mec/contracts'
import { DEFAULT_CAPS } from '@mec/domain'
import { integrationDocId, type MetaBrain, type MetaPlanTask, repoFields, workResultOf } from '@mec/meta'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import { MemoryRepositories } from '@mec/testkit'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { commitWork } from '../src/attempt-launch'
import { startServer } from '../src/composition'
import { Delivery, deliveryDocId } from '../src/delivery'
import { type GhResult, type GhRun, resolvePush, resolveReleaseCard } from '../src/release'

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
  pr: { state: string; headRefOid: string } | undefined
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
              ...world.pr,
              title: 'T',
              headRefName: BRANCH,
              mergeStateStatus: 'CLEAN',
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

function rig(over: { checks?: { name: string; cmd: string }[]; world?: Partial<World> } = {}) {
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
      bootstrap: [],
      checks: over.checks ?? [{ name: 'unit', cmd: 'test -f a.txt' }],
      trust: false,
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
    caps: DEFAULT_CAPS,
    run,
    pollMs: 0,
  })

  /** An accepted task, on its own branch in the cache, with what it changed committed. */
  const accepted = (id: string, file: string, text: string, from = base): void => {
    const path = join(root, `wt-${id}`)
    const branch = `mec/abcdef12/${id}/a1`
    gitIn(cache, 'worktree', 'add', '--quiet', '-b', branch, path, from)
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

  it('a repository with no required checks is ready with that limit stated (#34)', async () => {
    const r = await openPr({
      world: { checks: { code: 1, stdout: '', stderr: 'no required checks reported' } },
    })
    await r.passes(1)
    expect(r.doc()).toMatchObject({ stage: 'ready', limit: 'no_required_checks' })
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

describe('through the real server (fake CLI, fake gh, no engine run)', () => {
  const FAKE_CLI = fileURLToPath(new URL('../../../packages/testkit/fake-cli/claude', import.meta.url))
  const REAL_PATH = process.env.PATH
  const closers: (() => Promise<void>)[] = []

  afterEach(async () => {
    for (const close of closers.splice(0)) await close()
    process.env.PATH = REAL_PATH
    delete process.env.MEC_REAL_RUNNER
    delete process.env.GIT_CONFIG_GLOBAL
  })

  const FAKE_GH = `#!/bin/sh
echo "$*" >> "$(dirname "$0")/gh.log"
case "$*" in
  "repo view"*) echo '{"url":"${URL_ON_GITHUB}","defaultBranchRef":{"name":"main"}}' ;;
  "pr list"*) echo '[]' ;;
  "api repos/${SLUG}/branches"*) ;;
  *"/git/ref/heads/"*) git -C "$(dirname "$0")/../github.git" rev-parse "refs/heads/\${2##*/git/ref/heads/}" ;;
  "pr create"*) echo "${URL_ON_GITHUB}/pull/${PR}" ;;
  *) exit 1 ;;
esac
`

  async function serve(
    tasks: MetaPlanTask[],
    checks: { name: string; cmd: string }[],
    steps: unknown[] = [{ init: true }, { sh: 'echo made > "$MEC_ATTEMPT_ID.txt"' }, { result: 'completed' }],
  ) {
    const root = mkdtempSync(join(tmpdir(), 'mec-delivery-e2e-'))
    roots.push(root)
    const dataDir = join(root, 'state')
    mkdirSync(dataDir)
    const bare = join(root, 'github.git')
    gitIn(root, 'init', '--quiet', '--bare', '-b', 'main', bare)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    gitIn(repo, 'init', '--quiet', '-b', 'main')
    gitIn(repo, 'config', 'user.name', 'Repo Owner')
    gitIn(repo, 'config', 'user.email', 'owner@example.com')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    gitIn(repo, 'add', '--all')
    gitIn(repo, 'commit', '--quiet', '-m', 'baseline')
    gitIn(repo, 'remote', 'add', 'origin', bare)
    gitIn(repo, 'push', '--quiet', 'origin', 'main')
    gitIn(repo, 'remote', 'set-url', 'origin', `git@github.com:${SLUG}.git`)
    const gitconfig = join(root, 'gitconfig')
    writeFileSync(gitconfig, `[url "${bare}"]\n\tinsteadOf = ${URL_ON_GITHUB}\n`)
    process.env.GIT_CONFIG_GLOBAL = gitconfig

    const bin = join(root, 'bin')
    mkdirSync(bin)
    copyFileSync(FAKE_CLI, join(bin, 'claude'))
    writeFileSync(join(bin, 'gh'), FAKE_GH)
    chmodSync(join(bin, 'gh'), 0o755)
    writeFileSync(join(bin, 'scenario.json'), JSON.stringify({ steps }))
    process.env.PATH = `${bin}:${REAL_PATH}`
    process.env.MEC_REAL_RUNNER = '1'

    const db = new Database(join(dataDir, 'mec.db'))
    migrate(db, MIGRATIONS_v1)
    const store = new SqliteStore(db)
    store.atomic(() => {
      store.engines.save({ id: REPO, url: repo, bootstrap: [], checks, trust: false })
      store.slots.save({
        id: 'slot_linked',
        engine: 'claude',
        kind: 'claude-sub',
        home: '/nowhere',
        state: 'healthy',
        env: {},
        concurrency: 2,
      })
    })
    db.close()

    let turns = 0
    const brain: MetaBrain = async () => {
      turns += 1
      return turns === 1 ? { ack: 'On it', plan: { tasks } } : { ack: 'ok' }
    }
    const server = await startServer({ dataDir, policyText: POLICY, closeBoundMs: 4000, brain })
    closers.push(server.close)
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: (await response.json()) as Record<string, unknown> }
    }
    const read = <T>(fn: (store: SqliteStore) => T): T => {
      const open = new Database(join(dataDir, 'mec.db'))
      try {
        return fn(new SqliteStore(open))
      } finally {
        open.close()
      }
    }
    return { post, read, bin, bare }
  }

  // A fresh script's first exec has taken 25 s on this machine late in a run (M2.2's record).
  async function until(test: () => boolean, ms = 120_000): Promise<void> {
    const deadline = Date.now() + ms
    while (!test()) {
      if (Date.now() > deadline) throw new Error('condition never held')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  const task = (taskId: string, dependsOn: string[] = []): MetaPlanTask => ({
    taskId,
    objective: `do ${taskId}`,
    dependsOn,
    role: 'implementer',
  })

  it('a chain of integration tasks runs to a push card, then a PR card, with one message', async () => {
    const checks = [{ name: 'unit', cmd: 'test -f a.txt' }]
    const r = await serve([task('first'), task('second', ['first']), task('third', ['second'])], checks)
    await r.post('/api/chat/messages', { text: 'Add the audit log', repoId: REPO })

    const pushCards = () => r.read((store) => store.confirmations.list().filter((doc) => doc.cls === 'push'))
    await until(() => pushCards().length === 1)
    const facts = r.read((store) => {
      const work = store.workItems.list()[0] as StoreDoc
      const integration = store.engines.get(integrationDocId(String(work.id))) as StoreDoc
      return { work, integration, attempts: store.attempts.list(), tasks: store.tasks.list() }
    })
    expect(facts.work.state).toBe('integrating')
    expect(facts.tasks.map((doc) => doc.status)).toEqual(['integrated', 'integrated', 'integrated'])
    const integrated = facts.integration.integrated as Record<string, string>
    const first = facts.tasks.find((doc) => doc.localKey === 'first') as StoreDoc
    const second = facts.tasks.find((doc) => doc.localKey === 'second') as StoreDoc
    const attemptOf = (doc: StoreDoc) => facts.attempts.find((row) => row.taskId === doc.id) as StoreDoc
    // An integration dependent starts from the commit its prerequisite integrated at.
    expect(attemptOf(second).base_sha).toBe(integrated[String(first.id)])
    expect(attemptOf(first).base_sha).toBe(facts.work.base_sha)
    expect(pushCards()[0]).toMatchObject({ status: 'pending', inputSha: facts.integration.head })

    const approved = await r.post(`/api/inbox/${String(pushCards()[0]?.id)}/resolve`, { answer: 'approve' })
    expect(approved.body).toMatchObject({ status: 'approved', pushed: true })
    const prCards = () =>
      r.read((store) => store.confirmations.list().filter((doc) => doc.cls === 'pr_create'))
    await until(() => prCards().length === 1)
    expect(
      gitIn(r.bare, 'rev-parse', `refs/heads/mec/${String(facts.work.id).slice(3, 11)}/integration`),
    ).toBe(facts.integration.head)
    expect(readFileSync(join(r.bin, 'gh.log'), 'utf8')).not.toContain('pr create')
  }, 200_000)

  it('a conflict is repaired mid-merge by a repair task, and the result has two parents', async () => {
    const sh =
      'case "$MEC_ATTEMPT_ID" in att_3) echo both > a.txt ;; *) echo "$MEC_ATTEMPT_ID" > a.txt ;; esac'
    const contract = (taskId: string): MetaPlanTask => ({ ...task(taskId), basePolicy: 'contract' })
    const r = await serve(
      [contract('left'), contract('right')],
      [{ name: 'unit', cmd: 'test -f a.txt' }],
      [{ init: true }, { sh }, { result: 'completed' }],
    )
    await r.post('/api/chat/messages', { text: 'Add the audit log', repoId: REPO })
    const cards = () => r.read((store) => store.confirmations.list().filter((doc) => doc.cls === 'push'))
    await until(() => cards().length === 1)
    const facts = r.read((store) => {
      const work = store.workItems.list()[0] as StoreDoc
      const integration = store.engines.get(integrationDocId(String(work.id))) as StoreDoc
      return { integration, attempts: store.attempts.list(), tasks: store.tasks.list() }
    })
    const repair = facts.tasks.find((doc) => doc.repairOf !== undefined) as StoreDoc
    expect(repair).toMatchObject({ role: 'repair_agent', status: 'integrated' })
    expect(facts.tasks.map((doc) => doc.status)).toEqual(['integrated', 'integrated', 'integrated'])
    const worktree = String(facts.integration.worktree)
    expect(facts.attempts.find((doc) => doc.taskId === repair.id)?.worktree).toBe(worktree)
    const head = String(facts.integration.head)
    expect(gitIn(worktree, 'rev-parse', 'HEAD')).toBe(head)
    expect(gitIn(worktree, 'rev-parse', 'HEAD^@').split('\n')).toHaveLength(2)
    expect(readFileSync(join(worktree, 'a.txt'), 'utf8')).toBe('both\n')
    expect(facts.integration.combined).toMatchObject({ sha: head, passed: true })
  }, 200_000)

  it('a sensitive task gets a read-only reviewer on its head, and only then integrates', async () => {
    const ready = { call: { tool: 'report', args: { kind: 'ready', summary: 'done' } } }
    const sensitive: MetaPlanTask = { ...task('only'), sensitive: true }
    const r = await serve(
      [sensitive],
      [{ name: 'unit', cmd: 'test -f a.txt' }],
      [{ init: true }, { sh: 'echo made > "$MEC_ATTEMPT_ID.txt"; true' }, ready, { result: 'completed' }],
    )
    await r.post('/api/chat/messages', { text: 'Rotate the signing key', repoId: REPO })
    await until(() => r.read((store) => store.tasks.list()[0]?.status) === 'integrated')
    const attempts = r.read((store) => store.attempts.list())
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toMatchObject({
      role: 'code_reviewer',
      state: 'succeeded',
      worktree: attempts[0]?.worktree,
    })
    expect(attempts[1]?.head_sha).not.toBe(attempts[0]?.base_sha)
  }, 200_000)

  it('a repair attempt fixes failed checks in the same worktree, and no one is asked', async () => {
    // Red until a file only the second attempt writes is there.
    const checks = [{ name: 'unit', cmd: 'test -f att_2.txt' }]
    const r = await serve([task('only')], checks)
    await r.post('/api/chat/messages', { text: 'Add the audit log', repoId: REPO })
    await until(() => r.read((store) => store.tasks.list()[0]?.status) === 'integrated')
    const attempts = r.read((store) => store.attempts.list())
    expect(attempts.map((doc) => doc.state)).toEqual(['checks_failed', 'succeeded'])
    expect(attempts[1]).toMatchObject({
      role: 'repair_agent',
      worktree: attempts[0]?.worktree,
      branch: attempts[0]?.branch,
    })
  }, 200_000)
})
