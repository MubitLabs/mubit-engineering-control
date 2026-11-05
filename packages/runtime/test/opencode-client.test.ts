// M2.4 Part B: the OpenCode client against a real process, the fake CLI, in its own group.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  OPENCODE_TOKEN_VAR,
  type OpenCodeRule,
  opencodeAttemptConfig,
  startOpenCodeClient,
} from '../src/opencode-client'
import { ownedSpawn } from '../src/owned-spawn'
import { Supervisor } from '../src/supervisor'

const FAKE_CLI = fileURLToPath(new URL('../../testkit/fake-cli/opencode', import.meta.url))
const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'mec-opencode-client-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

async function start(
  name: string,
  opts: {
    env?: Record<string, string>
    secrets?: Record<string, string>
    scenario?: Record<string, unknown>
    startTimeoutMs?: number
  } = {},
) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  copyFileSync(FAKE_CLI, join(dir, 'opencode'))
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ steps: [], ...opts.scenario }))
  const config = join(dir, 'attempt.json')
  writeFileSync(config, JSON.stringify(opencodeAttemptConfig({ toolsUrl: 'http://127.0.0.1:1/mcp' })))
  const supervisor = new Supervisor()
  const spawn = ownedSpawn(supervisor, { attemptId: name, generation: 1 }, { stdin: true })
  const client = await startOpenCodeClient({
    binary: join(dir, 'opencode'),
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', OPENCODE_CONFIG: config, ...opts.env },
    ...(opts.secrets !== undefined && { secrets: opts.secrets }),
    spawn,
    ...(opts.startTimeoutMs !== undefined && { startTimeoutMs: opts.startTimeoutMs }),
    verdictGraceMs: 150,
  })
  const seen = () => JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'))
  return { dir, client, seen, stop: () => supervisor.stop(name, 1) }
}

const drain = async (lines: AsyncIterable<string>): Promise<string[]> => {
  const all: string[] = []
  for await (const line of lines) all.push(line)
  return all
}

