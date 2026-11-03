/**
 * Credential homes — plan §5.3.
 *
 * Every slot gets an isolated home the engine itself treats as "its" configuration
 * directory. MEC creates the directory, sets the engine's home variable(s) for every
 * process it launches for that slot, and never writes into the user's default home.
 *
 * Slot 0 ("link existing") is different: `linkedDefault` points at the engine's
 * default home instead of a slot dir. Only Claude Code has one in v0, and it runs
 * with `CLAUDE_CONFIG_DIR` *absent*, not set to `~/.claude`: setting the variable
 * explicitly selects a different macOS Keychain item than leaving it unset
 * (issue #92252), so a linked default must run the way an interactive `claude` does.
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type EngineHome = {
  engine: 'claude' | 'codex' | 'opencode'
  /** The directory callers should treat as the slot's home (`Slot.home`). */
  homeDir: string
  /** The env vars merged into every process launched for this slot (§5.12 slot layer). */
  env: Record<string, string>
}

/** Slot names become path segments; anything that could escape the slot root is refused. */
const SLOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function slotDir(root: string, engine: 'claude' | 'codex' | 'opencode', slot: string): string {
  if (slot === '' || slot === '..' || !SLOT_NAME.test(slot)) {
    throw new Error(`invalid slot name '${slot}': expected a single path segment`)
  }
  const dir = join(root, 'engines', engine, slot)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function claudeHome(root: string, slot: string): EngineHome {
  const homeDir = slotDir(root, 'claude', slot)
  return { engine: 'claude', homeDir, env: { CLAUDE_CONFIG_DIR: homeDir } }
}

export function codexHome(root: string, slot: string): EngineHome {
  // Codex refuses to launch when CODEX_HOME does not exist (§5.3 "must exist before
  // launch"), so the directory is created eagerly here — 0o700, like every slot dir.
  const homeDir = slotDir(root, 'codex', slot)
  return { engine: 'codex', homeDir, env: { CODEX_HOME: homeDir } }
}

export function opencodeHome(root: string, slot: string): EngineHome {
  const homeDir = slotDir(root, 'opencode', slot)
  const xdgDirs = {
    XDG_DATA_HOME: 'data',
    XDG_CONFIG_HOME: 'config',
    XDG_STATE_HOME: 'state',
    XDG_CACHE_HOME: 'cache',
  } as const
  const env: Record<string, string> = {}
  let configDir = ''
  for (const name of Object.keys(xdgDirs) as (keyof typeof xdgDirs)[]) {
    const dir = join(homeDir, xdgDirs[name])
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    env[name] = dir
    if (name === 'XDG_CONFIG_HOME') configDir = dir
  }
  // §5.3: OPENCODE_CONFIG_DIR (and the later OPENCODE_CONFIG file) point the V2
  // binary at the slot's config, away from user- and repo-level configuration.
  env.OPENCODE_CONFIG_DIR = configDir
  return { engine: 'opencode', homeDir, env }
}

export function linkedDefault(engine: EngineHome['engine']): EngineHome | null {
  if (engine === 'claude') {
    // Env stays EMPTY — see the module comment (issue #92252): the linked default
    // runs exactly like an interactive claude, with the variable unset.
    return { engine: 'claude', homeDir: join(homedir(), '.claude'), env: {} }
  }
  // v0 links only Claude Code; codex (~/.codex) and opencode (user XDG dirs)
  // arrive with their adapters (L7/L8).
  return null
}
