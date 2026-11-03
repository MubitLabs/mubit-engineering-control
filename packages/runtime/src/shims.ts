/**
 * Per-attempt command shims and git configuration (plan §8.3): each attempt gets
 * `<worktree>/.mec/bin` first on PATH, containing fail-by-name shims for blocked commands
 * (`mec`, `claude`, `codex`, `opencode`, plus the user's policy CLIs), and a MEC-written
 * `<worktree>/.mec/gitconfig` for the attempt's GIT_CONFIG_GLOBAL. A shim MEC did not
 * write (hash mismatch against the manifest) or a foreign file in binDir refuses the
 * attempt. Honest note from the plan: shims are defaults, not a security boundary.
 */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const DEFAULT_BLOCKED_COMMANDS: readonly string[] = ['mec', 'claude', 'codex', 'opencode']

export type ShimWriteResult = { binDir: string; manifestPath: string }

const MANIFEST_NAME = 'shims-manifest.json'

type Manifest = { blocked: string[]; hashes: Record<string, string> }

function shimScript(name: string): string {
  return ['#!/bin/sh', `echo "${name}: blocked inside a MEC attempt (mec policy)" >&2`, 'exit 127', ''].join(
    '\n',
  )
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function writeShimDir(
  worktree: string,
  blocked: readonly string[] = DEFAULT_BLOCKED_COMMANDS,
): ShimWriteResult {
  const mecDir = join(worktree, '.mec')
  const binDir = join(mecDir, 'bin')
  // Re-writes start from an empty directory: a stale shim from an older blocked list must
  // not survive as a file MEC did not put in this attempt's bin.
  rmSync(binDir, { recursive: true, force: true })
  mkdirSync(binDir, { recursive: true })

  const hashes: Record<string, string> = {}
  for (const name of blocked) {
    const script = shimScript(name)
    writeFileSync(join(binDir, name), script, { mode: 0o755 })
    // writeFileSync only applies mode at creation; re-writes must not keep a stale mode.
    chmodSync(join(binDir, name), 0o755)
    hashes[name] = sha256(script)
  }

  const manifestPath = join(mecDir, MANIFEST_NAME)
  const manifest: Manifest = { blocked: [...blocked].sort(), hashes }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { binDir, manifestPath }
}

// Refuses (returns false, never throws) unless every expected script is present,
// executable, byte-identical to what MEC writes, recorded in the manifest, and no foreign
// file sits in binDir. The file hash is checked against BOTH the manifest and a freshly
// computed canonical script, so a rewritten manifest cannot launder a tampered shim.
export function verifyShimDir(
  binDir: string,
  blocked: readonly string[] = DEFAULT_BLOCKED_COMMANDS,
): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(dirname(binDir), MANIFEST_NAME), 'utf8'),
    ) as Partial<Manifest>
    const expected = [...blocked].sort()

    if (!Array.isArray(manifest.blocked)) return false
    if (JSON.stringify(manifest.blocked) !== JSON.stringify(expected)) return false
    const hashes = manifest.hashes
    if (hashes === undefined) return false

    const present = readdirSync(binDir).sort()
    if (JSON.stringify(present) !== JSON.stringify(expected)) return false

    for (const name of expected) {
      const recorded = hashes[name]
      if (typeof recorded !== 'string') return false
      const scriptPath = join(binDir, name)
      const stats = statSync(scriptPath)
      if (!stats.isFile()) return false
      if ((stats.mode & 0o111) === 0) return false
      if (sha256(readFileSync(scriptPath, 'utf8')) !== recorded) return false
      if (recorded !== sha256(shimScript(name))) return false
    }
    return true
  } catch {
    return false
  }
}

export type GitconfigOptions = { userName: string; userEmail: string; credentialHelper?: string }

// GIT_TERMINAL_PROMPT is an env var, not a config key — it is not written here.
export function writeAttemptGitconfig(worktree: string, opts: GitconfigOptions): string {
  const mecDir = join(worktree, '.mec')
  mkdirSync(mecDir, { recursive: true })

  const lines = ['[user]', `\tname = ${opts.userName}`, `\temail = ${opts.userEmail}`]
  if (opts.credentialHelper !== undefined) {
    lines.push('[credential]', `\thelper = ${opts.credentialHelper}`)
  }

  const configPath = join(mecDir, 'gitconfig')
  writeFileSync(configPath, `${lines.join('\n')}\n`, { mode: 0o600 })
  chmodSync(configPath, 0o600)
  return configPath
}
