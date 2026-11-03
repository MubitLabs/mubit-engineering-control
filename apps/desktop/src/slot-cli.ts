/**
 * `mec slot …` (plan §21.1): the CLI face of the slot layer — `add`, `list`, `probe`,
 * `retire`, so the agent-guided setup and scripts drive the same flows the workbench
 * Slots panel uses.
 *
 * Local state only: every subcommand opens the SQLite store in `io.dataDir` directly
 * (migrate is idempotent) instead of talking to a running server — slot homes and slot
 * docs are machine-local facts, and `mec slot add` must work before any server has ever
 * started. The production wiring passes `~/.mec` as `dataDir`, which makes it the slot
 * home root exactly as §5.3/§5.4 state (`<root>/engines/<engine>/<slot>`).
 *
 * Never a secret surface: keys are pasted only through the Slots form (§5.4); the CLI
 * creates homes, probes with the vendor's own `--version`/`--help`/`auth status`
 * commands (§5.8), and shreds keystores on retire (§5.7).
 */
import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Degraded, DomainEvent, Json, ProviderId, StoreDoc } from '@mec/contracts'
import { type ProbeRun, probeClaude, REQUIRED_FLAGS } from '@mec/engines'
import { checkDrift } from '@mec/runtime'
import { claudeHome, codexHome, opencodeHome, SlotKeystore } from '@mec/slots'
import { MIGRATIONS_v1, migrate, SqliteStore } from '@mec/store'
import Database from 'better-sqlite3'

/** The five kinds v0 creates from the CLI (plan §5.2); anything else is a usage error. */
const SLOT_KINDS = {
  'claude-sub': { engine: 'claude', credential: 'oauth' as const },
  'claude-api': { engine: 'claude', credential: 'api_key' as const },
  'codex-sub': { engine: 'codex', credential: 'oauth' as const },
  'opencode-glm': { engine: 'opencode', credential: 'api_key' as const },
  'opencode-gemini': { engine: 'opencode', credential: 'api_key' as const },
} as const

type SlotKind = keyof typeof SLOT_KINDS
type Engine = (typeof SLOT_KINDS)[SlotKind]['engine']

/** Every provider a slot home's keystore could hold; retire shreds each (absent = no-op). */
const ALL_PROVIDERS: readonly ProviderId[] = [
  'anthropic-sub',
  'anthropic-api',
  'openai-sub',
  'openai-api',
  'zai-coding-plan',
  'google-gemini',
]

/**
 * The slot doc these commands keep — the same shape the server's slots routes write
 * ({id, label, engine, kind, home, state, …}), so UI- and CLI-created slots list and
 * retire identically. No secret-adjacent field beyond an optional key fingerprint.
 */
type SlotDoc = {
  id: string
  label: string
  engine: Engine
  kind: SlotKind
  home: string
  state: string
  state_reason?: Degraded
  engine_version?: string
  last_probe_at?: string
  createdAt: string
  updatedAt: string
}

export type SlotCliIo = {
  /** The §5.4 root: holds mec.db and the `engines/` slot-home tree (~/.mec in production). */
  dataDir: string
  /**
   * Accepted for parity with a future server-driven mode; v0 deliberately ignores it —
   * slot subcommands are local-state commands, never server calls.
   */
  apiBase?: string
  /** §5.8 probe runner; tests inject fakes, production gets the execFile default below. */
  probeRun?: ProbeRun
  stdout?: (line: string) => void
}

const USAGE = [
  'usage: mec slot <subcommand> [args]',
  '  add <kind> <label>   create a slot home (kinds: claude-sub, claude-api, codex-sub, opencode-glm, opencode-gemini)',
  '  list                 list the slot docs (label, engine, kind, state)',
  '  probe <label>        probe a claude-sub slot (exit 0 healthy / 2 degraded)',
  '  retire <label>       shred the keystore (api kinds) and retire the slot; the home is kept',
].join('\n')

/** §5.3: creates (and validates) the slot's home under `<root>/engines/<engine>/<slot>`. */
function homeFor(root: string, engine: Engine, label: string) {
  if (engine === 'claude') return claudeHome(root, label)
  if (engine === 'codex') return codexHome(root, label)
  return opencodeHome(root, label)
}

/** The production probe runner — composition.ts's probeSlotAtStartup exec, env-merged. */
const defaultProbeRun: ProbeRun = (cmd, args, env) =>
  new Promise((resolve) => {
    const merged: Record<string, string> = {}
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined) merged[name] = value
    }
    Object.assign(merged, env ?? {})
    execFile(cmd, args, { env: merged }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : 1, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })

/**
 * `mec slot` entry. Dispatches one subcommand against a store opened in `io.dataDir`;
 * returns the process exit code (0 ok, 1 usage/error, 2 probe degraded).
 */
