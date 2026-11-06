// M2.2: EOF is what ends a stream-input engine. On its own, so that a build that never closes stdin
// fails one bounded test instead of hanging every test in claude-input.test.ts.
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LaunchSpec } from '@mec/contracts'
import { afterAll, expect, it } from 'vitest'
import { ownedSpawn } from '../../runtime/src/owned-spawn'
import { Supervisor } from '../../runtime/src/supervisor'
import { ClaudeAdapter } from '../src/claude/adapter'

const FAKE_CLI = fileURLToPath(new URL('../../testkit/fake-cli/claude', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'mec-claude-eof-'))
const supervisor = new Supervisor()

afterAll(async () => {
  if (supervisor.owns('att_1', 1)) await supervisor.stop('att_1', 1)
  rmSync(dir, { recursive: true, force: true })
})

it('stdin closes when the last turn ends, and that ends the process', { timeout: 45_000 }, async () => {
  copyFileSync(FAKE_CLI, join(dir, 'claude'))
  const steps = [{ init: true }, { result: 'completed' }, { waitEof: true }]
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ steps }))
  const adapter = new ClaudeAdapter({
    binary: join(dir, 'claude'),
    streamInput: true,
    spawnFn: ownedSpawn(supervisor, { attemptId: 'att_1', generation: 1 }),
  })
  const handle = await adapter.launch({
    brief: {
      attempt_id: 'att_1',
      generation: 1,
      objective: 'x',
      env: {},
      budget: { turns: 5, wall_clock_ms: 60_000 },
      isolation: { read_only: false, permission_mode: 'bridge' },
    } as unknown as LaunchSpec['brief'],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir },
    cwd: dir,
    bridge: {} as LaunchSpec['bridge'],
  })

  let last: unknown
  for await (const event of adapter.events(handle)) last = event
  expect(last).toMatchObject({ type: 'exit', code: 0, terminal_reason: 'completed' })
  expect(readFileSync(join(dir, 'stdin-closed'), 'utf8')).toBe('yes')
})
