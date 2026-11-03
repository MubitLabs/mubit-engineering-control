// Plan §8.3 shim hygiene: fail-by-name scripts for blocked commands, a manifest that
// refuses anything MEC did not write (hash mismatch, foreign file, missing exec bit), and
// the per-attempt gitconfig for GIT_CONFIG_GLOBAL.
import { execFile } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_BLOCKED_COMMANDS, verifyShimDir, writeAttemptGitconfig, writeShimDir } from '../src/shims'

const workdir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'mec-shims-'))
afterAll(() => {
  rmSync(workdir, { recursive: true, force: true })
})

describe('writeShimDir / verifyShimDir', () => {
  it('writes the default shims, a sorted manifest, and verifies clean', () => {
    const worktree = join(workdir, 'default')
    const { binDir, manifestPath } = writeShimDir(worktree)
    expect(binDir).toBe(join(worktree, '.mec', 'bin'))
    expect(manifestPath).toBe(join(worktree, '.mec', 'shims-manifest.json'))
    expect(verifyShimDir(binDir)).toBe(true)

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(manifest.blocked).toEqual([...DEFAULT_BLOCKED_COMMANDS].sort())
    for (const name of DEFAULT_BLOCKED_COMMANDS) {
      expect(typeof manifest.hashes[name]).toBe('string')
      expect(statSync(join(binDir, name)).mode & 0o777).toBe(0o755)
    }
  })

  it('verifies regardless of the blocked list order it was given', () => {
    const worktree = join(workdir, 'order')
    const { binDir } = writeShimDir(worktree, ['zzz', 'aaa'])
    const manifest = JSON.parse(readFileSync(join(worktree, '.mec', 'shims-manifest.json'), 'utf8'))
    expect(manifest.blocked).toEqual(['aaa', 'zzz'])
    expect(verifyShimDir(binDir, ['zzz', 'aaa'])).toBe(true)
    expect(verifyShimDir(binDir, ['aaa', 'zzz'])).toBe(true)
  })

  it('overwrites cleanly on re-write', () => {
    const worktree = join(workdir, 'rewrite')
    writeShimDir(worktree, ['mec', 'extra'])
    const { binDir } = writeShimDir(worktree, ['mec'])
    expect(verifyShimDir(binDir, ['mec'])).toBe(true)
    expect(existsSync(join(binDir, 'extra'))).toBe(false)
  })

  it('a blocked command fails by name with a one-line reason and exit 127', async () => {
    const worktree = join(workdir, 'run')
    const { binDir } = writeShimDir(worktree, ['mec'])
    const result = await new Promise<{ code: number | string | undefined; stderr: string }>((resolve) => {
      execFile(join(binDir, 'mec'), [], (err, _stdout, stderr) => {
        resolve({ code: err?.code ?? 0, stderr })
      })
    })
    expect(result.code).toBe(127)
    expect(result.stderr).toContain('mec: blocked inside a MEC attempt (mec policy)')
  })

  it('refuses a tampered script (hash mismatch)', () => {
    const worktree = join(workdir, 'tamper')
    const { binDir } = writeShimDir(worktree)
    appendFileSync(join(binDir, 'claude'), 'x')
    expect(verifyShimDir(binDir)).toBe(false)
  })

  it('refuses a foreign file inside binDir', () => {
    const worktree = join(workdir, 'foreign')
    const { binDir } = writeShimDir(worktree)
    writeFileSync(join(binDir, 'evil'), '#!/bin/sh\n', { mode: 0o755 })
    expect(verifyShimDir(binDir)).toBe(false)
  })

  it('refuses a script without the executable bit', () => {
    const worktree = join(workdir, 'noexec')
    const { binDir } = writeShimDir(worktree)
    chmodSync(join(binDir, 'mec'), 0o644)
    expect(verifyShimDir(binDir)).toBe(false)
  })

  it('refuses a missing manifest', () => {
    const worktree = join(workdir, 'nomanifest')
    const { binDir, manifestPath } = writeShimDir(worktree)
    rmSync(manifestPath)
    expect(verifyShimDir(binDir)).toBe(false)
  })
})

describe('writeAttemptGitconfig', () => {
  it('writes exactly the user identity when no credential helper is given', () => {
    const worktree = join(workdir, 'git-basic')
    const configPath = writeAttemptGitconfig(worktree, {
      userName: 'Ada Lovelace',
      userEmail: 'ada@example.com',
    })
    expect(configPath).toBe(join(worktree, '.mec', 'gitconfig'))
    expect(readFileSync(configPath, 'utf8')).toBe(
      '[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n',
    )
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
  })

  it('pins the credential helper when one is given', () => {
    const worktree = join(workdir, 'git-helper')
    const configPath = writeAttemptGitconfig(worktree, {
      userName: 'Grace Hopper',
      userEmail: 'grace@example.com',
      credentialHelper: '/usr/local/bin/mec-gh',
    })
    expect(readFileSync(configPath, 'utf8')).toBe(
      '[user]\n\tname = Grace Hopper\n\temail = grace@example.com\n' +
        '[credential]\n\thelper = /usr/local/bin/mec-gh\n',
    )
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
  })
})