export async function runSlotCli(argv: readonly string[], io: SlotCliIo): Promise<number> {
  const out = io.stdout ?? ((line: string) => console.log(line))
  const [sub = ''] = argv

  if (sub === '' || sub === 'help' || sub === '--help') {
    out(USAGE)
    return sub === '' ? 1 : 0
  }

  mkdirSync(io.dataDir, { recursive: true })
  const db = new Database(join(io.dataDir, 'mec.db'))
  migrate(db, MIGRATIONS_v1)
  const store = new SqliteStore(db)
  try {
    if (sub === 'add') return cmdAdd(argv.slice(1), io, out, store)
    if (sub === 'list') return cmdList(out, store)
    if (sub === 'probe') return await cmdProbe(argv.slice(1), io, out, store)
    if (sub === 'retire') return cmdRetire(argv.slice(1), out, store)
    out(USAGE)
    return 1
  } finally {
    db.close()
  }
}

function cmdAdd(
  args: readonly string[],
  io: SlotCliIo,
  out: (line: string) => void,
  store: SqliteStore,
): number {
  const [kindArg = '', rawLabel = ''] = args
  const label = rawLabel.trim()
  if (kindArg === '' || label === '') {
    out(USAGE)
    return 1
  }
  if (!(kindArg in SLOT_KINDS)) {
    out(`mec slot add: unknown kind '${kindArg}' (expected one of: ${Object.keys(SLOT_KINDS).join(', ')})`)
    return 1
  }
  const kind = kindArg as SlotKind
  const spec = SLOT_KINDS[kind]
  if (findSlot(store, label) !== undefined) {
    out(`mec slot add: a slot with that label already exists — retire it first`)
    return 1
  }

  // The home is created (and the label validated as a single path segment) before any
  // doc exists; an escaping label dies here having written nothing but directories.
  let home: ReturnType<typeof homeFor>
  try {
    home = homeFor(io.dataDir, spec.engine, label)
  } catch (error) {
    out(`mec slot add: ${error instanceof Error ? error.message : 'invalid slot label'}`)
    return 1
  }

  const at = new Date().toISOString()
  store.atomic(() => {
    store.slots.save({
      id: `slot_${label}`,
      label,
      engine: spec.engine,
      kind,
      home: home.homeDir,
      state: 'home_ready',
      createdAt: at,
      updatedAt: at,
    } as SlotDoc as StoreDoc)
    appendEvent(store, `slot:${label}`, 'slot_created', { slotId: `slot_${label}`, label, kind, at }, at)
  })

  out(`created ${label} (home ${home.homeDir})`)
  // The next step is always a UI flow — the CLI never sees a credential (§5.4/§5.6).
  if (spec.credential === 'oauth') {
    out('next step: run the workbench login card (mec serve → Slots) or set MEC_LOGIN_SLOT and use the UI')
  } else {
    out('next step: paste the key in the Slots form (never the CLI)')
  }
  return 0
}

function cmdList(out: (line: string) => void, store: SqliteStore): number {
  const docs = store.slots.list() as unknown as SlotDoc[]
  if (docs.length === 0) {
    out('no slots yet (first one: mec slot add claude-sub <label>)')
    return 0
  }
  const rows = docs.map((doc) => [doc.label, doc.engine, doc.kind, doc.state])
  for (const line of alignTable(['LABEL', 'ENGINE', 'KIND', 'STATE'], rows)) out(line)
  return 0
}

async function cmdProbe(
  args: readonly string[],
  io: SlotCliIo,
  out: (line: string) => void,
  store: SqliteStore,
): Promise<number> {
  const label = (args[0] ?? '').trim()
  if (label === '') {
    out(USAGE)
    return 1
  }
  const doc = findSlot(store, label)
  if (doc === undefined) {
    out(`mec slot probe: no slot named '${label}'`)
    return 1
  }
  if (doc.kind !== 'claude-sub') {
    out("mec slot probe: only 'claude-sub' slots probe in v0")
    return 1
  }

  const result = await probeClaudeHome(io.probeRun ?? defaultProbeRun, doc.home)
  const at = new Date().toISOString()
  store.atomic(() => {
    const next: StoreDoc = {
      ...doc,
      state: result.state,
      engine_version: result.engineVersion,
      last_probe_at: at,
      updatedAt: at,
    }
    if (result.state === 'degraded' && result.reason !== undefined) next.state_reason = result.reason
    else delete next.state_reason
    store.slots.save(next)
    appendEvent(
      store,
      `slot:${doc.label}`,
      result.state === 'healthy' ? 'slot_healthy' : 'slot_degraded',
      {
        slotId: doc.id,
        ...(result.state === 'degraded' && { reason: result.reason }),
        engine_version: result.engineVersion,
        at,
      },
      at,
    )
  })

  if (result.state === 'healthy') {
    out(`healthy ${doc.label} (claude ${result.engineVersion})`)
    return 0
  }
  out(`degraded ${doc.label} (${result.reason}${result.detail === undefined ? '' : `: ${result.detail}`})`)
  return 2
}

