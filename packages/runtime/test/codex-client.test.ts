// M2.4 Part B: the Codex client against a real process, the fake CLI, in its own process group.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { CODEX_TOKEN_VAR, codexAttemptArgs, codexOtherServers, startCodexClient } from '../src/codex-client'
import { ownedSpawn } from '../src/owned-spawn'
import { Supervisor } from '../src/supervisor'

const FAKE_CLI = fileURLToPath(new URL('../../testkit/fake-cli/codex', import.meta.url))
const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'mec-codex-client-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { clientInfo: { name: 'mec', title: 'mec', version: '0.1.0' }, capabilities: {} },
}

const OPTIONS = {
  worktree: '/data/work/att_1',
  tempDir: '/data/tmp/att_1',
  sharedClone: '/data/repos/r.git',
  denyRead: ['/data/mec.db', '/home/u/.codex'],
  toolsUrl: 'http://127.0.0.1:7777/mcp',
  otherServers: [],
  readOnly: false,
}

function start(name: string, env: Record<string, string> = {}) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  copyFileSync(FAKE_CLI, join(dir, 'codex'))
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ steps: [{ saveToken: true }] }))
  const supervisor = new Supervisor()
  const spawn = ownedSpawn(supervisor, { attemptId: name, generation: 1 }, { stdin: true })
  const client = startCodexClient({
    binary: join(dir, 'codex'),
    args: codexAttemptArgs(OPTIONS),
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', ...env },
    spawn,
  })
  const seen = () => JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'))
  return { dir, client, seen, stop: () => supervisor.stop(name, 1) }
}

