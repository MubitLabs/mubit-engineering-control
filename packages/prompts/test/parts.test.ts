import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TOOL_SPECS } from '../../mec-tools/src/tools'
import { componentHash } from '../src/bundles'
import {
  assemble,
  defaultParts,
  layerOfPart,
  listDefaultParts,
  listRoles,
  partName,
  readDefaultPart,
} from '../src/loader'
import { PromptStore, StaleBaseError, UnknownPartError } from '../src/store'

/**
 * T4's honesty suite (plan §16.7, review 2026-11-04 §6.3): every shipped default loads and
 * validates; the store refuses stale bases and never reuses revision numbers; assembly lays
 * every layer in §16.1 order inside a size budget; and the model-surface test — every role's
 * assembled text names only tools that exist in the platform tool set (checked against
 * mec-tools' real TOOL_SPECS) and states the rules the code enforces.
 */

const AT = () => new Date('2026-11-04T12:00:00.000Z')

/** The T4 manifest: 21 markdown parts; models.yaml is the capability table, not a part. */
const SHIPPED_PARTS = 21

const ENGINES = ['claude', 'codex', 'opencode'] as const

describe('shipped defaults', () => {
  it('ships exactly the 21 markdown parts — models.yaml is not a part', () => {
    const paths = listDefaultParts()
    expect(paths).toHaveLength(SHIPPED_PARTS)
    expect(paths.some((path) => path.endsWith('.yaml') || path.endsWith('.yml'))).toBe(false)
  })

  it('loads and validates every default: known layer, honest hash, non-empty imperative text', () => {
    for (const path of listDefaultParts()) {
      const part = readDefaultPart(path)
      expect(part, path).toBeDefined()
      expect(layerOfPart(path), path).toBeDefined()
      expect(part!.hash, path).toBe(componentHash(part!.text))
      expect(part!.name, path).toBe(partName(path))
      expect(part!.text.startsWith('# '), path).toBe(true)
      expect(part!.text.length, path).toBeGreaterThan(80)
    }
    expect(defaultParts()).toHaveLength(SHIPPED_PARTS)
  })

  it('maps shared/delivery.md to the delivery layer though the file lives under shared/', () => {
    expect(layerOfPart('shared/delivery.md')).toBe('delivery')
    expect(layerOfPart('shared/communication.md')).toBe('shared')
    expect(layerOfPart('conventions.md')).toBe('conventions')
    expect(layerOfPart('roles/meta_agent/protocol.md')).toBe('role')
    expect(layerOfPart('engines/claude.md')).toBe('engine')
    expect(layerOfPart('models.yaml')).toBeUndefined()
  })

  it('lists every built-in role: nine specialists, the meta agent, three subagents', () => {
    const roles = listRoles()
    for (const role of [
      'implementer',
      'test_author',
      'code_reviewer',
      'pr_reviewer',
      'security_checker',
      'integrator',
      'repair_agent',
      'release_agent',
      'setup_agent',
      'meta_agent',
      'lookup',
      'test_runner',
      'reviewer',
    ]) {
      expect(roles, `role ${role}`).toContain(role)
    }
  })
})

