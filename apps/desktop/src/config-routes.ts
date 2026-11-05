/**
 * M3.3's configuration routes: readiness, connections, policy, models text, repository edits,
 * key replacement, probes, draft apply and backups. One block on purpose, so `server.ts` carries
 * one call. Prompt and model saves are not repeated here: an applied draft runs the same PUT
 * route a manual save does, so validation and the stale refusal have one home each.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Json, ProviderId, Store, StoreDoc } from '@mec/contracts'
import type { SetupDraftRecord } from '@mec/meta'
import { loadPolicy } from '@mec/policy'
import { loadModelsTable } from '@mec/prompts'
import {
  claudeHome,
  codexHome,
  type ProbeRun,
  probeClaudeSlot,
  probeEngineVersion,
  redact,
  SlotKeystore,
} from '@mec/slots'
import type { FastifyInstance } from 'fastify'
import { readPolicy, savePolicy } from './policy-store'
import { buildReadiness, type Readiness, SETUP_DOC_ID, SETUP_STEPS, type SetupStep } from './readiness'
import type { ProbeCmd } from './server'

const WIZARD_ENGINES = ['claude', 'codex', 'opencode'] as const
const BACKUPS_DOC_ID = 'settings/backups'
const DRAFT_PREFIX = 'draft/'
const STATE_RETIRED = 'retired'

/** What Add connection offers: the supported paths, and nothing that is not wired (§5.2, §5.11). */
const CONNECTION_OPTIONS = [
  {
    engine: 'claude',
    paths: ['link', 'sign_in', 'api_key'],
    providers: [{ id: 'anthropic-api', label: 'Anthropic API' }],
  },
  { engine: 'codex', paths: ['sign_in'], providers: [] },
  {
    engine: 'opencode',
    paths: ['api_key'],
    providers: [
      { id: 'glm-api', label: 'GLM Coding Plan' },
      { id: 'gemini-api', label: 'Gemini' },
    ],
  },
] as const

const SIGN_IN_ENGINES = {
  claude: { kind: 'claude-sub', provider: 'anthropic', home: claudeHome },
  codex: { kind: 'codex-sub', provider: 'openai', home: codexHome },
} as const

export type BackupControl = {
  /** Takes one backup now and says where it landed; a failure throws. */
  take():
    | { archivePath: string; excluded: readonly string[] }
    | Promise<{ archivePath: string; excluded: readonly string[] }>
}

export type ConfigDeps = {
  store: Store
  now: () => Date
  keystoreRoot: string
  probeCmd: ProbeCmd
  /** The text this process started with, which is the one in force. */
  policyText: string
  backups?: BackupControl
  /** The shape gate of `POST /api/slots/api-key`, by keystore id. */
  keyShape(provider: string): { pattern: RegExp; shape: string } | undefined
  slotLabel: RegExp
  bootstrapOf(input: unknown): string[]
  checksOf(input: unknown): Array<{ name: string; cmd: string }>
  registerDraftRepository(
    draft: SetupDraftRecord,
  ): Promise<{ ok: true; id: string } | { ok: false; error: string }>
}

export type DraftOutcome =
  | { ok: true; detail?: string }
  | { ok: false; error: string; status?: number; detail?: string }

/** A repository's stale-edit base: what a pin hashes, so an edit that changes nothing is not stale. */
export function repositoryRevision(doc: StoreDoc): string {
  const profile = JSON.stringify({
    bootstrap: doc.bootstrap ?? [],
    checks: doc.checks ?? [],
    trust: doc.trust === true,
  })
  return createHash('sha256').update(profile, 'utf8').digest('hex')
}

