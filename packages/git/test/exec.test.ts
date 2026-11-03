// git() runs the real git binary argv-only — never a shell string — with an explicit base
// environment, UTF-8 capture, signal deaths mapped to code -1, and non-zero exits thrown
// unless allowFailure is set; gitLines() trims stdout into non-empty lines.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { git, gitLines } from '../src/exec'

const workdir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'mec-git-exec-'))
afterAll(() => {
  rmSync(workdir, { recursive: true, force: true })
})

describe('git', () => {
  it('runs argv against the real git and captures stdout/stderr as UTF-8', async () => {
    const result = await git(['--version'])
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toMatch(/^git version \d+\.\d+/)
    expect(result.stderr).toBe('')
  })

  it('honours cwd', async () => {
    const repo = join(workdir, 'repo')
    await git(['init', '--quiet', '-b', 'main', repo])
    const result = await git(['rev-parse', '--is-inside-work-tree'], { cwd: repo })
    expect(result.stdout.trim()).toBe('true')
  })

  it('merges opts.env over the base environment', async () => {
    const result = await git(['var', 'GIT_AUTHOR_IDENT'], {
      env: {
        GIT_AUTHOR_NAME: 'Env User',
        GIT_AUTHOR_EMAIL: 'env@example.com',
        GIT_AUTHOR_DATE: '2005-04-07T22:13:13 +0000',
      },
    })
    expect(result.stdout).toContain('Env User <env@example.com>')
  })

  it('throws on a non-zero exit and resolves with it under allowFailure', async () => {
    const repo = join(workdir, 'empty')
    await git(['init', '--quiet', '-b', 'main', repo])
    await expect(git(['rev-parse', 'HEAD'], { cwd: repo })).rejects.toThrow(/rev-parse/)
    const tolerated = await git(['rev-parse', 'HEAD'], { cwd: repo, allowFailure: true })
    expect(tolerated.code).toBe(128)
    expect(tolerated.stderr).not.toBe('')
  })

  it('maps a signal death to code -1 (thrown, or resolved under allowFailure)', async () => {
    // PATH is part of the base env and opts.env wins, so 'git' resolves to this shim.
    const bin = join(workdir, 'shim-bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nkill -TERM $$\n')
    chmodSync(join(bin, 'git'), 0o755)
    await expect(git(['status'], { env: { PATH: bin } })).rejects.toThrow(/status/)
    const tolerated = await git(['status'], { env: { PATH: bin }, allowFailure: true })
    expect(tolerated.code).toBe(-1)
  })
})

describe('gitLines', () => {
  it('returns trimmed, non-empty stdout lines', async () => {
    const repo = join(workdir, 'remotes')
    await git(['init', '--quiet', '-b', 'main', repo])
    await git(['remote', 'add', 'origin', 'https://example.com/first.git'], { cwd: repo })
    await git(['remote', 'add', 'other', 'https://example.com/second.git'], { cwd: repo })

    expect(await gitLines(['--version'])).toHaveLength(1)
    const remotes = await gitLines(['remote'], { cwd: repo })
    expect(remotes).toHaveLength(2)
    expect(remotes[1]).toBe('other')
  })

  it('returns an empty array for empty output', async () => {
    const repo = join(workdir, 'remotes')
    expect(await gitLines(['status', '--porcelain'], { cwd: repo })).toEqual([])
  })
})
