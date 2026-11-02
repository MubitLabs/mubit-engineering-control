import { describe, expect, it } from 'vitest'
import { loadRunnerConfig, RunnerConfigError, withEnvFile } from '../src/config'

describe('runner config', () => {
  it('fills settings from the config file without overriding the environment', () => {
    const env = withEnvFile(
      { MEC_RUNNER_ID: 'from-env' },
      'MEC_CONTROL_URL=https://mec.example\n# comment\nMEC_RUNNER_ID=from-file\nexport MEC_RUNNER_TOKEN="mec_rt_0123456789"\n',
    )
    expect(env).toMatchObject({
      MEC_CONTROL_URL: 'https://mec.example',
      MEC_RUNNER_ID: 'from-env',
      MEC_RUNNER_TOKEN: 'mec_rt_0123456789',
    })
    expect(loadRunnerConfig(env).controlUrl).toBe('https://mec.example')
  })

  it('names the missing settings and points an unenrolled machine at enrolment', () => {
    expect(() => loadRunnerConfig({})).toThrow(RunnerConfigError)
    expect(() => loadRunnerConfig({})).toThrow(
      /MEC_CONTROL_URL, MEC_RUNNER_ID, MEC_RUNNER_TOKEN\.\nThis runner is not enrolled yet/,
    )
    const bad = { MEC_CONTROL_URL: 'https://x', MEC_RUNNER_ID: 'r', MEC_RUNNER_TOKEN: 'mec_rt_0123456789' }
    expect(() => loadRunnerConfig({ ...bad, MEC_MAX_ATTEMPTS: 'lots' })).toThrow(
      /MEC_MAX_ATTEMPTS\.\nCheck these settings/,
    )
  })
})
