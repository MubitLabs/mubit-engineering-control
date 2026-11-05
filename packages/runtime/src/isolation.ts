import type { IsolationProfile } from '@mec/contracts'

/**
 * Builds the per-attempt Claude Code `--settings` JSON from an IsolationProfile (plan §8.4).
 * The settings file is a trusted scope the repository cannot override; `--setting-sources user`
 * keeps repo settings out and `--strict-mcp-config` keeps repo `.mcp.json` out (launch flags,
 * not this file). Shims and owned paths are coordination instructions — this file is the
 * engine-enforced part.
 */

/**
 * Read-deny defaults every attempt gets (plan §8.4): MEC state, other slots, secrets. The list
 * names what is in the data dir instead of denying it whole: the worktree sits under
 * `<dataDir>/work` and its `.git` file points into `<dataDir>/repos`. `~/.claude` and `~/.codex`
 * bind the attempt's shell, not the engine, which runs outside its own Bash sandbox.
 */
export function defaultDenyRead(homeDir: string, dataDir = `${homeDir}/.mec`): string[] {
  return [
    `${dataDir}/mec.db`,
    `${dataDir}/mec.db-wal`,
    `${dataDir}/mec.db-shm`,
    `${dataDir}/mec.db-journal`,
    `${dataDir}/health.json`,
    `${dataDir}/policy.yaml`,
    `${dataDir}/prompts`,
    `${dataDir}/journal`,
    `${dataDir}/engines`, // other slot homes (and keystores) live here
    `${homeDir}/.claude`,
    `${homeDir}/.codex`,
    `${homeDir}/.ssh`,
    `${homeDir}/.aws`,
    `${homeDir}/.config/gh`,
  ]
}

export type AttemptSettingsOptions = {
  /** The attempt's worktree — always writable. */
  worktree: string
  /** The attempt's scratch/temp directory — always writable. */
  tempDir: string
  /** Registry domains the repository's bootstrap profile names (npm, pip, …). */
  allowedDomains: readonly string[]
  /** User home, for the deny-list defaults. */
  homeDir: string
  /** MEC's data dir, when it is not `~/.mec`: a scratch server's state is denied where it is. */
  dataDir?: string
}

export type AttemptSettings = {
  sandbox: {
    enabled: boolean
    allowUnsandboxedCommands: false
    autoAllowBashIfSandboxed: false
    failIfUnavailable: boolean
    filesystem: { allowWrite: string[]; denyRead: string[] }
    network: { allowedDomains: string[]; strictAllowlist: true }
  }
  disableAllHooks: true
}

export function buildAttemptSettings(
  profile: IsolationProfile,
  opts: AttemptSettingsOptions,
): AttemptSettings {
  const denyRead = [...new Set([...defaultDenyRead(opts.homeDir, opts.dataDir), ...profile.deny_read])]
  const allowWrite = [...new Set([opts.worktree, opts.tempDir, ...profile.allow_write])]
  const allowedDomains = [...new Set([...opts.allowedDomains, ...profile.allowed_domains])]
  return {
    sandbox: {
      enabled: profile.sandbox !== 'off',
      allowUnsandboxedCommands: false,
      // The engine's default skips the permission tool for a sandboxed command, and the
      // bridge is where `git push` is refused.
      autoAllowBashIfSandboxed: false,
      failIfUnavailable: profile.sandbox === 'required',
      filesystem: { allowWrite, denyRead },
      network: { allowedDomains, strictAllowlist: true },
    },
    disableAllHooks: true,
  }
}

/** Serialise for `--settings <file>`: stable key order, no secrets (paths and domains only). */
export function serialiseAttemptSettings(settings: AttemptSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`
}
