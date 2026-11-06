// A scratch server built from this tree, a scratch repository, and a fake `gh`. Everything the
// journey reads it reads from a route, the bare repository or the fake `gh`'s log. Nothing here
// touches `~/.mec`, and only a process this rig started is ever signalled, by its PID.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type JourneyMode, serverEnv } from './journey-gate'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const MEC = join(ROOT, 'apps/desktop/bin/mec.js')
const FAKE_CLI = join(ROOT, 'packages/testkit/fake-cli/claude')
const SLUG = 'journey/scratch'
const ON_GITHUB = `https://github.com/${SLUG}`
export const PR = 7

/** A stand-in for GitHub: one bare repository, one PR, its required checks green. */
const FAKE_GH = `#!/bin/sh
here=$(dirname "$0")
echo "$*" >> "$here/gh.log"
case "$*" in
  "repo view"*) echo '{"url":"${ON_GITHUB}","defaultBranchRef":{"name":"main"}}' ;;
  "pr list"*) echo '[]' ;;
  "api repos/${SLUG}/branches"*) ;;
  *"/git/ref/heads/"*) git -C "$here/../github.git" rev-parse "refs/heads/\${2##*/git/ref/heads/}" ;;
  "pr create"*)
    while [ $# -gt 0 ]; do
      [ "$1" = "--head" ] && printf %s "$2" > "$here/pr-branch"
      shift
    done
    echo "${ON_GITHUB}/pull/${PR}" ;;
  "pr view"*)
    branch=$(cat "$here/pr-branch")
    head=$(git -C "$here/../github.git" rev-parse "refs/heads/$branch")
    printf '{"state":"OPEN","title":"journey","headRefName":"%s","headRefOid":"%s","mergeStateStatus":"CLEAN"}\\n' "$branch" "$head" ;;
  "pr checks"*) echo '[{"name":"unit","state":"SUCCESS"}]' ;;
  *) exit 1 ;;
esac
`

/**
 * The `claude` first on PATH in fake mode. The planner and a worker are different runs, so each has
 * its own copy of the fake CLI and its own scenario, and the planner's depends on which turn it is.
 */
const FAKE_CLAUDE = `#!/bin/sh
here=$(dirname "$0")
case "$1" in
  --version) echo '2.1.318 (Claude Code)'; exit 0 ;;
  --help) exit 0 ;;
  auth) echo '{"loggedIn":true}'; exit 0 ;;
esac
case "$MEC_ATTEMPT_ID" in
  att_meta*)
    turn=$(( $(cat "$here/planner/turn" 2>/dev/null || echo 0) + 1 ))
    echo "$turn" > "$here/planner/turn"
    if [ -f "$here/planner/$turn.json" ]; then cp "$here/planner/$turn.json" "$here/planner/scenario.json"
    else cp "$here/planner/quiet.json" "$here/planner/scenario.json"; fi
    exec "$here/planner/claude" "$@" ;;
esac
echo "$MEC_ATTEMPT_ID" >> "$here/launched.log"
exec "$here/worker/claude" "$@"
`

const ack = (text: string) => ({ call: { tool: 'acknowledge', args: { message_id: 'journey', text } } })
const report = (summary: string) => ({ call: { tool: 'report_result', args: { summary } } })
const turn = (...steps: unknown[]) => ({ steps: [{ init: true }, ...steps, { result: 'completed' }] })

const QUIET_TURN = turn(ack('Noted.'), report('Nothing to do this turn.'))

export const askTurn = (question: string, options: string[]) =>
  turn(
    ack('Before I plan this, one question.'),
    { call: { tool: 'ask_user', args: { question, options } } },
    report('Asked one question.'),
  )

export const planTurn = (tasks: { id: string; objective: string; depends_on?: string[] }[]) =>
  turn(
    ack('On it.'),
    {
      call: {
        tool: 'propose_plan',
        args: {
          tasks: tasks.map((task) => ({
            depends_on: [],
            role: 'implementer',
            model_request: { tier: 'fast', reason: 'a small scripted change' },
            ...task,
          })),
        },
      },
    },
    report('Planned.'),
  )

