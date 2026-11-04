import { describe, expect, it } from 'vitest'
import { buildDoctorJson, buildDoctorReport, defaultVersionRunner } from '../src/doctor'

/** Key-shaped fakes in the real `sk-ant-` format without being real keys. */
const envKey = `sk-ant-${'a'.repeat(32)}`
const pathKey = `sk-ant-${'b'.repeat(32)}`
const snapshotKey = `sk-ant-${'c'.repeat(32)}`

describe('buildDoctorReport', () => {
  it('reports the versions the runner returns per engine', async () => {
    const report = await buildDoctorReport({
      env: {},
      run: async (name: string) => ({ stdout: name.includes('claude') ? '1.2.3' : '9.9.9' }),
      snapshotText: '',
    })
    expect(report).toContain('engine claude:')
    expect(report).toContain('engine codex:')
    expect(report).toContain('1.2.3')
    expect(report).toContain('9.9.9')
  })

  it('reports an engine as not installed when the runner returns null', async () => {
    const report = await buildDoctorReport({
      env: {},
      run: async (name: string) => (name.includes('claude') ? { stdout: '1.2.3' } : null),
      snapshotText: '',
    })
    expect(report).toContain('engine claude:')
    expect(report).toContain('engine codex: not installed')
  })

  it('skips secret variable names entirely', async () => {
    const report = await buildDoctorReport({
      env: { ANTHROPIC_API_KEY: envKey },
      run: async () => null,
      snapshotText: '',
    })
    expect(report).not.toContain('ANTHROPIC_API_KEY')
    expect(report).not.toContain(envKey)
  })

  it('redacts key-shaped values under allowlisted names like PATH', async () => {
    const report = await buildDoctorReport({
      env: { PATH: pathKey },
      run: async () => null,
      snapshotText: '',
    })
    expect(report).toContain('PATH')
    expect(report).not.toContain('sk-ant-')
  })

  it('redacts secrets embedded in the health snapshot text', async () => {
    const report = await buildDoctorReport({
      env: {},
      run: async () => null,
      snapshotText: `{"parts":{"slot:max-1":{"detail":"login expired for ${snapshotKey}"}}}`,
    })
    expect(report).toContain('redacted')
    expect(report).not.toContain('sk-ant-')
  })
})

describe('defaultVersionRunner', () => {
  it('is exported as a function', () => {
    expect(typeof defaultVersionRunner).toBe('function')
  })
})

describe('buildDoctorJson (the --json bundle)', () => {
  it('emits the same facts machine-readably, redacted, with an ok flag', async () => {
    const run = async (cmd: string) => (cmd === 'claude' ? { stdout: '2.1.317 (Claude Code)\n' } : null)
    const bundle = await buildDoctorJson({
      env: {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'sk-ant-test-fixture-000000000000abcd',
      } as unknown as NodeJS.ProcessEnv,
      run,
      snapshotText: 'present',
    })
    expect(bundle.ok).toBe(false) // codex/opencode answered null in this stub
    expect(bundle.engines).toEqual([
      { engine: 'claude', version: '2.1.317 (Claude Code)' },
      { engine: 'codex', version: null },
      { engine: 'opencode', version: null },
    ])
    expect(bundle.env.PATH).toBe('/usr/bin')
    expect(JSON.stringify(bundle)).not.toContain('sk-ant')
    expect(bundle.snapshot).toBe('present')
    const round = JSON.parse(JSON.stringify(bundle)) as typeof bundle
    expect(round.at).toBe(bundle.at)
  })
})
