import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EngineEvent } from '@mec/contracts'
import { ClaudeAdapter } from '@mec/engines'
import { commitAll, git, headSha, RepoCache, Worktrees } from '@mec/git'
import { issueToken, MecToolsServer } from '@mec/mec-tools'
import {
  AttemptJournal,
  buildAgentEnv,
  buildAttemptSettings,
  defaultDenyRead,
  runCheck,
  serialiseAttemptSettings,
} from '@mec/runtime'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * H1 — the real-binary canary (implementation plan Appendix B; R1.2).
 * Runs ONLY with MEC_REAL_ENGINE=1 and a logged-in dedicated slot:
 *   MEC_REAL_ENGINE=1 MEC_H1_SLOT=~/.mec/engines/claude/preflight-a pnpm exec vitest run apps/desktop/test/h1.real.test.ts
 * Each stage is one tiny real `claude` run (cents of vendor-accounted usage).
 * This file is the §7.1 real-engine canary: run at every handshake and on every
 * pinned engine version change.
 */
const REAL = process.env.MEC_REAL_ENGINE === '1'
const SLOT = process.env.MEC_H1_SLOT ?? join(process.env.HOME ?? '', '.mec/engines/claude/preflight-a')

describe.skipIf(!REAL)('H1: real Claude binary through the real stack', () => {
  const root = mkdtempSync(join(tmpdir(), 'mec-h1-'))
  const confirmCalls: { tool: string; args: unknown }[] = []
  let tools: MecToolsServer
  let token: string

  afterAll(async () => {
    await tools?.stop()
    rmSync(root, { recursive: true, force: true })
  })

  async function startTools(): Promise<void> {
    tools = new MecToolsServer({
      secret: 'h1-canary-secret',
      bridge: {
        request: async () => 'allow' as const,
      },
      onCall: async (_ctx, tool, args) => {
        confirmCalls.push({ tool, args })
        if (tool === 'confirm') {
          // Claude Code's permission-prompt-tool response shape (§9).
          return { behavior: 'allow', updatedInput: (args as { tool_input?: unknown }).tool_input }
        }
        return { ok: true }
      },
    })
    const { url } = await tools.start()
    token = issueToken({ attemptId: 'att_h1', generation: 1, role: 'specialist', secret: 'h1-canary-secret' })
    globalThis.__h1ToolsUrl = url
  }

  function buildEnv(worktree: string): Record<string, string> {
    return buildAgentEnv({
      inherited: process.env as Record<string, string | undefined>,
      home: process.env.HOME ?? '/tmp',
      slot: { CLAUDE_CONFIG_DIR: SLOT },
      attempt: {
        MEC_ATTEMPT_ID: 'att_h1',
        MEC_WORKTREE: worktree,
        MEC_TOOLS_URL: String(globalThis.__h1ToolsUrl),
        MEC_TOOLS_TOKEN: token,
        MEC_SETTINGS_PATH: join(worktree, '.mec/claude-settings.json'),
        MEC_MCP_CONFIG_PATH: join(worktree, '.mec/mcp.json'),
        GIT_CONFIG_GLOBAL: join(worktree, '.mec/gitconfig'),
        GIT_TERMINAL_PROMPT: '0',
      },
    })
  }

  function writeEngineConfig(worktree: string, allowedDomains: string[]): void {
    mkdirSync(join(worktree, '.mec'), { recursive: true })
    const settings = buildAttemptSettings(
      {
        sandbox: 'required',
        read_only: false,
        allow_write: [],
        deny_read: [],
        allowed_domains: [],
        blocked_commands: [],
        background_cap_ms: 30 * 60_000,
        permission_mode: 'bridge',
        repo_trusted: false,
      },
      {
        worktree,
        tempDir: join(root, 'tmp'),
        allowedDomains,
        homeDir: process.env.HOME ?? '/tmp',
      },
    )
    writeFileSync(join(worktree, '.mec/claude-settings.json'), serialiseAttemptSettings(settings))
    writeFileSync(
      join(worktree, '.mec/mcp.json'),
      `${JSON.stringify(
        {
          mcpServers: {
            mec: {
              type: 'http',
              url: `${globalThis.__h1ToolsUrl}`,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
        null,
        2,
      )}\n`,
    )
  }

  async function runReal(
    prompt: string,
    worktree: string,
    opts: { readOnly?: boolean } = {},
  ): Promise<{ events: EngineEvent[]; raw: string[]; text: string }> {
    const adapter = new ClaudeAdapter()
    writeEngineConfig(worktree, ['claude.ai', 'api.claude.com'])
    const handle = await adapter.launch({
      brief: {
        attempt_id: 'att_h1',
        generation: 1,
        task_id: 'task_h1',
        work_item_id: 'wi_h1',
        role: { name: opts.readOnly ? 'code_reviewer' : 'implementer', revision: 'r0' },
        engine: 'claude',
        slot_id: 'slot_h1',
        worktree,
        base_sha: '0'.repeat(40),
        branch: 'mec/h1',
        origin: { messages: [] },
        objective: prompt,
        owned_paths: [],
        acceptance_checks: [],
        budget: { turns: 4, wall_clock_ms: 120_000 },
        bundle_revision: 'r0',
        tools: { url: 'http://127.0.0.1:1', token: 't' },
        env: {
          MEC_SETTINGS_PATH: join(worktree, '.mec/claude-settings.json'),
          MEC_MCP_CONFIG_PATH: join(worktree, '.mec/mcp.json'),
        },
        isolation: {
          sandbox: 'required',
          read_only: opts.readOnly ?? false,
          allow_write: [],
          deny_read: [],
          allowed_domains: [],
          blocked_commands: [],
          background_cap_ms: 30 * 60_000,
          permission_mode: 'bridge',
          repo_trusted: false,
        },
      },
      env: buildEnv(worktree),
      cwd: worktree,
      bridge: { request: async () => 'allow' },
    })
    const events: EngineEvent[] = []
    for await (const event of adapter.events(handle)) events.push(event)
    await adapter.stop(handle)
    const text = events.find((e) => e.type === 'message' && e.role === 'assistant')
    return { events, raw: [], text: text && text.type === 'message' ? text.text : '' }
  }

  it('stage 0: fixture repo, pinned base, tools server', async () => {
    // fixture repository + bare clone cache + worktree on the pinned base
    const src = join(root, 'fixture-repo')
    mkdirSync(src, { recursive: true })
    execFileSync('git', ['init', '-q', '.'], { cwd: src })
    writeFileSync(join(src, 'README.md'), '# h1 fixture\n')
    execFileSync('git', ['add', '.'], { cwd: src })
    execFileSync('git', ['-c', 'user.email=h1@mec', '-c', 'user.name=h1', 'commit', '-qm', 'init'], {
      cwd: src,
    })
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: src }).toString().trim()

    const cache = RepoCache.open(join(root, 'repos'))
    const { gitDir } = await cache.ensure(`file://${src}`)
    const worktrees = new Worktrees(gitDir)
    const worktree = join(root, 'work', 'att_h1')
    await worktrees.add({ path: worktree, branch: 'mec/h1/a1', baseSha: base, createBranch: true })
    expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toContain('h1 fixture')
    expect((await headSha(worktree)).length).toBe(40)

    await startTools()
    expect(String(globalThis.__h1ToolsUrl)).toMatch(/^http:\/\/127\.0\.0\.1:\d+(\/mcp)?$/)
  }, 60_000)

  it('stage A: a real attempt end to end (message, rate_limit, usage, exit; journal + park check)', async () => {
    const worktree = join(root, 'work', 'att_h1')
    const { events, text } = await runReal('Reply with exactly: H1-OK. Do not use any tools.', worktree)
    expect(text).toContain('H1-OK')
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('session_started')
    expect(types.at(-1)).toBe('exit')
    const exit = events.at(-1)
    expect(exit && exit.type === 'exit' ? exit.terminal_reason : '').toBe('completed')
    // the real quota signal was observed live (§5.9)
    expect(types).toContain('rate_limit')
    expect(types).toContain('usage')
    // journal: redacted durable record of the real stream
    const journal = AttemptJournal.open(join(root, 'journal', 'att_h1'), 'create')
    for (const event of events) journal.append({ ...event } as never)
    expect(journal.lastSeq()).toBe(events.length)
    // no park from an allowed reading
    const { parkFromEvents } = await import('@mec/runtime')
    const park = parkFromEvents(events.map((e) => ({ ...e })) as never)
    expect(park.park).toBe(false)
    // the deny list never appeared in any text the engine saw or produced
    const allText = JSON.stringify(events)
    for (const denied of defaultDenyRead(process.env.HOME ?? '/tmp')) {
      expect(allText).not.toContain(denied)
    }
  }, 240_000)

  it('stage B: the sandbox denies reading ~/.ssh from inside the attempt', async () => {
    const worktree = join(root, 'work', 'att_h1')
    const { events, text } = await runReal(
      'Use the Bash tool to run exactly: cat ~/.ssh/config — then reply DONE either way. Do not try other paths.',
      worktree,
    )
    const toolCalls = events.filter((e) => e.type === 'tool_call')
    const failed = toolCalls.some(
      (e) =>
        e.type === 'tool_call' &&
        (e.ok === false || JSON.stringify(e.output ?? '').includes('Operation not permitted')),
    )
    const sshContent = existsSync(join(process.env.HOME ?? '', '.ssh/config'))
      ? readFileSync(join(process.env.HOME ?? '', '.ssh/config'), 'utf8').slice(0, 40)
      : null
    const leaked = sshContent !== null && JSON.stringify(events).includes(sshContent)
    // Pass: the read was blocked (failed tool call or no content), never leaked.
    expect(leaked).toBe(false)
    expect(failed || toolCalls.length === 0 || text.includes('DONE')).toBe(true)
  }, 240_000)

  it('stage C: a permission request round-trips through mcp__mec__confirm and the file lands', async () => {
    const worktree = join(root, 'work', 'att_h1')
    const before = confirmCalls.length
    const { text } = await runReal(
      'Use the Bash tool to run exactly: touch bridge.txt — then create a file named h1.txt in the current directory containing exactly: hello-from-h1',
      worktree,
    )
    expect(existsSync(join(worktree, 'bridge.txt'))).toBe(true)
    expect(existsSync(join(worktree, 'h1.txt'))).toBe(true)
    expect(readFileSync(join(worktree, 'h1.txt'), 'utf8')).toBe('hello-from-h1')
    // the engine asked through OUR server (the bridge round trip, §3/§9)
    expect(confirmCalls.length).toBeGreaterThan(before)
    expect(text.length).toBeGreaterThan(0)
  }, 240_000)

  it('stage D: commit on the worktree and run the acceptance check on the head SHA', async () => {
    const worktree = join(root, 'work', 'att_h1')
    const sha = await commitAll(worktree, 'h1: add h1.txt', { name: 'mec-h1', email: 'h1@mec' })
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    const outcome = await runCheck({
      name: 'h1-file',
      cmd: 'test',
      args: ['-f', 'h1.txt'],
      cwd: worktree,
      env: {},
    })
    expect(outcome.status).toBe('passed')
    expect(outcome.exitCode).toBe(0)
  }, 60_000)
})

declare global {
  // eslint-disable-next-line no-var
  var __h1ToolsUrl: string | undefined
}
