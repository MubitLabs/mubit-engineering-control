import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The Lighthouse script's verdict, on stubbed reports so no browser runs. The browser path is
 * exercised by `pnpm --dir apps/web test:lighthouse` (docs/agent-workflow/commands.md).
 */

const SCRIPT = join(__dirname, '..', 'scripts', 'lighthouse.mjs')
const dir = mkdtempSync(join(tmpdir(), 'mec-a11y-gate-'))

function report(name: string, body: unknown): string {
  const file = join(dir, name)
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
  return file
}

function run(...files: string[]) {
  return spawnSync(process.execPath, [SCRIPT, '--from-report', ...files], { encoding: 'utf8' })
}

const scored = (score: unknown) => ({ categories: { accessibility: { score } } })

describe('lighthouse script', () => {
  it('exits non-zero below 95', () => {
    const result = run(report('low.json', scored(0.94)))
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('FAIL')
  })

  it('exits zero at 95 and above', () => {
    expect(run(report('edge.json', scored(0.95)), report('full.json', scored(1))).status).toBe(0)
  })

  it('exits non-zero when one route of several misses', () => {
    expect(run(report('ok.json', scored(1)), report('bad.json', scored(0.5))).status).not.toBe(0)
  })

  it('exits non-zero on an unreadable report', () => {
    expect(run(join(dir, 'missing.json')).status).not.toBe(0)
    expect(run(report('garbage.json', 'not json')).status).not.toBe(0)
  })

  it('exits non-zero on a report with no accessibility score', () => {
    for (const [name, body] of [
      ['empty.json', {}],
      ['null.json', scored(null)],
      ['string.json', scored('1')],
    ] as const) {
      expect(run(report(name, body)).status, name).not.toBe(0)
    }
  })

  it('exits non-zero with no reports at all', () => {
    expect(run().status).not.toBe(0)
  })
})
