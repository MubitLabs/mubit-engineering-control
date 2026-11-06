/**
 * `mec slot` (plan §21.1): add/list/probe/retire against a REAL SqliteStore in a tmpdir —
 * the same §5.7 makeServer discipline as api-slots.test.ts, minus the HTTP: the CLI is a
 * local-state surface, so its proof is the persisted docs/events, the on-disk home tree
 * and the printed lines. Probes run on an injected runner (§5.8); retire must shred a real
 * keystore file.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ProbeRun, REQUIRED_FLAGS } from '@mec/engines'
import { SlotKeystore } from '@mec/slots'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { runSlotCli } from '../src/slot-cli'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

function makeIo(probeRun?: ProbeRun) {
  const dataDir = mkdtempSync(join(tmpdir(), `mec-slot-cli-${randomBytes(4).toString('hex')}-`))
  tempDirs.push(dataDir)
  const lines: string[] = []
  return {
    dataDir,
    lines,
    io: {
      dataDir,
      ...(probeRun !== undefined && { probeRun }),
      stdout: (line: string) => {
        lines.push(line)
      },
    },
  }
}

/** Re-opens the CLI-created store so assertions read the persisted docs, not memory. */
function slotDocsOf(dataDir: string): Array<Record<string, unknown>> {
  const db = new Database(join(dataDir, 'mec.db'))
  migrate(db, MIGRATIONS_v1) // idempotent; the CLI already migrated
  const store = new SqliteStore(db)
  try {
    return store.slots.list() as unknown as Array<Record<string, unknown>>
  } finally {
    db.close()
  }
}

/** A §5.8 fake: a claude binary whose --version/--help/auth status the test controls. */
function fakeClaudeRun(opts: {
  version?: string
  help?: string
  loggedIn?: boolean
  throws?: boolean
}): ProbeRun {
  return async (_cmd, args) => {
    if (opts.throws) throw new Error('spawn claude ENOENT')
    const [first] = args
    if (first === '--version') {
      return { code: 0, stdout: `${opts.version ?? '2.1.317'} (Claude Code)\n`, stderr: '' }
    }
    if (first === '--help') {
      return { code: 0, stdout: opts.help ?? REQUIRED_FLAGS.join(' '), stderr: '' }
    }
    return {
      code: 0,
      stdout: JSON.stringify({ loggedIn: opts.loggedIn ?? true, email: 'dev@mubit.example' }),
      stderr: '',
    }
  }
}

describe('mec slot add', () => {
  it('creates the home via @mec/slots, saves a home_ready doc and prints the login next step', async () => {
    const { dataDir, io, lines } = makeIo()
    const code = await runSlotCli(['add', 'claude-sub', 'max-1'], io)
    expect(code).toBe(0)

    const home = join(dataDir, 'engines', 'claude', 'max-1')
    expect(existsSync(home)).toBe(true)
    expect(lines[0]).toBe(`created max-1 (home ${home})`)
    expect(lines[1]).toContain('run the workbench login card (mec serve → Slots)')
    expect(lines[1]).toContain('MEC_LOGIN_SLOT')

    expect(slotDocsOf(dataDir)).toEqual([
      expect.objectContaining({
        id: 'slot_max-1',
        label: 'max-1',
        engine: 'claude',
        kind: 'claude-sub',
        state: 'home_ready',
        home,
        env: { CLAUDE_CONFIG_DIR: home },
      }),
    ])
  })

  it('api kinds get the Slots-form next step and the engine-mapped home', async () => {
    const { dataDir, io, lines } = makeIo()
    const code = await runSlotCli(['add', 'opencode-gemini', 'gem-1'], io)
    expect(code).toBe(0)
    expect(lines[1]).toBe('next step: paste the key in the Slots form (never the CLI)')
    expect(existsSync(join(dataDir, 'engines', 'opencode', 'gem-1', 'config'))).toBe(true)
    expect(slotDocsOf(dataDir)[0]).toMatchObject({ engine: 'opencode', kind: 'opencode-gemini' })
  })

  it('refuses a duplicate label, an unknown kind and a missing label', async () => {
    const first = makeIo()
    expect(await runSlotCli(['add', 'codex-sub', 'codex-1'], first.io)).toBe(0)
    const dup = await runSlotCli(['add', 'claude-sub', 'codex-1'], first.io)
    expect(dup).toBe(1)
    expect(first.lines.at(-1)).toContain('already exists')

    const bad = makeIo()
    expect(await runSlotCli(['add', 'skynet-api', 'x'], bad.io)).toBe(1)
    expect(bad.lines.join('\n')).toContain("unknown kind 'skynet-api'")
    expect(await runSlotCli(['add', 'claude-sub'], bad.io)).toBe(1)
    expect(slotDocsOf(bad.dataDir)).toHaveLength(0)
  })
})

