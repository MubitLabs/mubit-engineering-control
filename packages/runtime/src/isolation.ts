import type { IsolationProfile } from '@mec/contracts'

/**
 * Builds the per-attempt Claude Code `--settings` JSON from an IsolationProfile (plan §8.4).
 * The settings file is a trusted scope the repository cannot override; `--setting-sources user`
 * keeps repo settings out and `--strict-mcp-config` keeps repo `.mcp.json` out (launch flags,
 * not this file). Shims and owned paths are coordination instructions — this file is the
 * engine-enforced part.
 */

/** Read-deny defaults every attempt gets (plan §8.4): MEC state, other slots, secrets. */
export function defaultDenyRead(homeDir: string): string[] {
  const mecRoot = `${homeDir}/.mec`
  return [
    `${mecRoot}/db`,
    `${mecRoot}/policy.yaml`,
    `${mecRoot}/prompts`,
    `${mecRoot}/journal`,
    `${mecRoot}/engines`, // other slot homes (and keystores) live here
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
}

export type AttemptSettings = {
  sandbox: {
    enabled: boolean
    allowUnsandboxedCommands: false
    failIfUnavailable: boolean
    filesystem: { allowWrite: string[]; denyRead: string[] }
    network: { allowedDomains: string[]; strictAllowlist: true }
  }
  disableAllHooks: true
}

export function buildAttemptSettings(profile: IsolationProfile, opts: AttemptSettingsOptions): AttemptSettings {
  const denyRead = [...new Set([...defaultDenyRead(opts.homeDir), ...profile.deny_read])]
  const allowWrite = [...new Set([opts.worktree, opts.tempDir, ...profile.allow_write])]
  const allowedDomains = [...new Set([...opts.allowedDomains, ...profile.allowed_domains])]
  return {
    sandbox: {
      enabled: profile.sandbox !== 'off',
      allowUnsandboxedCommands: false,
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