function cmdRetire(args: readonly string[], out: (line: string) => void, store: SqliteStore): number {
  const label = (args[0] ?? '').trim()
  if (label === '') {
    out(USAGE)
    return 1
  }
  const doc = findSlot(store, label)
  if (doc === undefined) {
    out(`mec slot retire: no slot named '${label}'`)
    return 1
  }
  if (doc.state === 'retired') {
    out(`already retired (home kept: ${doc.home})`)
    return 0
  }

  // §5.7 "deleting a slot shreds its keystore": only api kinds ever hold keys, and shred
  // is a no-op for an absent file — every provider is swept so nothing survives the label.
  let shredded = false
  if (SLOT_KINDS[doc.kind].credential === 'api_key') {
    const keystore = new SlotKeystore(doc.home)
    for (const provider of ALL_PROVIDERS) {
      if (keystore.read(provider) !== undefined) {
        keystore.shred(provider)
        shredded = true
      }
    }
  }

  const at = new Date().toISOString()
  store.atomic(() => {
    const next: StoreDoc = { ...doc, state: 'retired', updatedAt: at }
    delete next.state_reason
    store.slots.save(next)
    appendEvent(store, `slot:${doc.label}`, 'slot_retired', { slotId: doc.id, at }, at)
  })

  // §5.5: the home dir is kept on disk until the user deletes it — printed so they know
  // exactly what remains (and where a vendor login state may still linger).
  out(`retired ${doc.label}${shredded ? '; key shredded' : ''} (home kept: ${doc.home})`)
  return 0
}

type ProbeOutcome = {
  state: 'healthy' | 'degraded'
  engineVersion: string
  reason?: Degraded
  detail?: string
}

/**
 * Capability-drift probe through the slot home env — the compact form of composition.ts's
 * `probeSlotAtStartup`: `probeClaude` under `CLAUDE_CONFIG_DIR=<home>`, then drift against
 * the adapter's required flags plus the two the runtime adds, and the vendor's own auth
 * status (a claude-sub slot that cannot confirm its login never reports healthy, §5.8).
 */
async function probeClaudeHome(run: ProbeRun, slotHome: string): Promise<ProbeOutcome> {
  const env = { CLAUDE_CONFIG_DIR: slotHome }
  let probed: Awaited<ReturnType<typeof probeClaude>>
  try {
    probed = await probeClaude(run, env)
  } catch (error) {
    return {
      state: 'degraded',
      engineVersion: 'unknown',
      reason: 'engine_missing',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  if (probed.capabilities.engine_version === 'unknown') {
    return {
      state: 'degraded',
      engineVersion: 'unknown',
      reason: 'engine_missing',
      detail: 'claude binary not found or reported no version',
    }
  }
  const drift = checkDrift(probed.capabilities, [
    ...REQUIRED_FLAGS,
    '--restricted',
    '--permission-prompt-tool',
  ])
  if (drift.degraded) {
    return {
      state: 'degraded',
      engineVersion: probed.capabilities.engine_version,
      reason: 'engine_unsupported',
      detail: drift.detail,
    }
  }
  if (!probed.auth.logged_in) {
    return {
      state: 'degraded',
      engineVersion: probed.capabilities.engine_version,
      reason: 'auth_expired',
      detail: probed.auth.detail ?? 'not signed in',
    }
  }
  return { state: 'healthy', engineVersion: probed.capabilities.engine_version }
}

/** Looks a slot up by label or by its doc id (`slot_<label>`), whichever the user typed. */
function findSlot(store: SqliteStore, ref: string): SlotDoc | undefined {
  const byId = store.slots.get(`slot_${ref}`)
  if (byId !== undefined) return byId as unknown as SlotDoc
  return (store.slots.list() as unknown as SlotDoc[]).find((doc) => doc.label === ref)
}

/** Appends `type` as the stream's next gap-free event; callers stay inside their transaction. */
function appendEvent(store: SqliteStore, stream: string, type: string, body: Json, at: string): void {
  const seq = (store.events.read(stream).at(-1)?.seq ?? 0) + 1
  const event: DomainEvent = { stream, seq, at, type, body }
  store.events.append(stream, event)
}

/** Fixed-width columns joined by two spaces: header and rows share each column's start. */
function alignTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i]?.length ?? 0)),
  )
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd()
  return [line(headers), ...rows.map(line)]
}