function appendEvent(store: Store, stream: string, type: string, body: Json, at: string): void {
  const seq = (store.events.read(stream).at(-1)?.seq ?? 0) + 1
  store.events.append(stream, { stream, seq, at, type, body })
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

function connectionRow(doc: StoreDoc) {
  const identity = doc.identity as { email?: unknown; plan?: unknown } | undefined
  const fingerprint = doc.fingerprint as { provider?: unknown; last4?: unknown } | undefined
  return {
    id: String(doc.id),
    label: String(doc.label ?? ''),
    engine: String(doc.engine ?? ''),
    kind: String(doc.kind ?? ''),
    provider: String(doc.provider ?? ''),
    state: String(doc.state ?? ''),
    linked: doc.linkedDefault === true,
    credential: doc.kind === 'claude-sub' || doc.kind === 'codex-sub' ? 'sign_in' : 'api_key',
    ...(text(doc.state_reason) !== undefined && { stateReason: text(doc.state_reason) }),
    ...(text(doc.engine_version) !== undefined && { engineVersion: text(doc.engine_version) }),
    ...(identity !== undefined && {
      identity: {
        ...(text(identity.email) !== undefined && { email: text(identity.email) }),
        ...(text(identity.plan) !== undefined && { plan: text(identity.plan) }),
      },
    }),
    ...(text(doc.last_probe_at) !== undefined && { lastProbeAt: text(doc.last_probe_at) }),
    ...(fingerprint !== undefined && {
      fingerprint: { provider: String(fingerprint.provider), last4: String(fingerprint.last4) },
    }),
    // No stream records these for a slot yet: null is "no reading", never zero or "off".
    usage: null,
    pin: null,
    pair: null,
  }
}

export function registerConfigRoutes(
  app: FastifyInstance,
  deps: ConfigDeps,
): (draft: SetupDraftRecord, base?: unknown) => Promise<DraftOutcome> {
  const { store, now, keystoreRoot, probeCmd } = deps
  const activeSha256 = loadPolicy(deps.policyText).versionHash

  const engines = async (): Promise<Readiness['engines']> =>
    Promise.all(
      WIZARD_ENGINES.map(async (engine) => {
        const result = await probeCmd(engine, ['--version'])
        const version = result.code === 0 ? (result.stdout.trim().split('\n')[0]?.trim() ?? '') : ''
        return { engine, installed: version !== '', ...(version !== '' && { version }) }
      }),
    )

  // ─── Readiness ────────────────────────────────────────────────────────────────
  app.get('/api/setup/readiness', async () => buildReadiness(store, await engines()))

  app.post('/api/setup/skip', async (request, reply) => {
    const body = (request.body ?? {}) as { step?: unknown; skipped?: unknown }
    const step = body.step as SetupStep
    if (!SETUP_STEPS.includes(step)) {
      reply.code(400).send({ error: `step must be one of ${SETUP_STEPS.join(', ')}` })
      return
    }
    const at = now().toISOString()
    store.atomic(() => {
      const doc = store.engines.get(SETUP_DOC_ID)
      const current = Array.isArray(doc?.skipped) ? doc.skipped.filter((entry) => entry !== step) : []
      const skipped = body.skipped === false ? current : [...current, step]
      store.engines.save({ id: SETUP_DOC_ID, skipped, updatedAt: at })
    })
    return { step, skipped: body.skipped !== false }
  })

  // ─── Connections ──────────────────────────────────────────────────────────────
  app.get('/api/connections', async () => ({
    rows: store.slots
      .list()
      .filter((doc) => doc.state !== STATE_RETIRED)
      .map(connectionRow),
    options: CONNECTION_OPTIONS,
  }))

  // §5.6: a dedicated sign-in needs a slot to land in; the vendor's own card fills its home.
  app.post('/api/slots/dedicated', async (request, reply) => {
    const body = (request.body ?? {}) as { engine?: unknown; label?: unknown }
    const engine = body.engine === 'claude' || body.engine === 'codex' ? body.engine : undefined
    if (engine === undefined) {
      reply.code(400).send({ error: "a dedicated sign-in is for 'claude' or 'codex'" })
      return
    }
    const label = typeof body.label === 'string' ? body.label.trim() : ''
    if (label === '..' || !deps.slotLabel.test(label)) {
      reply.code(400).send({ error: 'invalid slot label: expected a single path segment' })
      return
    }
    const id = `slot_${label}`
    if (store.slots.get(id) !== undefined) {
      reply.code(409).send({ error: 'a slot with that label already exists — retire it first' })
      return
    }
    const spec = SIGN_IN_ENGINES[engine]
    const home = spec.home(keystoreRoot, label)
    const at = now().toISOString()
    store.atomic(() => {
      store.slots.save({
        id,
        label,
        engine,
        kind: spec.kind,
        provider: spec.provider,
        home: home.homeDir,
        state: 'home_ready',
        createdAt: at,
        updatedAt: at,
      })
      appendEvent(store, `slot:${label}`, 'slot_created', { slotId: id, label, kind: spec.kind, at }, at)
    })
    return { id, label, engine, kind: spec.kind, state: 'home_ready' }
  })

  // §5.6 Verified, §5.8: the engine's own local status command inside the slot's env. It spends no
  // tokens and MEC reads no credential: the vendor's CLI answers, and only its non-secret identity is kept.
  app.post('/api/slots/:id/probe', async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? '')
    const doc = store.slots.get(id)
    if (doc === undefined) {
      reply.code(404).send({ error: 'slot not found' })
      return
    }
    if (doc.state === STATE_RETIRED) {
      reply.code(409).send({ error: 'slot is retired' })
      return
    }
    if (doc.kind !== 'claude-sub' && doc.kind !== 'codex-sub') {
      reply.code(400).send({ error: 'an API-key slot uses Validate, not a local probe' })
      return
    }
    const outcome =
      doc.engine === 'claude' ? await probeClaude(probeCmd, doc) : await probeCodex(probeCmd, doc)
    const at = now().toISOString()
    store.atomic(() => {
      const next: StoreDoc = {
        ...doc,
        state: outcome.state,
        last_probe_at: at,
        updatedAt: at,
        ...(outcome.identity !== undefined && { identity: outcome.identity }),
        ...(outcome.version !== undefined && { engine_version: outcome.version }),
      }
      if (outcome.reason !== undefined) next.state_reason = outcome.reason
      else delete next.state_reason
      store.slots.save(next)
      appendEvent(
        store,
        `slot:${String(doc.label)}`,
        outcome.state === 'healthy' ? 'slot_healthy' : 'slot_degraded',
        { slotId: id, ...(outcome.reason !== undefined && { reason: outcome.reason }), at },
        at,
      )
    })
    return {
      ok: outcome.state === 'healthy',
      state: outcome.state,
      ...(outcome.reason !== undefined && { reason: outcome.reason }),
    }
  })

  // What a retire would touch, from docs already saved, for the arm step to name.
  app.get('/api/slots/:id/impact', async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? '')
    const doc = store.slots.get(id)
    if (doc === undefined) {
      reply.code(404).send({ error: 'slot not found' })
      return
    }
    const attempts = store.attempts.list().filter((attempt) => attempt.slotId === id)
    return {
      slotId: id,
      label: String(doc.label ?? ''),
      running: attempts.filter((attempt) => attempt.state === 'running').length,
      queued: attempts.filter((attempt) => attempt.state === 'queued').length,
      metaSlot: store.engines.get('settings/meta-slot')?.slotId === id,
      keyStored: doc.fingerprint !== undefined,
    }
  })

  // §5.7 "rotating a key replaces the keystore file and re-probes". Same gate as the courier, the
  // key goes straight to the keystore, and the answer carries identity and fingerprint only.
  app.post('/api/slots/:id/key', async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? '')
    const doc = store.slots.get(id)
    if (doc === undefined) {
      reply.code(404).send({ error: 'slot not found' })
      return
    }
    if (doc.state === STATE_RETIRED) {
      reply.code(409).send({ error: 'slot is retired' })
      return
    }
    const provider = String(doc.provider ?? '')
    const shape = deps.keyShape(provider)
    if (shape === undefined || doc.fingerprint === undefined) {
      reply.code(400).send({ error: 'this slot holds no key to replace' })
      return
    }
    const body = (request.body ?? {}) as { key?: unknown }
    const key = typeof body.key === 'string' ? body.key.trim() : ''
    if (!shape.pattern.test(key)) {
      reply.code(400).send({ error: `key does not match the ${provider} shape (${shape.shape})` })
      return
    }
    const fingerprint = new SlotKeystore(String(doc.home)).rotate(provider as ProviderId, key)
    const at = now().toISOString()
    store.atomic(() => {
      store.slots.save({ ...doc, fingerprint, updatedAt: at })
      appendEvent(store, `slot:${String(doc.label)}`, 'slot_key_rotated', { slotId: id, fingerprint, at }, at)
    })
    const probed = await app.inject({ method: 'POST', url: `/api/slots/${encodeURIComponent(id)}/validate` })
    const verdict = probed.json() as { ok?: boolean; reason?: string }
    return {
      id,
      fingerprint: { provider: fingerprint.provider, last4: fingerprint.last4 },
      probe: {
        ok: verdict.ok === true,
        ...(verdict.reason !== undefined && { reason: verdict.reason }),
      },
    }
  })

  // ─── Policy ───────────────────────────────────────────────────────────────────
  app.get('/api/policy', async () => {
    const record = readPolicy(store, deps.policyText)
    return { ...record, activeSha256, restartRequired: record.sha256 !== activeSha256 }
  })

  app.put('/api/policy', async (request, reply) => {
    const body = (request.body ?? {}) as { text?: unknown; base_sha256?: unknown }
    if (typeof body.text !== 'string' || typeof body.base_sha256 !== 'string' || body.base_sha256 === '') {
      reply.code(400).send({ error: 'text and base_sha256 are required' })
      return
    }
    const outcome = savePolicy(store, {
      text: body.text,
      baseSha256: body.base_sha256,
      fallbackText: deps.policyText,
      at: now().toISOString(),
      origin: 'panel',
    })
    if (outcome.status === 'invalid') {
      reply.code(400).send({ error: 'invalid_policy', detail: outcome.detail })
      return
    }
    if (outcome.status === 'stale') {
      reply.code(409).send({ error: 'stale_base', current_sha256: outcome.currentSha256 })
      return
    }
    return { sha256: outcome.record.sha256, revision: outcome.record.revision }
  })

  // ─── Models text ──────────────────────────────────────────────────────────────
  // `GET /api/models` answers the parsed table; an editor needs the words a save replaces.
  app.get('/api/models/text', async (_request, reply) => {
    try {
      const { provenance } = loadModelsTable({ userPath: join(keystoreRoot, 'models.yaml') })
      return {
        yaml: readFileSync(provenance.path, 'utf8'),
        sha256: provenance.sha256,
        source: provenance.source,
      }
    } catch (error) {
      reply.code(500).send({
        error: 'models table invalid',
        detail: error instanceof Error ? error.message : String(error),
      })
      return
    }
  })

  // ─── Repository edit ──────────────────────────────────────────────────────────
  // §14: bootstrap, checks and trust, never the URL. Work already admitted reads its pin (M1.2).
  app.patch('/api/repositories/:id', async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? '')
    const doc = id.startsWith('repo_') ? store.engines.get(id) : undefined
    if (doc === undefined) {
      reply.code(404).send({ error: 'repository not found' })
      return
    }
    const body = (request.body ?? {}) as {
      base_revision?: unknown
      bootstrapCmds?: unknown
      checkCmds?: unknown
      trusted?: unknown
    }
    if (typeof body.base_revision !== 'string' || body.base_revision === '') {
      reply.code(400).send({ error: 'base_revision is required' })
      return
    }
    if (body.trusted !== undefined && typeof body.trusted !== 'boolean') {
      reply.code(400).send({ error: 'trusted must be a boolean' })
      return
    }
    let bootstrap: string[] | undefined
    let checks: Array<{ name: string; cmd: string }> | undefined
    try {
      if (body.bootstrapCmds !== undefined) bootstrap = deps.bootstrapOf(body.bootstrapCmds)
      if (body.checkCmds !== undefined) checks = deps.checksOf(body.checkCmds)
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid repository payload' })
      return
    }
    const current = repositoryRevision(doc)
    if (body.base_revision !== current) {
      reply.code(409).send({ error: 'stale_base', current_revision: current })
      return
    }
    const trust = typeof body.trusted === 'boolean' ? body.trusted : doc.trust === true
    const changed = [
      ...(bootstrap !== undefined ? ['bootstrap'] : []),
      ...(checks !== undefined ? ['checks'] : []),
      ...(trust !== (doc.trust === true) ? ['trust'] : []),
    ]
    const at = now().toISOString()
    const next: StoreDoc = {
      ...doc,
      ...(bootstrap !== undefined && { bootstrap }),
      ...(checks !== undefined && { checks }),
      trust,
      updatedAt: at,
    }
    store.atomic(() => {
      store.engines.save(next)
      appendEvent(
        store,
        'repositories',
        'repository_updated',
        {
          repositoryId: id,
          changed,
          ...(changed.includes('trust') && { trust: { from: !trust, to: trust } }),
          at,
        },
        at,
      )
    })
    return { id, revision: repositoryRevision(next) }
  })

  // ─── Setup drafts ─────────────────────────────────────────────────────────────
  const settle = (id: string, doc: StoreDoc, status: 'applied' | 'denied'): void => {
    const at = now().toISOString()
    store.atomic(() => {
      store.engines.save({ ...doc, status, resolvedAt: at })
      appendEvent(store, 'setup', `draft_${status}`, { draftId: id, target: String(doc.target), at }, at)
    })
  }

  const policyTextOf = (draft: SetupDraftRecord): string | undefined => {
    const { patch } = draft
    if (typeof patch.text === 'string') return patch.text
    if (typeof patch.policy === 'string') return patch.policy
    const fields = Object.fromEntries(
      Object.entries(patch).filter(([key]) =>
        ['preAuthorised', 'capsOverride', 'repoTightening'].includes(key),
      ),
    )
    if (Object.keys(fields).length === 0) return undefined
    const current = JSON.parse(readPolicy(store, deps.policyText).text) as Record<string, unknown>
    return JSON.stringify({ ...current, ...fields }, null, 2)
  }

  /** Answers as the save route answered: its status and its refusal, unchanged. */
  const viaRoute = async (
    method: 'PUT',
    url: string,
    payload: Record<string, unknown>,
  ): Promise<DraftOutcome> => {
    const res = await app.inject({ method, url, payload })
    if (res.statusCode === 200) return { ok: true }
    const body = res.json() as { error?: string; detail?: string }
    return {
      ok: false,
      status: res.statusCode,
      error: body.error ?? 'the save was refused',
      ...(body.detail !== undefined && { detail: body.detail }),
    }
  }

  const applyDraft = async (draft: SetupDraftRecord, base?: unknown): Promise<DraftOutcome> => {
    if (draft.target === 'repository') return deps.registerDraftRepository(draft)
    // A yes in chat carries no base. These apply from Settings, where the owner sees what they replace.
    if (base === undefined) {
      return { ok: false, status: 400, error: `apply this ${draft.target} draft from Settings` }
    }
    if (draft.target === 'policy') {
      const proposed = policyTextOf(draft)
      if (proposed === undefined) return { ok: false, status: 400, error: 'the draft carries no policy text' }
      const saved = savePolicy(store, {
        text: proposed,
        baseSha256: String(base),
        fallbackText: deps.policyText,
        at: now().toISOString(),
        origin: 'draft',
      })
      if (saved.status === 'saved') return { ok: true }
      return saved.status === 'stale'
        ? { ok: false, status: 409, error: 'stale_base' }
        : { ok: false, status: 400, error: 'invalid_policy', detail: saved.detail }
    }
    if (draft.target === 'prompts') {
      const { patch } = draft
      const parts = Array.isArray(patch.parts)
        ? patch.parts
        : typeof patch.path === 'string' && typeof patch.text === 'string'
          ? [{ path: patch.path, text: patch.text }]
          : undefined
      if (parts === undefined) return { ok: false, status: 400, error: 'the draft carries no prompt parts' }
      return viaRoute('PUT', '/api/prompts', { base_revision: base, origin: 'agent', parts })
    }
    if (typeof draft.patch.yaml !== 'string') {
      return { ok: false, status: 400, error: 'the draft carries no models table' }
    }
    return viaRoute('PUT', '/api/models', { yaml: draft.patch.yaml, base_sha256: String(base) })
  }

  /** Two quick clicks are one apply: a repository draft has no base to refuse the second. */
  const applying = new Set<string>()

  app.post('/api/setup/drafts/:id/apply', async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? '')
    const doc = store.engines.get(`${DRAFT_PREFIX}${id}`)
    if (doc === undefined) {
      reply.code(404).send({ error: 'draft not found' })
      return
    }
    if (doc.status !== 'pending' || applying.has(id)) {
      reply.code(409).send({ error: 'draft_settled', status: String(doc.status) })
      return
    }
    const { base } = (request.body ?? {}) as { base?: unknown }
    applying.add(id)
    try {
      const outcome = await applyDraft({ ...(doc as unknown as SetupDraftRecord), id }, base)
      if (!outcome.ok) {
        const status = 'status' in outcome && outcome.status !== undefined ? outcome.status : 400
        reply.code(status).send({
          error: outcome.error,
          ...('detail' in outcome && outcome.detail !== undefined && { detail: outcome.detail }),
        })
        return
      }
      settle(id, doc, 'applied')
      return { id, status: 'applied' }
    } finally {
      applying.delete(id)
    }
  })

  app.post('/api/setup/drafts/:id/dismiss', async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? '')
    const doc = store.engines.get(`${DRAFT_PREFIX}${id}`)
    if (doc === undefined) {
      reply.code(404).send({ error: 'draft not found' })
      return
    }
    if (doc.status !== 'pending') {
      reply.code(409).send({ error: 'draft_settled', status: String(doc.status) })
      return
    }
    settle(id, doc, 'denied')
    return { id, status: 'denied' }
  })

  // ─── Backups ──────────────────────────────────────────────────────────────────
  const backups = deps.backups
  if (backups !== undefined) {
    const NOTE = 'Archives stay in the backups folder of the MEC data directory. There is no schedule yet.'
    const EXCLUDED = 'Slot keys, vendor sign-in files and lock files are left out by rule.'

    app.get('/api/backups', async () => {
      const doc = store.engines.get(BACKUPS_DOC_ID)
      return {
        ...(typeof doc?.lastAt === 'string' && { lastAt: doc.lastAt }),
        ...(typeof doc?.archive === 'string' && { archive: doc.archive }),
        note: NOTE,
        excluded: EXCLUDED,
      }
    })

    app.post('/api/backups', async (_request, reply) => {
      let archive: string
      try {
        const taken = await backups.take()
        archive = taken.archivePath.split('/').at(-1) ?? taken.archivePath
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        reply.code(500).send({ error: 'backup_failed', detail: redact(detail, [], []) })
        return
      }
      const at = now().toISOString()
      store.atomic(() => {
        store.engines.save({ id: BACKUPS_DOC_ID, lastAt: at, archive, updatedAt: at })
        appendEvent(store, 'backups', 'backup_taken', { archive, at }, at)
      })
      return { status: 'done', lastAt: at, archive }
    })
  }

  return applyDraft
}