describe('mec slot list', () => {
  it('prints an aligned table: every row starts its columns where the header does', async () => {
    const { io, lines } = makeIo()
    await runSlotCli(['add', 'claude-sub', 'a'], io)
    await runSlotCli(['add', 'opencode-gemini', 'a-much-longer-label'], io)

    const code = await runSlotCli(['list'], io)
    expect(code).toBe(0)

    const table = lines.filter((line) => line.startsWith('LABEL') || line.includes('home_ready'))
    expect(table).toHaveLength(3)
    const header = table[0] ?? ''
    const engineCol = header.indexOf('ENGINE')
    const kindCol = header.indexOf('KIND')
    expect(engineCol).toBeGreaterThan(0)
    expect((table[1] ?? '').slice(engineCol).startsWith('claude')).toBe(true)
    expect((table[2] ?? '').slice(engineCol).startsWith('opencode')).toBe(true)
    expect((table[1] ?? '').slice(kindCol).startsWith('claude-sub')).toBe(true)
    expect((table[2] ?? '').slice(kindCol).startsWith('opencode-gemini')).toBe(true)
  })

  it('lists nothing (with a hint) before any slot exists', async () => {
    const { io, lines } = makeIo()
    expect(await runSlotCli(['list'], io)).toBe(0)
    expect(lines.join('\n')).toContain('no slots yet')
  })
})

describe('mec slot probe (claude-sub only in v0)', () => {
  it('a healthy probe prints the engine version, updates the doc and exits 0', async () => {
    const { dataDir, io, lines } = makeIo(fakeClaudeRun({ version: '2.1.317' }))
    await runSlotCli(['add', 'claude-sub', 'max-1'], io)

    const code = await runSlotCli(['probe', 'max-1'], io)
    expect(code).toBe(0)
    expect(lines.at(-1)).toBe('healthy max-1 (claude 2.1.317)')
    expect(slotDocsOf(dataDir)[0]).toMatchObject({
      state: 'healthy',
      engine_version: '2.1.317',
      last_probe_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    })
  })

  it('missing required flags degrade to engine_unsupported and exit 2', async () => {
    const { dataDir, io, lines } = makeIo(
      fakeClaudeRun({ help: REQUIRED_FLAGS.filter((flag) => flag !== '--model').join(' ') }),
    )
    await runSlotCli(['add', 'claude-sub', 'max-1'], io)

    const code = await runSlotCli(['probe', 'max-1'], io)
    expect(code).toBe(2)
    expect(lines.at(-1)).toContain('degraded max-1 (engine_unsupported')
    expect(slotDocsOf(dataDir)[0]).toMatchObject({ state: 'degraded', state_reason: 'engine_unsupported' })
  })

  it('a logged-out auth status degrades to auth_expired and exit 2', async () => {
    const { dataDir, io, lines } = makeIo(fakeClaudeRun({ loggedIn: false }))
    await runSlotCli(['add', 'claude-sub', 'max-1'], io)

    expect(await runSlotCli(['probe', 'max-1'], io)).toBe(2)
    expect(lines.at(-1)).toContain('degraded max-1 (auth_expired')
    expect(slotDocsOf(dataDir)[0]).toMatchObject({ state: 'degraded', state_reason: 'auth_expired' })
  })

  it('a probe whose spawn throws degrades to engine_missing', async () => {
    const { dataDir, io, lines } = makeIo(fakeClaudeRun({ throws: true }))
    await runSlotCli(['add', 'claude-sub', 'max-1'], io)

    expect(await runSlotCli(['probe', 'max-1'], io)).toBe(2)
    expect(lines.at(-1)).toContain('engine_missing')
    expect(slotDocsOf(dataDir)[0]).toMatchObject({ state: 'degraded', state_reason: 'engine_missing' })
  })

  it('refuses non-claude-sub kinds and unknown labels', async () => {
    const { io, lines } = makeIo()
    await runSlotCli(['add', 'codex-sub', 'codex-1'], io)
    expect(await runSlotCli(['probe', 'codex-1'], io)).toBe(1)
    expect(lines.at(-1)).toContain("only 'claude-sub' slots probe in v0")
    expect(await runSlotCli(['probe', 'nope'], io)).toBe(1)
    expect(lines.at(-1)).toContain("no slot named 'nope'")
  })
})