const WORKER_MAKES_A_FILE = [
  { init: true },
  { sh: 'echo made > "$MEC_ATTEMPT_ID.txt"' },
  { result: 'completed' },
]

export interface Rig {
  url: string
  /** The planner's turns in order; any turn after them is a quiet one. */
  plannerTurns: (...turns: unknown[]) => void
  workerSteps: (steps: unknown[]) => void
  api: <T = Record<string, unknown>>(path: string, body?: unknown) => Promise<T>
  repoId: string
  /** Stops the server by this signal, then starts it on the same store. */
  restart: (how: 'SIGTERM' | 'SIGKILL') => Promise<void>
  ghLog: () => string[]
  /** Worker attempts the fake CLI started, in order. Fake mode only. */
  launched: () => string[]
  /** A branch on the fake GitHub, or undefined. */
  remoteHead: (branch: string) => string | undefined
  /** What that branch holds. */
  remoteFiles: (branch: string) => string[]
  /** The branch in MEC's own bare cache of the repository: what a declined push leaves behind. */
  cacheHead: (branch: string) => string | undefined
  dispose: () => Promise<void>
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Repo Owner', '-c', 'user.email=owner@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()

const headIn = (gitDir: string, branch: string): string | undefined => {
  try {
    return git(gitDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)
  } catch {
    return undefined
  }
}

function scratchRepo(root: string, name: string, origin: string): string {
  const repo = join(root, name)
  mkdirSync(repo)
  git(repo, 'init', '--quiet', '-b', 'main')
  git(repo, 'config', 'user.name', 'Repo Owner')
  git(repo, 'config', 'user.email', 'owner@example.com')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', '--all')
  git(repo, 'commit', '--quiet', '-m', 'baseline')
  git(repo, 'remote', 'add', 'origin', origin)
  return repo
}

export async function startRig(mode: JourneyMode): Promise<Rig> {
  const built = ['apps/desktop/dist/mec.mjs', 'apps/web/dist/index.html']
  if (!built.every((path) => existsSync(join(ROOT, path)))) {
    throw new Error('build first: pnpm build:desktop && pnpm --dir apps/web build')
  }
  const root = mkdtempSync(join(tmpdir(), 'mec-journey-'))
  const home = join(root, 'home')
  mkdirSync(home)
  const dataDir = join(home, '.mec')
  const bin = join(root, 'bin')
  mkdirSync(bin)

  // `origin` reads as GitHub, as gh and the push door require; git carries it to a file:// bare.
  const bare = join(root, 'github.git')
  git(root, 'init', '--quiet', '--bare', '-b', 'main', bare)
  const repo = scratchRepo(root, 'scratch', `git@github.com:${SLUG}.git`)
  git(repo, 'push', '--quiet', bare, 'main')
  scratchRepo(root, 'second', 'git@github.com:journey/second.git')
  const gitConfig = join(root, 'gitconfig')
  writeFileSync(gitConfig, `[url "file://${bare}"]\n\tinsteadOf = ${ON_GITHUB}\n`)

  writeFileSync(join(bin, 'gh'), FAKE_GH)
  chmodSync(join(bin, 'gh'), 0o755)
  if (mode === 'fake') {
    for (const part of ['planner', 'worker']) {
      mkdirSync(join(bin, part))
      copyFileSync(FAKE_CLI, join(bin, part, 'claude'))
    }
    writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
    chmodSync(join(bin, 'claude'), 0o755)
    writeFileSync(join(bin, 'planner/quiet.json'), JSON.stringify(QUIET_TURN))
    writeFileSync(join(bin, 'worker/scenario.json'), JSON.stringify({ steps: WORKER_MAKES_A_FILE }))
  }
  const env = serverEnv({
    mode,
    inherited: process.env,
    bin,
    ownerHome: homedir(),
    scratchHome: home,
    dataDir,
    gitConfig,
  })

  let child: ChildProcess | undefined
  let url = ''
  const log = join(root, 'server.log')
  const start = (): Promise<void> =>
    new Promise((ready, failed) => {
      const server = spawn(process.execPath, [MEC], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
      child = server
      const bail = setTimeout(() => failed(new Error(`no server in 60 s; see ${log}`)), 60_000)
      server.stderr?.on('data', (chunk) => appendFileSync(log, chunk))
      server.stdout?.on('data', (chunk) => {
        appendFileSync(log, chunk)
        const found = /mec server listening on (\S+)/.exec(String(chunk))
        if (found?.[1] === undefined) return
        clearTimeout(bail)
        url = found[1]
        ready()
      })
      server.once('exit', (code) => {
        clearTimeout(bail)
        failed(new Error(`server exited ${String(code)}; see ${log}`))
      })
    })
  const halt = async (how: 'SIGTERM' | 'SIGKILL'): Promise<void> => {
    const server = child
    if (server?.pid === undefined || server.exitCode !== null || server.signalCode !== null) return
    const gone = new Promise((done) => server.once('exit', done))
    server.kill(how)
    const bound = setTimeout(() => server.kill('SIGKILL'), 15_000)
    await gone
    clearTimeout(bound)
  }

  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${url}${path}`, {
      headers: {
        'x-mec-client': '1',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { method: 'POST', body: JSON.stringify(body) }),
    })
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
    return (await response.json()) as T
  }

  await start()
  try {
    await api('/api/slots/link', { engine: 'claude', label: 'linked' })
    const probed = await api<{ ok?: boolean; reason?: string }>('/api/slots/slot_linked/probe', {})
    if (probed.ok !== true) throw new Error(`the linked slot is not healthy: ${String(probed.reason)}`)
    await api('/api/wizard/meta-slot', { slotId: 'slot_linked' })
    const register = (urlOrPath: string) =>
      api<{ id: string }>('/api/repositories', {
        urlOrPath,
        checkCmds: [{ name: 'unit', cmd: 'test -f a.txt' }],
        bootstrapCmds: [],
        trusted: false,
      })
    const { id: repoId } = await register(repo)
    await register(join(root, 'second'))
    // The meta agent's slot is read at boot.
    await halt('SIGTERM')
    await start()
    return {
      get url() {
        return url
      },
      repoId,
      plannerTurns: (...turns) => {
        if (mode === 'real') return
        for (const [index, planned] of turns.entries()) {
          writeFileSync(join(bin, `planner/${index + 1}.json`), JSON.stringify(planned))
        }
      },
      workerSteps: (steps) => {
        if (mode === 'fake') writeFileSync(join(bin, 'worker/scenario.json'), JSON.stringify({ steps }))
      },
      api,
      restart: async (how) => {
        await halt(how)
        await start()
      },
      ghLog: () =>
        existsSync(join(bin, 'gh.log')) ? readFileSync(join(bin, 'gh.log'), 'utf8').split('\n') : [],
      launched: () =>
        existsSync(join(bin, 'launched.log'))
          ? readFileSync(join(bin, 'launched.log'), 'utf8').split('\n').filter(Boolean)
          : [],
      remoteHead: (branch) => headIn(bare, branch),
      remoteFiles: (branch) => git(bare, 'ls-tree', '-r', '--name-only', branch).split('\n'),
      cacheHead: (branch) => {
        const caches = join(dataDir, 'repos')
        for (const name of existsSync(caches) ? readdirSync(caches) : []) {
          const head = headIn(join(caches, name), branch)
          if (head !== undefined) return head
        }
        return undefined
      },
      dispose: async () => {
        await halt('SIGTERM')
        if (process.env.MEC_JOURNEY_KEEP !== '1') rmSync(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await halt('SIGKILL')
    throw error
  }
}
