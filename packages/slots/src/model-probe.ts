/**
 * Model-availability probe (review 2026-11-04 §3 rule 2: "probe before trust").
 * On slot creation and after every engine upgrade the probe lists what the installed
 * engine actually offers, so table entries can be marked `available`, `unavailable`
 * or `unlisted` per slot. The mapping from probe output to table entries belongs to
 * the caller (it owns the table); this module only reports what the engine listed.
 *
 * Honest scope in v0.1: OpenCode is the one engine with a local, zero-token model
 * catalogue command (`opencode models`). Claude Code and Codex publish no such list —
 * Claude model acceptance is per-`--model` and Codex's catalogue lives behind the
 * app-server's `model/list` — so their entries report `unlisted` until the gated
 * acceptance-probing work lands. Never a guess, never a network probe (plan §5.8).
 */
import { readFileSync } from 'node:fs'
import type { EngineId } from '@mec/contracts'
import type { ProbeRun } from './probes'

export type ModelAvailability = 'available' | 'unavailable' | 'unlisted'

/**
 * What one probe learned: every model the engine LISTED, keyed engine-facing
 * (`provider/model` for OpenCode) and marked `'available'`; models absent from a
 * successful listing are the caller's to mark `'unlisted'`-adjacent `'unavailable'`.
 */
export type ModelProbeReport = {
  engine: EngineId
  /** True only when a listing actually parsed — false means every entry stays `unlisted`. */
  probed: boolean
  /** Models the engine itself listed, as `provider/model` keys. */
  availability: Record<string, ModelAvailability>
  note: string
}

/**
 * The XDG isolation for an OpenCode probe launched against an EXISTING slot home
 * (§5.3): data/config/state/cache under the home, config pointed at the slot's own
 * dir — the probe never reads the user's default OpenCode configuration. Unlike
 * `opencodeHome` this creates nothing; the slot home already exists.
 */
export function opencodeProbeEnv(homeDir: string): Record<string, string> {
  return {
    XDG_DATA_HOME: `${homeDir}/data`,
    XDG_CONFIG_HOME: `${homeDir}/config`,
    XDG_STATE_HOME: `${homeDir}/state`,
    XDG_CACHE_HOME: `${homeDir}/cache`,
    OPENCODE_CONFIG_DIR: `${homeDir}/config`,
  }
}

const PROVIDER_MODEL = /([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._#*-]*)/

/** Accepts the shapes `opencode models` has been seen to print: JSON (bare, `{data:[]}`, `{models:[]}`) or a text table. */
function parseOffered(stdout: string): string[] | undefined {
  const text = stdout.trim()
  if (text === '') return undefined
  const offered: string[] = []
  const addEntry = (entry: unknown): void => {
    if (typeof entry === 'string') {
      offered.push(entry)
      return
    }
    if (typeof entry !== 'object' || entry === null) return
    const record = entry as Record<string, unknown>
    const provider = typeof record.providerID === 'string' ? record.providerID : undefined
    const id = typeof record.id === 'string' ? record.id : undefined
    if (provider !== undefined && id !== undefined && !id.includes('/')) {
      offered.push(`${provider}/${id}`)
      return
    }
    for (const field of ['id', 'model', 'name']) {
      if (typeof record[field] === 'string' && String(record[field]).includes('/')) {
        offered.push(String(record[field]))
        return
      }
    }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    const array = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed !== null
        ? ((parsed as Record<string, unknown>).data ?? (parsed as Record<string, unknown>).models)
        : undefined
    if (Array.isArray(array)) {
      for (const entry of array) addEntry(entry)
      return offered
    }
  } catch {
    // not JSON — the text-table path below
  }
  for (const match of text.matchAll(new RegExp(PROVIDER_MODEL, 'g'))) {
    offered.push(`${match[1]}/${match[2]}`)
  }
  return offered.length > 0 ? offered : undefined
}

/**
 * Probes one engine's model catalogue. Local and zero-token only (§5.8 never-list):
 * `opencode models` under the slot's XDG isolation; claude/codex answer honestly
 * `unlisted` — their acceptance probing is gated future work, not a guess here.
 */
export async function probeModelAvailability(
  run: ProbeRun,
  engine: EngineId,
  opts: { env?: Record<string, string>; configDir?: string } = {},
): Promise<ModelProbeReport> {
  if (engine !== 'opencode') {
    return {
      engine,
      probed: false,
      availability: {},
      note:
        engine === 'claude'
          ? 'claude publishes no model catalogue on the CLI; acceptance probing is gated future work — entries are unlisted'
          : "codex's model catalogue lives behind the app-server model/list; probing is gated future work — entries are unlisted",
    }
  }
  // v0 honest method (review T8 finding): `opencode models --standalone` reads NO config
  // (catalog only), and the managed-service variant collides with the user's ambient
  // opencode service — so a live slot-scoped listing is not reliably probeable. The
  // slot's own opencode.json is the declaration of what it runs: mark its provider/model
  // ids available (config-declared), and say so in the note. Reachability is the
  // launch-time probe's job, not this listing.
  const configDir = opts.configDir ?? opts.env?.XDG_CONFIG_HOME ?? process.env.XDG_CONFIG_HOME ?? ''
  const configPath = configDir === '' ? '' : `${configDir}/opencode/opencode.json`
  let raw = ''
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch {
    return {
      engine,
      probed: false,
      availability: {},
      note: 'no slot opencode.json found — entries are unlisted',
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      engine,
      probed: false,
      availability: {},
      note: 'slot opencode.json is not valid JSON — entries are unlisted',
    }
  }
  const availability: Record<string, 'available'> = {}
  const providers =
    typeof parsed === 'object' && parsed !== null && 'provider' in parsed
      ? (parsed as { provider?: Record<string, { models?: Record<string, unknown> }> }).provider
      : undefined
  for (const [providerId, provider] of Object.entries(providers ?? {})) {
    for (const modelId of Object.keys(provider.models ?? {})) {
      availability[`${providerId}/${modelId}`] = 'available'
    }
  }
  return {
    engine,
    probed: true,
    availability,
    note: 'config-declared availability (the slot opencode.json models); live catalogue probing collides with the ambient opencode service — see T8 notes',
  }
}
