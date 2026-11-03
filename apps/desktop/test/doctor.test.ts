import { describe, expect, it } from 'vitest'
import { buildDoctorReport, defaultVersionRunner } from '../src/doctor'

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