describe('assemble', () => {
  it('includes each layer in §16.1 order: shared → role → conventions → delivery → engine → skills → generated', () => {
    const { text } = assemble('implementer', 'claude', {
      skills: [{ name: 'triage', text: 'Triage the diff before reviewing.' }],
      generated: [{ name: 'environment', text: 'attempt: att_1 · slot: slot_a · policy: p1' }],
    })
    const headers = [
      '## shared/communication',
      '## shared/scope',
      '## role/implementer',
      '## conventions/conventions',
      '## delivery/delivery',
      '## engine/claude',
      '## skills/triage',
      '## generated/environment',
    ]
    const positions = headers.map((header) => text.indexOf(header))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(
      [...positions].sort((a, b) => a - b),
      text,
    ).toEqual(positions)
  })

  it('joins a multi-file role into ONE role component (meta_agent = planning + protocol)', () => {
    const { text } = assemble('meta_agent', 'claude')
    expect(text.match(/## role\//g)).toHaveLength(1)
    expect(text).toContain('## role/meta_agent')
    expect(text).toContain('the turn protocol')
    expect(text).toContain("Choose the cheapest tier that the task's risk allows")
  })

  it('assembles every role without an engine layer when no engine is named', () => {
    for (const role of listRoles()) {
      const { text } = assemble(role)
      expect(text, role).not.toContain('## engine/')
    }
  })

  it('refuses an unknown role or engine by name', () => {
    expect(() => assemble('nonexistent_role')).toThrow(/unknown role 'nonexistent_role'/)
    expect(() => assemble('implementer', 'nonexistent_engine')).toThrow(/unknown engine/)
  })

  it('stays under the size budget for every role and engine (< 24KB)', () => {
    for (const role of listRoles()) {
      for (const engine of ENGINES) {
        const { text } = assemble(role, engine)
        expect(text.length, `${role}/${engine}`).toBeLessThan(24 * 1024)
      }
    }
  })
})

describe('model surface (§16.7)', () => {
  it("names only tools that exist in the platform tool set (mec-tools' real TOOL_SPECS)", () => {
    const real = Object.keys(TOOL_SPECS)
    for (const role of listRoles()) {
      for (const engine of ENGINES) {
        const { text } = assemble(role, engine)
        for (const match of text.matchAll(/mcp__mec__([a-z_]+)/g)) {
          expect(real, `${role}/${engine} names '${match[1]}'`).toContain(match[1])
        }
      }
    }
  })

  it('states the enforced rules: never-secrets, the closed report vocabulary, the 100-word ceiling', () => {
    for (const role of listRoles()) {
      const { text } = assemble(role)
      expect(text, role).toMatch(/never ask for a key, token or password/i)
      for (const word of ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']) {
        expect(text, `${role}: vocabulary '${word}'`).toContain(word)
      }
      expect(text, role).toContain('100 words')
    }
  })
})

describe('PromptStore', () => {
  const roots: string[] = []
  const makeStore = (): { store: PromptStore; root: string } => {
    const root = mkdtempSync(join(tmpdir(), 'mec-prompts-test-'))
    roots.push(root)
    return { store: new PromptStore(root), root }
  }
  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
    roots.length = 0
  })

  it('starts empty at revision 0', () => {
    const { store } = makeStore()
    expect(store.config()).toEqual({ revision: 0, parts: [] })
    expect(store.changes()).toEqual([])
  })

  it('saves an override at the same path, with defaultBaseHash in .bases.json', () => {
    const { store, root } = makeStore()
    const def = readDefaultPart('roles/implementer.md')!
    const { revision } = store.save({
      baseRevision: 0,
      origin: 'panel',
      parts: [{ path: 'roles/implementer.md', text: 'My implementer rules.\n' }],
      now: AT,
    })
    expect(revision).toBe(1)
    expect(readFileSync(join(root, 'roles/implementer.md'), 'utf8')).toBe('My implementer rules.\n')
    const bases = JSON.parse(readFileSync(join(root, '.bases.json'), 'utf8')) as Record<string, string>
    expect(bases['roles/implementer.md']).toBe(def.hash)
    expect(store.config()).toEqual({
      revision: 1,
      parts: [
        {
          path: 'roles/implementer.md',
          text: 'My implementer rules.\n',
          defaultBaseHash: def.hash,
          layer: 'role',
        },
      ],
    })
  })

  it('detects a stale base and writes nothing — the draft survives as the caller held it', () => {
    const { store, root } = makeStore()
    store.save({
      baseRevision: 0,
      origin: 'panel',
      parts: [{ path: 'roles/implementer.md', text: 'First edit.\n' }],
      now: AT,
    })
    const before = JSON.parse(readFileSync(join(root, '.bases.json'), 'utf8')) as Record<string, string>
    let stale: StaleBaseError | undefined
    try {
      store.save({
        baseRevision: 0,
        origin: 'panel',
        parts: [{ path: 'roles/implementer.md', text: 'Racing edit.\n' }],
        now: AT,
      })
    } catch (error) {
      stale = error as StaleBaseError
    }
    expect(stale).toBeInstanceOf(StaleBaseError)
    expect(stale!.currentRevision).toBe(1)
    expect(store.revision()).toBe(1)
    expect(readFileSync(join(root, 'roles/implementer.md'), 'utf8')).toBe('First edit.\n')
    expect(JSON.parse(readFileSync(join(root, '.bases.json'), 'utf8'))).toEqual(before)
  })

  it('removes an override saved identical to the default, so the part follows future defaults (§16.2)', () => {
    const { store, root } = makeStore()
    const def = readDefaultPart('shared/scope.md')!
    store.save({
      baseRevision: 0,
      origin: 'user',
      parts: [{ path: 'shared/scope.md', text: 'Custom scope.\n' }],
      now: AT,
    })
    expect(store.config().parts).toHaveLength(1)
    const { revision } = store.save({
      baseRevision: 1,
      origin: 'user',
      parts: [{ path: 'shared/scope.md', text: def.text }],
      now: AT,
    })
    expect(revision).toBe(2)
    expect(store.config()).toEqual({ revision: 2, parts: [] })
    expect(existsSync(join(root, 'shared/scope.md'))).toBe(false)
  })

  it('writes immutable revisions: full config + base + origin + time, numbers never reused', () => {
    const { store, root } = makeStore()
    store.save({
      baseRevision: 0,
      origin: 'panel',
      parts: [{ path: 'roles/implementer.md', text: 'One.\n' }],
      now: AT,
    })
    store.save({
      baseRevision: 1,
      origin: 'agent',
      parts: [{ path: 'roles/implementer.md', text: 'Two.\n' }],
      now: AT,
    })
    const first = store.getRevision(1)
    expect(first).toMatchObject({ n: 1, base: 0, origin: 'panel', time: AT().toISOString() })
    expect(first!.parts).toEqual([
      {
        path: 'roles/implementer.md',
        text: 'One.\n',
        defaultBaseHash: readDefaultPart('roles/implementer.md')!.hash,
        defaultText: readDefaultPart('roles/implementer.md')!.text,
      },
    ])
    expect(store.getRevision(2)).toMatchObject({ n: 2, base: 1, origin: 'agent' })
    // Immutable: a later save leaves earlier snapshots byte-identical, and the numbers 1 and 2
    // are never handed out again.
    const bytes = readFileSync(join(root, 'revisions/1.json'), 'utf8')
    store.save({
      baseRevision: 2,
      origin: 'panel',
      parts: [{ path: 'roles/implementer.md', text: 'Three.\n' }],
      now: AT,
    })
    expect(readFileSync(join(root, 'revisions/1.json'), 'utf8')).toBe(bytes)
    expect(store.revision()).toBe(3)
    expect(store.getRevision(4)).toBeUndefined()
  })

  it('refuses a part that is not a shipped default', () => {
    const { store } = makeStore()
    expect(() =>
      store.save({
        baseRevision: 0,
        origin: 'agent',
        parts: [
          { path: 'roles/ghost.md', text: 'Boo.\n' },
          { path: 'models.yaml', text: 'tiers: []\n' },
        ],
      }),
    ).toThrow(UnknownPartError)
  })

  it('applies overrides to assemble — a Settings edit lands in the pinned bundle', () => {
    const { store } = makeStore()
    store.save({
      baseRevision: 0,
      origin: 'panel',
      parts: [{ path: 'roles/implementer.md', text: 'My implementer rules.\n' }],
      now: AT,
    })
    const bundle = store.assemble('implementer', 'claude')
    expect(bundle.text).toContain('My implementer rules.')
    expect(bundle.text).not.toContain('# Role: implementer')
    // The shared layer still ships: the edit replaced the role, not the bundle.
    expect(bundle.text).toContain('## shared/communication')
  })

  it('reports Default-updated parts and recovers the old default text from revision history', () => {
    const root = mkdtempSync(join(tmpdir(), 'mec-prompts-test-'))
    roots.push(root)
    // Hand-craft a store state per the file contract: an override written against a default
    // that has since been replaced by an app update (base hash the shipped tree no longer has).
    mkdirSync(join(root, 'revisions'), { recursive: true })
    mkdirSync(join(root, 'shared'), { recursive: true })
    writeFileSync(join(root, 'shared/communication.md'), 'User-edited communication rules.\n')
    writeFileSync(
      join(root, '.bases.json'),
      `${JSON.stringify({ 'shared/communication.md': 'deadbeef00000000' }, null, 2)}\n`,
    )
    writeFileSync(
      join(root, 'revisions/1.json'),
      `${JSON.stringify(
        {
          n: 1,
          base: 0,
          origin: 'panel',
          time: AT().toISOString(),
          parts: [
            {
              path: 'shared/communication.md',
              text: 'User-edited communication rules.\n',
              defaultBaseHash: 'deadbeef00000000',
              defaultText: 'The OLD default the user based their edit on.\n',
            },
          ],
        },
        null,
        2,
      )}\n`,
      { flag: 'wx' },
    )
    const store = new PromptStore(root)
    const changes = store.changes()
    expect(changes).toHaveLength(1)
    const current = readDefaultPart('shared/communication.md')!
    expect(changes[0]).toEqual({
      path: 'shared/communication.md',
      oldDefault: { text: 'The OLD default the user based their edit on.\n', hash: 'deadbeef00000000' },
      newDefault: { text: current.text, hash: current.hash },
      userText: 'User-edited communication rules.\n',
      userBaseHash: 'deadbeef00000000',
      removed: false,
    })
  })

  it('lists overrides for removed parts as removed, and the next save drops them (§16.3)', () => {
    const root = mkdtempSync(join(tmpdir(), 'mec-prompts-test-'))
    roots.push(root)
    mkdirSync(join(root, 'roles'), { recursive: true })
    writeFileSync(join(root, 'roles/ghost.md'), 'Leftover override.\n')
    writeFileSync(
      join(root, '.bases.json'),
      `${JSON.stringify({ 'roles/ghost.md': 'deadbeef00000000' }, null, 2)}\n`,
    )
    const store = new PromptStore(root)
    expect(store.changes()).toEqual([
      {
        path: 'roles/ghost.md',
        oldDefault: undefined,
        newDefault: undefined,
        userText: 'Leftover override.\n',
        userBaseHash: 'deadbeef00000000',
        removed: true,
      },
    ])
    store.save({ baseRevision: 0, origin: 'panel', parts: [], now: AT })
    expect(store.config()).toEqual({ revision: 1, parts: [] })
    expect(existsSync(join(root, 'roles/ghost.md'))).toBe(false)
  })
})
