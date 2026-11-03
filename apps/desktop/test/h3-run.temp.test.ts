import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ClaudeAdapter } from '@mec/engines'
import { RepoCache, Worktrees, commitAll, headSha } from '@mec/git'
import { runCheck } from '@mec/runtime'
import { buildAttemptSettings, serialiseAttemptSettings, buildAgentEnv } from '@mec/runtime'
import { MecToolsServer, issueToken } from '@mec/mec-tools'

const ROOT = mkdtempSync(join(tmpdir(), 'mec-h3-'))
const REPO = 'MubitLabs/mec-sandbox'

it('H3 stages 1-4: real implementer on the sandbox, checks, integration merge', async () => {
  // 1. bare clone + worktree on the pinned base
  const cache = RepoCache.open(join(ROOT, 'repos'))
  const { gitDir } = await cache.ensure('https://github.com/MubitLabs/mec-sandbox.git')
  const base = execFileSync('git', ['-C', gitDir, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim()
  const worktree = join(ROOT, 'work', 'att_impl')
  const wt = new Worktrees(gitDir)
  await wt.add({ path: worktree, branch: 'mec/h3/farewell/a1', baseSha: base, createBranch: true })
  console.log('BASE:', base)

  // 2. the real implementer: add farewell.js + test (H1-proven machinery)
  const tools = new MecToolsServer({
    secret: 'h3-secret',
    bridge: { request: async () => 'allow' },
    onCall: async (_c, t, a) => (t === 'confirm' ? { behavior: 'allow', updatedInput: (a as { tool_input?: unknown }).tool_input } : { ok: true }),
  })
  const { url } = await tools.start()
  const token = issueToken({ attemptId: 'att_h3_impl', generation: 1, role: 'specialist', secret: 'h3-secret' })
  mkdirSync(join(worktree, '.mec'), { recursive: true })
  writeFileSync(join(worktree, '.mec/claude-settings.json'), serialiseAttemptSettings(buildAttemptSettings(
    { sandbox: 'required', read_only: false, allow_write: [], deny_read: [], allowed_domains: [], blocked_commands: [], background_cap_ms: 30 * 60_000, permission_mode: 'bridge', repo_trusted: false },
    { worktree, tempDir: join(ROOT, 'tmp'), allowedDomains: ['claude.ai', 'api.claude.com', 'registry.npmjs.org'], homeDir: process.env.HOME ?? '/tmp' },
  )))
  writeFileSync(join(worktree, '.mec/mcp.json'), JSON.stringify({ mcpServers: { mec: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }))
  const env = buildAgentEnv({
    inherited: process.env as Record<string, string | undefined>,
    home: process.env.HOME ?? '/tmp',
    slot: { CLAUDE_CONFIG_DIR: join(process.env.HOME ?? '', '.mec/engines/claude/preflight-a') },
    attempt: {
      MEC_ATTEMPT_ID: 'att_h3_impl', MEC_WORKTREE: worktree, MEC_TOOLS_URL: url, MEC_TOOLS_TOKEN: token,
      MEC_SETTINGS_PATH: join(worktree, '.mec/claude-settings.json'), MEC_MCP_CONFIG_PATH: join(worktree, '.mec/mcp.json'),
      GIT_TERMINAL_PROMPT: '0',
    },
  })
  const adapter = new ClaudeAdapter()
  const handle = await adapter.launch({
    brief: {
      attempt_id: 'att_h3_impl', generation: 1, task_id: 'task_h3', work_item_id: 'wi_h3',
      role: { name: 'implementer', revision: 'r0' }, engine: 'claude', slot_id: 'slot_h3',
      worktree, base_sha: base, branch: 'mec/h3/farewell/a1',
      origin: { messages: [{ id: 'msg_h3', text: 'Add a farewell feature' }] },
      objective: 'Create farewell.js exporting farewell(name) that returns "Goodbye, <name>!" (mirroring greet), and farewell.test.js with node:test cases covering a name and an empty refusal. Then run npm test with the Bash tool and report the result.',
      owned_paths: [], acceptance_checks: [], budget: { turns: 8, wall_clock_ms: 240_000 },
      bundle_revision: 'r0',
      tools: { url, token },
      env: { MEC_SETTINGS_PATH: join(worktree, '.mec/claude-settings.json'), MEC_MCP_CONFIG_PATH: join(worktree, '.mec/mcp.json'), MEC_ALLOWED_TOOLS: 'mcp__mec__*' },
      isolation: { sandbox: 'required', read_only: false, allow_write: [], deny_read: [], allowed_domains: [], blocked_commands: [], background_cap_ms: 30 * 60_000, permission_mode: 'bridge', repo_trusted: false },
    },
    env, cwd: worktree, bridge: { request: async () => 'allow' },
  })
  const events: unknown[] = []
  for await (const e of adapter.events(handle)) events.push(e as never)
  const exit = events.at(-1) as { terminal_reason: string }
  console.log('IMPLEMENTER exit:', exit.terminal_reason)
  expect(exit.terminal_reason).toBe('completed')
  expect(readFileSync(join(worktree, 'farewell.js'), 'utf8')).toContain('Goodbye')

  // 3. commit + acceptance checks on the exact head SHA
  const head = await commitAll(worktree, 'h3: add farewell feature', { name: 'mec-h3', email: 'h3@mec' })
  console.log('HEAD:', head)
  const check = await runCheck({ name: 'npm-test', cmd: 'npm', args: ['test'], cwd: worktree, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, timeoutMs: 60_000 })
  console.log('CHECK on head:', check.status, 'exit', check.exitCode)
  expect(check.status).toBe('passed')

  // 4. integration merge on the exact merge SHA + checks there
  const { mergeIntoIntegration } = await import('@mec/git')
  const intWt = join(ROOT, 'work', 'integration')
  await wt.add({ path: intWt, branch: 'mec/h3/integration', baseSha: base, createBranch: true })
  const merge = await mergeIntoIntegration({ gitDir, worktree: intWt, taskBranch: 'mec/h3/farewell/a1', message: 'h3: integrate farewell' })
  console.log('MERGE:', JSON.stringify(merge).slice(0, 120))
  expect(merge.outcome).toBe('merged')
  const intCheck = await runCheck({ name: 'npm-test-int', cmd: 'npm', args: ['test'], cwd: intWt, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, timeoutMs: 60_000 })
  console.log('CHECK on merge SHA:', intCheck.status)
  expect(intCheck.status).toBe('passed')
  writeFileSync(join(ROOT, 'state.json'), JSON.stringify({ gitDir, worktree: intWt, branch: 'mec/h3/integration', mergeSha: merge.mergeSha, base }))
  await tools.stop()
}, 420_000)
