// The commands treat an empty MEC_DATA_DIR as unset (`cliHome`), so the prompt root must as well.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mecRoot } from '../src/models'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('mecRoot', () => {
  it('follows MEC_DATA_DIR', () => {
    vi.stubEnv('MEC_DATA_DIR', '/scratch/state')
    expect(mecRoot()).toBe('/scratch/state')
  })

  it('reads an empty MEC_DATA_DIR as unset', () => {
    vi.stubEnv('MEC_DATA_DIR', '')
    expect(mecRoot()).toBe(join(homedir(), '.mec'))
  })
})
