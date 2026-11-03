import type { AuthHealth, Capabilities } from '@mec/contracts'

/**
 * Capability probe (plan §9 "verify on install"). `run` is injectable: the adapter passes
 * the real spawn; tests pass fakes. No probe ever sends a prompt, and `auth status` is the
 * vendor's own status command — MEC never touches the credential store.
 */

export type ProbeRun = (
  cmd: string,
  args: readonly string[],
  env?: Record<string, string>,
) => Promise<{ code: number; stdout: string; stderr: string }>

export type ClaudeProbeResult = { capabilities: Capabilities; auth: AuthHealth }

/** Flags the adapter relies on; presence is verified against `claude --help` on install. */
export const REQUIRED_FLAGS: readonly string[] = [
  '-p',
  '--verbose',
  '--output-format',
  '--input-format',
  '--session-id',
  '--resume',
  '--settings',
  '--setting-sources',
  '--mcp-config',
  '--strict-mcp-config',
  '--permission-prompt-tool',
  '--permission-prompts',
  '--restricted',
  '--max-turns',
  '--allowedTools',
  '--disallowedTools',
  '--model',
]

export async function probeClaude(run: ProbeRun, env?: Record<string, string>): Promise<ClaudeProbeResult> {
  const version = await run('claude', ['--version'], env)
  const engineVersion = version.stdout.trim().split(' ')[0] || 'unknown'
  const help = await run('claude', ['--help'], env)
  const flagsVerified = REQUIRED_FLAGS.filter((flag) => help.stdout.includes(flag))
  const auth = await run('claude', ['auth', 'status'], env)

  let authHealth: AuthHealth = { logged_in: false, detail: 'status unavailable' }
  try {
    const jsonStart = auth.stdout.indexOf('{')
    if (auth.code === 0 && jsonStart >= 0) {
      const parsed = JSON.parse(auth.stdout.slice(jsonStart)) as Record<string, unknown>
      authHealth = {
        logged_in: parsed.loggedIn === true,
        method: typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined,
        detail: typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : undefined,
      }
    }
  } catch {
    // keep the unavailable default
  }

  return {
    capabilities: {
      engine_version: engineVersion,
      flags_verified: flagsVerified,
      structured_stream: flagsVerified.includes('--output-format'),
      questions: true, // MCP ask_user via mec-tools
      tool_approval: flagsVerified.includes('--permission-prompt-tool'),
      interrupt: true, // process-group signal
      resume: flagsVerified.includes('--resume'),
      usage: true, // result.usage
      rate_limit_events: true, // rate_limit_event in stream-json
      sandbox: true, // --settings sandbox keys (§8.4)
      restricted_mode: flagsVerified.includes('--restricted'),
      mcp_http: flagsVerified.includes('--mcp-config'),
      usage_mode: 'cumulative',
    },
    auth: authHealth,
  }
}