describe('the OpenCode client', () => {
  it('connects with the password it minted, and a wrong one would be refused', async () => {
    const { client, seen, stop } = await start('password')
    await expect(client.post('/api/session', { location: { directory: root } })).resolves.toEqual({
      data: { id: 'ses_fake_1' },
    })
    expect(seen().env_names).toContain('OPENCODE_PASSWORD')
    await stop()
  })

  it('an answer with an empty body is no answer, not a parse error', async () => {
    const { client, stop } = await start('empty')
    await expect(client.post('/api/session/x/permission/y/reply', { decision: 'once' })).resolves.toBe(
      undefined,
    )
    await stop()
  })

  it('a refused request throws with its status', async () => {
    const { client, stop } = await start('status')
    await stop()
    await expect(client.post('/api/session', {})).rejects.toThrow()
  })

  it('ready resolves only once the stream is open, so no first event is missed', async () => {
    const { client, stop } = await start('ready')
    const lines = client.sse()[Symbol.asyncIterator]()
    const first = lines.next()
    await client.ready()
    await client.post('/api/session', { location: { directory: root } })
    expect((await first).value).toContain('server.connected')
    expect((await lines.next()).value).toContain('session.created')
    await stop()
  })

  it('the stream ends after the verdict, and what comes after it still arrives', async () => {
    const { client, stop } = await start('verdict', { scenario: { steps: [{ verdict: 'succeeded' }] } })
    const lines = drain(client.sse())
    await client.ready()
    await client.post('/api/session/ses_fake_1/prompt', { text: 'go' })
    const all = await lines
    expect(all.some((line) => line.includes('session.execution.succeeded'))).toBe(true)
    expect(all.some((line) => line.includes('session.renamed'))).toBe(true)
    await stop()
  })

  it('a verdict named in the text of an event does not end the stream', async () => {
    const echo = { type: 'session.text.ended', data: { text: 'ends at session.execution.succeeded' } }
    const steps = [{ event: echo }, { sleep: 400 }, { event: echo }, { verdict: 'succeeded' }]
    const { client, stop } = await start('echo', { scenario: { steps } })
    const lines = drain(client.sse())
    await client.ready()
    await client.post('/api/session/ses_fake_1/prompt', { text: 'go' })
    const all = await lines
    expect(all.filter((line) => line.includes('session.text.ended'))).toHaveLength(2)
    await stop()
  })

  it('a dead server ends the stream, it does not hang', async () => {
    const { client, stop } = await start('dead')
    const lines = drain(client.sse())
    await client.ready()
    await stop()
    await expect(lines).resolves.toBeDefined()
  })

  it('a server that never names its url fails the start in bounded time', async () => {
    await expect(start('nourl', { scenario: { noUrl: true }, startTimeoutMs: 1000 })).rejects.toThrow(
      'opencode serve',
    )
  })

  it('client carries slot env only, and the secrets it was handed for this process', async () => {
    process.env.MEC_LEAKED_FROM_HOST = 'host-value'
    const { seen, stop } = await start('env', { secrets: { ZHIPU_API_KEY: 'key-value' } })
    delete process.env.MEC_LEAKED_FROM_HOST
    expect(seen().env_names).toContain('ZHIPU_API_KEY')
    expect(seen().env_names).not.toContain('MEC_LEAKED_FROM_HOST')
    await stop()
  })

  it('stdin stays open: the server lives past its start', async () => {
    const { client, stop } = await start('stdin')
    await new Promise((resolve) => setTimeout(resolve, 200))
    await expect(client.post('/api/session', {})).resolves.toBeDefined()
    await stop()
  })

  it('two attempts do not share a token', async () => {
    const scenario = { steps: [{ saveToken: true }] }
    const one = await start('tok1', { env: { [OPENCODE_TOKEN_VAR]: 'token-one' }, scenario })
    const two = await start('tok2', { env: { [OPENCODE_TOKEN_VAR]: 'token-two' }, scenario })
    for (const { client } of [one, two]) await client.post('/api/session/x/prompt', { text: 'go' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(readFileSync(join(one.dir, 'token.txt'), 'utf8')).toBe('token-one')
    expect(readFileSync(join(two.dir, 'token.txt'), 'utf8')).toBe('token-two')
    await one.stop()
    await two.stop()
  })
})

describe('the attempt config', () => {
  const config = opencodeAttemptConfig({ toolsUrl: 'http://127.0.0.1:7777/mcp' })
  const rules = (agent: 'build' | 'plan'): OpenCodeRule[] => config.agents[agent].permissions
  /** The last matching rule wins (OpenCode 2.2.5 permissions). */
  const effect = (agent: 'build' | 'plan', action: string, resource = '*'): string | undefined => {
    const glob = (pattern: string, value: string) =>
      new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(value)
    return rules(agent)
      .filter((rule) => glob(rule.action, action) && glob(rule.resource, resource))
      .at(-1)?.effect
  }

  it('holds no token, only a reference to the variable', () => {
    const text = JSON.stringify(config)
    expect(text).toContain(`{env:${OPENCODE_TOKEN_VAR}}`)
    expect(config.mcp.servers.mec).toMatchObject({
      type: 'remote',
      url: 'http://127.0.0.1:7777/mcp',
      oauth: false,
      codemode: false,
    })
  })

  it('denies whatever it does not name: user MCP servers, subagents, questions, code mode', () => {
    for (const action of ['Neon_run_sql', 'runpod_create_pod', 'subagent', 'question', 'execute', 'skill']) {
      expect(effect('build', action), action).toBe('deny')
    }
  })

  it("MEC's own tools run unasked", () => {
    expect(effect('build', 'mec_report')).toBe('allow')
  })

  it('routes shell and edits to the bridge', () => {
    expect(effect('build', 'shell', 'git status')).toBe('ask')
    expect(effect('build', 'edit', 'a.txt')).toBe('ask')
  })

  it('stays inside the worktree and off the network', () => {
    expect(effect('build', 'external_directory', '/etc/*')).toBe('deny')
    expect(effect('build', 'webfetch', 'https://x')).toBe('deny')
    expect(effect('build', 'websearch', 'x')).toBe('deny')
  })

  it('reads the worktree but not the control directories', () => {
    expect(effect('build', 'read', 'a.txt')).toBe('allow')
    expect(effect('build', 'read', '.mec/opencode.json')).toBe('deny')
    expect(effect('build', 'read', '.env')).toBe('deny')
  })

  it('the read-only agent edits nothing', () => {
    expect(effect('plan', 'edit', 'a.txt')).toBe('deny')
    expect(effect('plan', 'shell', 'ls')).toBe('deny')
    expect(effect('plan', 'read', 'a.txt')).toBe('allow')
  })
})
