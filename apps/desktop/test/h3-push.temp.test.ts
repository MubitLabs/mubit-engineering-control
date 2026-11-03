import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { pushIntegrationBranch } from '../src/release'

it('H3 card 1 (approved): push the integration branch — REAL', async () => {
  const state = JSON.parse(readFileSync('/private/var/folders/tc/wb8s80vn03j0ftw9fr2ntx9w0000gn/T/mec-h3-uoW25S/state.json', 'utf8')) as { gitDir: string; branch: string }
  const result = await pushIntegrationBranch(
    async (args: readonly string[]) => {
      const { execFile } = await import('node:child_process')
      return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        execFile('gh', args, { timeout: 30_000 }, (error, stdout, stderr) =>
          resolve({ code: error ? 1 : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
      })
    },
    'MubitLabs/mec-sandbox',
    state.gitDir,
    state.branch,
  )
  console.log('PUSH:', JSON.stringify(result))
  expect(result.pushed).toBe(true)
}, 120000)