describe('the Codex client', () => {
  it('answers a request, keeps notifications in order, and carries a turn to its line', async () => {
    const { client, stop } = start('order')
    await expect(client.post(INIT)).resolves.toMatchObject({ codexHome: '/nowhere' })
    await client.post({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: { cwd: '/x' } })
    const lines = client.notifications()[Symbol.asyncIterator]()
    const first = await lines.next()
    expect(JSON.parse(first.value as string).method).toBe('thread/started')
    await stop()
  })

  it('refuses a JSON-RPC error by rejecting the request, and a second initialize is one', async () => {
    const { client, stop } = start('refuse')
    await client.post(INIT)
    await expect(client.post({ ...INIT, id: 2 })).rejects.toThrow('Already initialized')
    await stop()
  })

  it('a request in flight when the server dies rejects, and the stream ends with the code', async () => {
    const { client, stop } = start('dies')
    const hanging = client.post({ jsonrpc: '2.0', id: 9, method: 'never/answered' })
    const refused = expect(hanging).rejects.toThrow()
    await client.post(INIT)
    await stop()
    await refused
    const lines = client.notifications()[Symbol.asyncIterator]()
    await expect(lines.next()).resolves.toMatchObject({ done: true })
    expect(client.processExitCode()).toBeGreaterThanOrEqual(128)
  })

  it('client carries slot env only', async () => {
    process.env.MEC_LEAKED_FROM_HOST = 'host-value'
    const { client, seen, stop } = start('env', { CODEX_HOME: '/slots/codex/one' })
    await client.post(INIT)
    delete process.env.MEC_LEAKED_FROM_HOST
    expect(seen().codex_home).toBe('/slots/codex/one')
    expect(seen().env_names).not.toContain('MEC_LEAKED_FROM_HOST')
    await stop()
  })

  it('token reaches the engine for this attempt only, through its environment', async () => {
    const one = start('token-one', { [CODEX_TOKEN_VAR]: 'token-of-attempt-one' })
    const two = start('token-two', { [CODEX_TOKEN_VAR]: 'token-of-attempt-two' })
    for (const { client } of [one, two]) {
      await client.post(INIT)
      await client.post({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: {} })
      await client.post({ jsonrpc: '2.0', id: 3, method: 'turn/start', params: {} })
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(readFileSync(join(one.dir, 'token.txt'), 'utf8')).toBe('token-of-attempt-one')
    expect(readFileSync(join(two.dir, 'token.txt'), 'utf8')).toBe('token-of-attempt-two')
    expect(JSON.stringify(one.seen().argv)).not.toContain('token-of-attempt')
    await one.stop()
    await two.stop()
  })
})

describe('the attempt arguments', () => {
  const args = codexAttemptArgs(OPTIONS)
  const text = args.join(' ')
  const profile = args.find((arg) => arg.startsWith('permissions.mec=')) ?? ''

  it('writes only to the worktree and temp dir, and reads the shared clone without writing it', () => {
    expect(args[0]).toBe('app-server')
    expect(args).toContain('default_permissions="mec"')
    expect(profile).toContain('":root"="read"')
    expect(profile).toContain('"/data/work/att_1"="write"')
    expect(profile).toContain('"/data/tmp/att_1"="write"')
    expect(profile).toContain('"/data/repos/r.git"="read"')
  })

  it('keeps the control directories out of the worktree grant', () => {
    expect(profile).toContain('"/data/work/att_1/.mec"="read"')
    expect(profile).toContain('"/data/work/att_1/.git"="read"')
  })

  it('denies every deny-listed path, for reading too', () => {
    expect(profile).toContain('"/data/mec.db"="deny"')
    expect(profile).toContain('"/home/u/.codex"="deny"')
  })

  it("refuses reading sibling attempts' worktrees and temp dirs, and keeps this attempt's own", () => {
    expect(profile).toContain('"/data/work"="deny"')
    expect(profile).toContain('"/data/tmp"="deny"')
    expect(profile).toContain('"/data/work/att_1"="write"')
    expect(profile).toContain('"/data/tmp/att_1"="write"')
  })

  it('never lets thread/start trust the repo cache, so project config stays off', () => {
    expect(args).toContain('projects={"/data/repos"={trust_level="untrusted"}}')
  })

  it('a read-only role writes nothing to the worktree', () => {
    const readOnly = codexAttemptArgs({ ...OPTIONS, readOnly: true }).join(' ')
    expect(readOnly).toContain('"/data/work/att_1"="read"')
    expect(readOnly).not.toContain('"/data/work/att_1"="write"')
  })

  it('names the token variable and never a token', () => {
    expect(text).toContain(`bearer_token_env_var="${CODEX_TOKEN_VAR}"`)
    expect(text).toContain('url="http://127.0.0.1:7777/mcp"')
    expect(text).not.toMatch(/bearer_token="/)
  })

  it('hides the token from the shell the engine starts', () => {
    expect(text).toContain(`shell_environment_policy.exclude=["${CODEX_TOKEN_VAR}"]`)
    expect(text).toContain('allow_login_shell=false')
  })

  it("switches off the user's hooks, plugins and apps, and every other MCP server by name", () => {
    const fenced = codexAttemptArgs({
      ...OPTIONS,
      otherServers: [
        { name: 'runpod', transport: 'streamable_http' },
        { name: 'arxiv', transport: 'stdio' },
      ],
    })
    for (const feature of ['hooks', 'plugins', 'apps', 'memories']) {
      expect(fenced.join(' ')).toContain(`--disable ${feature}`)
    }
    expect(fenced).toContain('mcp_servers.arxiv={command="true",enabled=false}')
    expect(fenced).toContain('mcp_servers.runpod={url="http://127.0.0.1:9/",enabled=false}')
  })

  it('refuses a server whose name it cannot fence', () => {
    expect(() =>
      codexAttemptArgs({ ...OPTIONS, otherServers: [{ name: 'a"b', transport: 'stdio' }] }),
    ).toThrow('cannot fence')
  })

  it('carries the effort it is given', () => {
    expect(codexAttemptArgs({ ...OPTIONS, effort: 'low' })).toContain('model_reasoning_effort="low"')
  })
})

describe('the servers another config adds', () => {
  it('reads names and transports from the listing and nothing else', () => {
    const listing = JSON.stringify([
      { name: 'runpod', enabled: true, transport: { type: 'streamable_http', url: 'https://x' } },
      { name: 'computer-use', enabled: false, transport: { type: 'stdio', command: 'x' } },
    ])
    expect(codexOtherServers(listing)).toEqual([
      { name: 'runpod', transport: 'streamable_http' },
      { name: 'computer-use', transport: 'stdio' },
    ])
  })

  it('an unreadable listing is an error, never an empty fence', () => {
    expect(() => codexOtherServers('not json')).toThrow('codex mcp list')
  })
})
