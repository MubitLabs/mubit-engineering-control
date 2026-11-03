/**
 * Agent environment construction — plan §5.12.
 *
 * Every engine process gets an environment built from scratch. The inherited
 * allowlist IS the scrub: only the names in INHERITED_ALLOWLIST and the
 * prefixes in INHERITED_PREFIXES survive from the user's shell, so a
 * subscription slot can never inherit ANTHROPIC_API_KEY, a GitHub token or
 * any KEY/PASSWORD/SECRET/TOKEN variable — those names are simply not on the
 * list. On top of the survivors MEC applies the slot layer (engine home
 * variables — MEC-provided, validated) and then the attempt layer (MEC_*,
 * git hygiene, caller extras — validated).
 */
import { isSecretEnvName, matchesSecret } from '@mec/contracts'

/**
 * Exact inherited names (§5.12). `PATH` and `HOME` are allowlisted but never
 * copied verbatim: PATH is rebuilt with the attempt's shim directory first,
 * and HOME comes from the slot's work context (`AgentEnvInput.home`), not the
 * user's shell. The lowercase proxy forms arrive via INHERITED_PREFIXES.
 */
export const INHERITED_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'TERM',
  'TMPDIR',
  'SSH_AUTH_SOCK',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'XDG_RUNTIME_DIR',
]

/** Inherited name prefixes (§5.12: `LC_*` and the lowercase proxy forms), matched case-insensitively. */
export const INHERITED_PREFIXES: readonly string[] = ['LC_', 'http_proxy', 'https_proxy', 'no_proxy']

/** A slot/attempt layer was refused: a secret-shaped variable name, or a secret-shaped value. */
export class EnvValidationError extends Error {}

export type AgentEnvInput = {
  inherited: Record<string, string | undefined>
  /** The HOME value to set: the slot's work context, never the user's. */
  home: string
  /** A shim directory prepended to PATH (§8). */
  shimPath?: string
  /** Slot layer: engine home variables etc. — MEC-provided, validated. */
  slot?: Record<string, string>
  /** Attempt layer: MEC_*, git hygiene, plus caller extras — validated. */
  attempt: Record<string, string>
}

/**
 * The one §5.12-sanctioned secret in the attempt layer: the attempt-scoped
 * mec-tools bearer token. It never travels in a brief, only in the process
 * env — and even its VALUE is still checked against matchesSecret.
 */
const SANCTIONED_ATTEMPT_SECRET = 'MEC_TOOLS_TOKEN'

type Layer = 'slot' | 'attempt'

const isAllowedInheritedName = (name: string): boolean =>
  INHERITED_ALLOWLIST.includes(name) ||
  INHERITED_PREFIXES.some((prefix) => name.toLowerCase().startsWith(prefix.toLowerCase()))

const applyLayer = (env: Record<string, string>, layer: Layer, vars: Record<string, string>): void => {
  for (const [name, value] of Object.entries(vars)) {
    const sanctioned = layer === 'attempt' && name === SANCTIONED_ATTEMPT_SECRET
    if (isSecretEnvName(name) && !sanctioned) {
      throw new EnvValidationError(`${layer} layer: refusing secret-shaped variable name '${name}'`)
    }
    if (matchesSecret(value)) {
      throw new EnvValidationError(`${layer} layer: refusing secret-shaped value for variable '${name}'`)
    }
    env[name] = value
  }
}

export function buildAgentEnv(input: AgentEnvInput): Record<string, string> {
  // 1. Start empty; copy only allowlisted inherited names that have a value.
  // Everything else — every KEY/PASSWORD/SECRET/TOKEN, vendor and XDG home —
  // is dropped silently: not being on the allowlist is the scrub.
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.inherited)) {
    if (value === undefined || value === '') continue
    if (name === 'PATH' || name === 'HOME') continue // rebuilt below, never inherited verbatim
    if (!isAllowedInheritedName(name)) continue
    env[name] = value
  }

  // 2. HOME is the slot's work context; PATH gets the shim directory first.
  env.HOME = input.home
  const inheritedPath = input.inherited.PATH
  const path = [
    ...(input.shimPath ? [input.shimPath] : []),
    ...(typeof inheritedPath === 'string' && inheritedPath !== '' ? [inheritedPath] : []),
  ].join(':')
  if (path !== '') env.PATH = path

  // 3. Slot layer first, then attempt layer. The attempt layer wins on any
  // collision — a slot variable may not override an attempt variable; it is
  // simply overwritten here (§5.12 layer order).
  if (input.slot) applyLayer(env, 'slot', input.slot)
  applyLayer(env, 'attempt', input.attempt)

  return env
}