type ProbeOutcome = {
  state: 'healthy' | 'degraded'
  reason?: string
  identity?: { email?: string; plan?: string }
  version?: string
}

function runnerOf(probeCmd: ProbeCmd): ProbeRun {
  return async (cmd, args, env) => {
    const result = await probeCmd(cmd, args, { env })
    if (result.code === -1 || result.code === 127) throw new Error('engine missing')
    return result
  }
}

async function probeClaude(probeCmd: ProbeCmd, doc: StoreDoc): Promise<ProbeOutcome> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value
  }
  // §5.3: the default home is "the variable unset", never the variable pointed at it.
  if (doc.linkedDefault === true) delete env.CLAUDE_CONFIG_DIR
  else env.CLAUDE_CONFIG_DIR = String(doc.home)
  const run = runnerOf(probeCmd)
  const probed = await probeClaudeSlot(run, env)
  const version = await probeEngineVersion(run, env)
  return {
    state: probed.state === 'healthy' ? 'healthy' : 'degraded',
    ...(probed.reason !== undefined && { reason: probed.reason }),
    ...(probed.identity !== undefined && { identity: probed.identity }),
    ...(version !== 'engine_missing' && { version }),
  }
}

async function probeCodex(probeCmd: ProbeCmd, doc: StoreDoc): Promise<ProbeOutcome> {
  const home = String(doc.home)
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 })
  const result = await probeCmd('codex', ['login', 'status'], {
    env: { ...process.env, CODEX_HOME: home },
  })
  if (result.code === -1 || result.code === 127) return { state: 'degraded', reason: 'engine_missing' }
  return result.code === 0 ? { state: 'healthy' } : { state: 'degraded', reason: 'auth_expired' }
}