describe('mec slot retire', () => {
  it('shreds a real keystore file for api kinds, retires the doc and keeps the home', async () => {
    const { dataDir, io, lines } = makeIo()
    await runSlotCli(['add', 'claude-api', 'anthropic-1'], io)
    const home = join(dataDir, 'engines', 'claude', 'anthropic-1')
    const keystore = new SlotKeystore(home)
    const key = 'sk-ant-api03-mec-test-fixture-000000000000abcd'
    keystore.store('anthropic-api', key)
    const keyFile = join(home, 'keys', 'anthropic-api.key')
    expect(existsSync(keyFile)).toBe(true)

    const code = await runSlotCli(['retire', 'anthropic-1'], io)
    expect(code).toBe(0)
    expect(lines.at(-1)).toContain('key shredded')
    expect(lines.at(-1)).toContain(`home kept: ${home}`)

    expect(existsSync(keyFile)).toBe(false) // §5.7: shredded, not merely unlinked
    expect(existsSync(home)).toBe(true) // §5.5: the home dir is kept
    expect(slotDocsOf(dataDir)[0]).toMatchObject({ state: 'retired' })

    expect(await runSlotCli(['retire', 'anthropic-1'], io)).toBe(0) // idempotent
    expect(lines.at(-1)).toContain('already retired')
  })

  it('retires a subscription slot with no keystore and keeps the home', async () => {
    const { dataDir, io, lines } = makeIo()
    await runSlotCli(['add', 'claude-sub', 'max-1'], io)
    const code = await runSlotCli(['retire', 'max-1'], io)
    expect(code).toBe(0)
    expect(lines.at(-1)).toContain('home kept:')
    expect(lines.at(-1)).not.toContain('key shredded')
    expect(existsSync(join(dataDir, 'engines', 'claude', 'max-1'))).toBe(true)
    expect(slotDocsOf(dataDir)[0]).toMatchObject({ state: 'retired' })
  })

  it('refuses an unknown label', async () => {
    const { io, lines } = makeIo()
    expect(await runSlotCli(['retire', 'ghost'], io)).toBe(1)
    expect(lines.at(-1)).toContain("no slot named 'ghost'")
  })
})

describe('mec slot usage', () => {
  it('an unknown subcommand (and a bare slot) prints usage and exits 1', async () => {
    const { io, lines } = makeIo()
    expect(await runSlotCli(['bogus'], io)).toBe(1)
    expect(await runSlotCli([], io)).toBe(1)
    expect(lines.filter((line) => line.includes('usage:')).length).toBeGreaterThan(0)
  })
})
