/**
 * Who the composed journey may run as (handoff 33 B6). The default is the fake CLI, which spends
 * nothing. A real pass needs its own flag, is refused on CI, and never gets a data dir that is the
 * owner's: `~/.mec` is the install's, in either mode.
 */
import { join, resolve, sep } from 'node:path'

export type JourneyMode = 'fake' | 'real'

type Env = Record<string, string | undefined>

export function journeyMode(env: Env): JourneyMode {
  if (env.MEC_JOURNEY_REAL !== '1') return 'fake'
  if (env.CI !== undefined && env.CI !== '' && env.CI !== '0' && env.CI !== 'false') {
    throw new Error('the real journey spends real quota and never runs in CI')
  }
  return 'real'
}

export interface ServerEnvInput {
  mode: JourneyMode
  inherited: Env
  /** The scratch `bin`, first on PATH: a fake `gh`, and in fake mode a fake `claude`. */
  bin: string
  /** The owner's home, which holds `~/.mec`. */
  ownerHome: string
  /** The scratch home. A real pass keeps the owner's, because a linked login is in the Keychain. */
  scratchHome: string
  dataDir: string
  gitConfig: string
}

/** The scratch server's whole environment. A variable that picks another engine never carries in. */
export function serverEnv(input: ServerEnvInput): Record<string, string> {
  const { mode, inherited, bin, ownerHome, scratchHome, dataDir, gitConfig } = input
  const owners = resolve(join(ownerHome, '.mec'))
  const asked = resolve(dataDir)
  if (asked === owners || asked.startsWith(`${owners}${sep}`)) {
    throw new Error(`the journey never runs on the owner's data dir: ${dataDir}`)
  }
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined || name.startsWith('MEC_') || name.startsWith('GIT_')) continue
    env[name] = value
  }
  return {
    ...env,
    PATH: `${bin}:${inherited.PATH ?? ''}`,
    HOME: mode === 'real' ? ownerHome : scratchHome,
    MEC_DATA_DIR: dataDir,
    MEC_NO_OPEN: '1',
    MEC_REAL_RUNNER: '1',
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_TERMINAL_PROMPT: '0',
  }
}
