/**
 * Local health probes — plan §5.8. Claude Code only in v0; Codex and OpenCode
 * probes arrive with their adapters (L7/L8).
 *
 * The run function is injectable: production wires it to the supervisor's exec,
 * tests wire it to fixtures. Probes are local and cheap (the vendor's own status
 * command, `--version`); §5.8's never-list applies — no periodic network probes
 * against quota-metered plans, no probe that burns subscription usage, no probe
 * that needs a vendor OAuth token outside the vendor CLI.
 */
import type { Degraded } from '@mec/contracts'

export type ProbeRun = (
  cmd: string,
  args: readonly string[],
  env?: Record<string, string>,
) => Promise<{ code: number; stdout: string; stderr: string }>

export type ProbeResult = {
  state: 'healthy' | 'degraded'
  reason?: Degraded
  identity?: { email?: string; plan?: string }
}

/**
 * `claude auth status` — the vendor's own check; it may refresh the token, which
 * is the vendor CLI's call, never ours (§5.4). `loggedIn` true reports healthy
 * with the non-secret identity the command returns; anything else — logged out,
 * expired, unreadable — is `degraded`/`auth_expired`: a probe that cannot confirm
 * the login never reports health by default.
 */
export async function probeClaudeSlot(run: ProbeRun, env: Record<string, string>): Promise<ProbeResult> {
  let result: Awaited<ReturnType<ProbeRun>>
  try {
    result = await run('claude', ['auth', 'status'], env)
  } catch {
    // The binary itself is missing (spawn ENOENT &c.) — §5.5's engine_missing.
    return { state: 'degraded', reason: 'engine_missing' }
  }
  const status = parseJson(result.stdout)
  if (status?.loggedIn === true) {
    const identity: { email?: string; plan?: string } = {}
    if (typeof status.email === 'string' && status.email !== '') identity.email = status.email
    if (typeof status.subscriptionType === 'string' && status.subscriptionType !== '') {
      identity.plan = status.subscriptionType
    }
    return Object.keys(identity).length > 0 ? { state: 'healthy', identity } : { state: 'healthy' }
  }
  return { state: 'degraded', reason: 'auth_expired' }
}

/** `claude --version` — the first stdout token, or `engine_missing` when the binary is absent. */
export async function probeEngineVersion(
  run: ProbeRun,
  env: Record<string, string>,
): Promise<string | 'engine_missing'> {
  let result: Awaited<ReturnType<ProbeRun>>
  try {
    result = await run('claude', ['--version'], env)
  } catch {
    return 'engine_missing'
  }
  if (result.code !== 0) return 'engine_missing'
  const first = result.stdout.trim().split(/\s+/)[0]
  return first === undefined || first === '' ? 'engine_missing' : first
}

/**
 * §5.8 zero-token validity probes for API-key slots (R2.2): one GET against the
 * provider's own models endpoint — no generation, no quota. The run function is
 * injectable (production: the global fetch with an AbortController timeout;
 * tests: a stub). Contract, same for every provider: 200 → healthy; 401/403 →
 * key_rejected; anything else (network error, 5xx, timeout) → provider_unreachable
 * — an unreachable provider says nothing about the key (§5.8).
 */
export type ApiKeyProbeOutcome = 'healthy' | 'key_rejected' | 'provider_unreachable'

/** The keystore provider ids (§5.4) and their zero-token probe targets. */
export const API_KEY_PROBE_TARGETS: Record<
  'anthropic-api' | 'zai-coding-plan' | 'google-gemini',
  { url: string; headers: (key: string) => Record<string, string>; label: string }
> = {
  'anthropic-api': {
    url: 'https://api.anthropic.com/v1/models',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    label: 'anthropic:/v1/models',
  },
  'zai-coding-plan': {
    // The CODING endpoint — the one that bills the Coding Plan quota (R2.2).
    url: 'https://api.z.ai/api/coding/paas/v4/models',
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    label: 'zai-coding:/coding/paas/v4/models',
  },
  'google-gemini': {
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    headers: (key) => ({ 'x-goog-api-key': key }),
    label: 'google-gemini:/v1beta/models',
  },
}

export async function probeApiKeySlot(
  fetchImpl: typeof globalThis.fetch,
  provider: keyof typeof API_KEY_PROBE_TARGETS,
  key: string,
  timeoutMs = 15_000,
): Promise<ApiKeyProbeOutcome> {
  const target = API_KEY_PROBE_TARGETS[provider]
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref()
  try {
    const res = await fetchImpl(target.url, { headers: target.headers(key), signal: controller.signal })
    if (res.ok) return 'healthy'
    // 401/403 is the only verdict about the KEY; other statuses (429, 5xx, …)
    // say nothing the §5.8 contract can bank on.
    return res.status === 401 || res.status === 403 ? 'key_rejected' : 'provider_unreachable'
  } catch {
    return 'provider_unreachable'
  } finally {
    clearTimeout(timer)
  }
}

/** JSON.parse with a one-retry brace slice, so a leading banner line does not defeat the probe. */
function parseJson(stdout: string): Record<string, unknown> | undefined {
  const text = stdout.trim()
  if (text === '') return undefined
  const attempt = (candidate: string): Record<string, unknown> | undefined => {
    try {
      const parsed: unknown = JSON.parse(candidate)
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }
  const direct = attempt(text)
  if (direct !== undefined) return direct
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first === -1 || last <= first) return undefined
  return attempt(text.slice(first, last + 1))
}
