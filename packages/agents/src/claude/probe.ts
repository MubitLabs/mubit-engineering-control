import { spawn } from 'node:child_process'
import type { AgentCapability, AgentProbe } from '@mec/contracts'

/** Flags the adapter relies on; each is verified against the installed version (PDF §7). */
export const REQUIRED_FLAGS: Record<string, string[]> = {
  stream: ['--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'],
  mcp: ['--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config'],
  permissionTool: ['--permission-prompt-tool', 'mcp__mec__approve'],
  permissionMode: ['--permission-mode', 'acceptEdits'],
  tools: ['--allowedTools', 'Read', '--disallowedTools', 'WebSearch'],
  resume: ['--resume', '00000000-0000-4000-8000-000000000000'],
  session: ['--session-id', '00000000-0000-4000-8000-000000000001'],
  replay: ['--replay-user-messages'],
  restricted: ['--restricted', '--tools', 'Read'],
}

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

function run(binary: string, args: string[], env: Record<string, string>, timeoutMs = 20_000): Promise<Run> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d) => {
      stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    // Closed stdin with no message: the CLI parses its options and exits without any API call.
    child.stdin.end()
  })
}

const unknownOption = (r: Run) => /unknown option|error: option/i.test(r.stderr + r.stdout)

/**
 * Probes the installed Claude Code: version, native auth health and every flag the adapter needs.
 * Nothing here sends a prompt. Anything unproven is reported unsupported with a note.
 */
export async function probeClaude(
  binary: string,
  env: Record<string, string>,
): Promise<AgentProbe & { flags: Record<string, boolean> }> {
  const version = await run(binary, ['--version'], env)
  const match = /(\d+\.\d+\.\d+)/.exec(version.stdout)
  if (version.code !== 0 || !match) {
    return {
      kind: 'claude-code',
      version: null,
      available: false,
      auth: 'unknown',
      capabilities: [],
      notes: [`claude not runnable: ${(version.stderr || version.stdout).trim().slice(0, 200)}`],
      flags: {},
    }
  }

  const authRun = await run(binary, ['auth', 'status'], env)
  let auth: AgentProbe['auth'] = 'unknown'
  try {
    auth = (JSON.parse(authRun.stdout) as { loggedIn?: boolean }).loggedIn ? 'ok' : 'required'
  } catch {
    auth = 'unknown'
  }

  const flags: Record<string, boolean> = {}
  const combined = Object.entries(REQUIRED_FLAGS)
    .filter(([k]) => k !== 'resume')
    .flatMap(([, args]) => args)
  const all = await run(binary, ['-p', ...combined], env)
  if (!unknownOption(all)) {
    for (const k of Object.keys(REQUIRED_FLAGS)) flags[k] = true
    const resume = await run(binary, ['-p', ...REQUIRED_FLAGS.resume!], env)
    flags.resume = !unknownOption(resume)
  } else {
    for (const [k, args] of Object.entries(REQUIRED_FLAGS))
      flags[k] = !unknownOption(await run(binary, ['-p', ...args], env))
  }

  const capabilities: AgentCapability[] = ['interrupt']
  if (flags.stream) capabilities.push('structured_stream', 'usage')
  if (flags.stream && flags.mcp) capabilities.push('questions')
  if (flags.stream && flags.mcp && flags.permissionTool) capabilities.push('tool_approval')
  if (flags.resume) capabilities.push('native_resume')
  const notes = Object.entries(flags)
    .filter(([, ok]) => !ok)
    .map(([k]) => `unsupported: ${k} (${REQUIRED_FLAGS[k]?.[0]})`)
  if (auth !== 'ok') notes.push('native sign-in required: run `claude` and /login as the runner user')
  return { kind: 'claude-code', version: match[1]!, available: true, auth, capabilities, notes, flags }
}
