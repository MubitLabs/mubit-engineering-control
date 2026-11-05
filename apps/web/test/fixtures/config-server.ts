/**
 * A small sample server for the configuration harness. Payloads are raw, as the real routes answer
 * them, so they pass through the same decoders. It keeps the rules a screen depends on: the stale
 * base refusal and the retire label. SAMPLE-ONLY: nothing here reaches the product.
 */

const MARK = 'SAMPLE-ONLY'
const hash = (text: string): string => `${text.length.toString(16).padStart(8, '0')}sample00000000`

type Slot = Record<string, unknown> & { id: string; label: string; state: string }

const ALWAYS_CONFIRM = "class 'pr_merge' is always-confirm (§13) and can never be pre-authorised"

export function sampleServer({
  fail,
  empty,
  noChecks = false,
}: {
  fail: string[]
  empty: boolean
  noChecks?: boolean
}) {
  let policyText = '{\n  "preAuthorised": {}\n}\n'
  let policyRevision = 0
  let modelsYaml = `# ${MARK}\ntiers: [fast, balanced]\n`
  let revision = 0
  const overrides = new Map<string, string>()
  let paused = false
  let lastBackup: string | undefined
  const slots: Slot[] = empty
    ? []
    : [
        {
          id: 'slot_sample-max',
          label: 'sample-max',
          engine: 'claude',
          kind: 'claude-sub',
          provider: 'anthropic',
          state: 'healthy',
          linked: false,
          credential: 'sign_in',
          engineVersion: '2.1.317',
          identity: { email: 'sample@example.test', plan: 'max' },
          lastProbeAt: '2026-11-05T09:00:00.000Z',
          usage: null,
          pin: null,
          pair: null,
        },
        {
          id: 'slot_sample-expired',
          label: 'sample-expired',
          engine: 'claude',
          kind: 'claude-sub',
          provider: 'anthropic',
          state: 'degraded',
          stateReason: 'auth_expired',
          linked: false,
          credential: 'sign_in',
          usage: null,
          pin: null,
          pair: null,
        },
        {
          id: 'slot_sample-key',
          label: 'sample-key',
          engine: 'opencode',
          kind: 'opencode-glm',
          provider: 'zai-coding-plan',
          state: 'login_pending',
          linked: false,
          credential: 'api_key',
          fingerprint: { provider: 'zai-coding-plan', last4: 'abcd' },
          usage: null,
          pin: null,
          pair: null,
        },
      ]
  const repositories = empty
    ? []
    : [
        {
          id: 'repo_sample',
          url: '/sample/console',
          bootstrap: ['pnpm install'],
          checks: noChecks ? [] : [{ name: 'test', cmd: 'pnpm test' }],
          trust: false,
          revision: 'r1',
        },
      ]
  const drafts = empty
    ? []
    : [
        {
          id: 'draft_sample',
          target: 'policy',
          reason: 'Sample proposal from setup chat',
          diff: 'target: policy\npatch:\n  preAuthorised: {}',
          status: 'pending',
          createdAt: '2026-11-05T09:00:00.000Z',
        },
      ]
  const options = [
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
  ]
  const parts = [
    { path: 'shared/rules.md', layer: 'shared', name: 'rules', text: `${MARK} shared text\nline two` },
    { path: 'roles/sample.md', layer: 'role', name: 'sample', text: `${MARK} role text` },
  ]

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const readiness = () => {
    const usable = slots.some((slot) => slot.state === 'healthy' && slot.kind === 'claude-sub')
    const repositoryReady = repositories.some((repository) => repository.checks.length > 0)
    return {
      steps: [
        { id: 'engines', title: 'Engines', status: 'done', detail: 'Found claude 2.1.317.', next: null },
        {
          id: 'connection',
          title: 'Connection',
          status: usable ? 'done' : 'missing',
          detail: usable
            ? '1 usable connection.'
            : slots.length > 0
              ? 'A connection exists, but none has passed a health check.'
              : 'No connection yet.',
          next: usable ? null : { label: 'Open Connections', route: 'slots' },
        },
        {
          id: 'repository',
          title: 'Repository',
          status: repositoryReady ? 'done' : 'missing',
          detail: repositoryReady ? 'Has a check profile.' : 'No repository yet.',
          next: repositoryReady
            ? null
            : repositories.length > 0
              ? { label: 'Open Repositories', route: 'settings' }
              : { label: 'Add a repository', route: 'setup' },
        },
        {
          id: 'meta_slot',
          title: 'Meta agent',
          status: 'missing',
          detail: 'No slot chosen yet.',
          next: { label: 'Choose a slot', route: 'setup' },
        },
        {
          id: 'first_request',
          title: 'First request',
          status: 'missing',
          detail: 'No request yet.',
          next: { label: 'Open Conversation', route: 'chat' },
        },
      ],
      engines: [
        { engine: 'claude', installed: true, version: '2.1.317' },
        { engine: 'codex', installed: false },
        { engine: 'opencode', installed: false },
      ],
      metaCandidates: slots.map((slot) => ({
        id: slot.id,
        label: slot.label,
        engine: slot.engine,
        kind: slot.kind,
        state: slot.state,
        usable: slot.state === 'healthy' && slot.kind === 'claude-sub',
        ...(slot.state === 'healthy' ? {} : { reason: `${slot.label} is not healthy` }),
      })),
      metaSlotId: null,
      finish: { enabled: false, reason: 'Meta agent is still needed: No slot chosen yet.' },
      completion: null,
    }
  }

  const policy = () => ({
    text: policyText,
    sha256: hash(policyText),
    revision: policyRevision,
    source: policyRevision === 0 ? 'default' : 'saved',
    activeSha256: hash('{\n  "preAuthorised": {}\n}\n'),
    restartRequired: policyRevision > 0,
  })

  // Drawn from the policy as it stands, as the real route draws it, unless a test froze the answer.
  const draftsNow = () =>
    drafts.map((draft) => ({
      ...draft,
      preview: {
        base: hash(policyText),
        changes: [
          {
            label: 'Policy file',
            before: policyText.trimEnd(),
            after: '{\n  "preAuthorised": {\n    "install": [\n      "repo_prop"\n    ]\n  }\n}',
          },
        ],
      },
    }))
  let frozenDrafts: ReturnType<typeof draftsNow> | null = null

  return {
    /** Another tab saved: the next save from this page is stale. */
    saveElsewhere() {
      policyText = '{\n  "preAuthorised": {},\n  "capsOverride": {}\n}\n'
      policyRevision += 1
    },

    /** The proposals answer as they stand now, whatever is saved next. */
    freezeDrafts() {
      frozenDrafts = draftsNow()
    },

    respond(path: string, method: string, rawBody: unknown): Response {
      const body = (typeof rawBody === 'string' ? JSON.parse(rawBody) : {}) as Record<string, unknown>
      if (fail.includes(path)) return json({ error: 'sample failure' }, 500)
      const route = `${method} ${path}`

      if (route === 'GET /api/status') {
        return json({
          runtime: { state: paused ? 'paused' : 'ready', instances: 1, answering: true },
          parts: {},
          setup: { has_slot: slots.length > 0, has_repository: repositories.length > 0 },
          capabilities: { switchWork: false, drain: false, backups: true, isolationEdit: false, pause: true },
        })
      }
      if (route === 'GET /api/processing') return json({ paused })
      if (route === 'POST /api/processing/pause') {
        paused = true
        return json({ status: 'paused' })
      }
      if (route === 'POST /api/processing/resume') {
        paused = false
        return json({ status: 'running' })
      }
      if (route === 'GET /api/chat/messages' || route === 'GET /api/work') return json([])
      if (route === 'GET /api/repositories') return json(repositories)
      if (route === 'GET /api/setup/readiness') return json(readiness())
      if (route === 'GET /api/connections') return json({ rows: slots, options })
      if (route === 'GET /api/setup/drafts') return json(frozenDrafts ?? draftsNow())
      // The one sample proposal asks for what no policy may hold, so Apply shows a refusal.
      if (route === 'POST /api/setup/drafts/draft_sample/apply') {
        if (body.base !== hash(policyText)) return json({ error: 'stale_base' }, 409)
        return json({ error: 'invalid_policy', detail: ALWAYS_CONFIRM }, 400)
      }
      if (route === 'POST /api/slots/dedicated') {
        const label = String(body.label)
        slots.push({
          id: `slot_${label}`,
          label,
          engine: String(body.engine),
          kind: 'claude-sub',
          provider: 'anthropic',
          state: 'home_ready',
          linked: false,
          credential: 'sign_in',
          usage: null,
          pin: null,
          pair: null,
        })
        return json({ id: `slot_${label}`, state: 'home_ready' })
      }
      if (route === 'POST /api/slots/login') return json({ id: 'card_sample', busy: false })
      if (route === 'GET /api/policy') return json(policy())
      if (route === 'PUT /api/policy') {
        if (body.base_sha256 !== hash(policyText)) return json({ error: 'stale_base' }, 409)
        if (String(body.text).includes('pr_merge')) {
          return json({ error: 'invalid_policy', detail: ALWAYS_CONFIRM }, 400)
        }
        policyText = String(body.text)
        policyRevision += 1
        return json({ sha256: hash(policyText), revision: policyRevision })
      }
      if (route === 'GET /api/models/text') {
        return json({ yaml: modelsYaml, sha256: hash(modelsYaml), source: 'default' })
      }
      if (route === 'PUT /api/models') {
        if (body.base_sha256 !== hash(modelsYaml)) return json({ error: 'stale_base' }, 409)
        if (String(body.yaml).includes('[unterminated')) {
          return json({ error: 'invalid models table', detail: 'line 1: unterminated flow sequence' }, 400)
        }
        modelsYaml = String(body.yaml)
        return json({ provenance: { source: 'user', path: '/sample', sha256: hash(modelsYaml) } })
      }
      if (route === 'GET /api/prompts') {
        return json({
          revision,
          parts: parts.map((part) => ({
            id: part.path,
            layer: part.layer,
            name: part.name,
            edited: overrides.has(part.path),
            defaultUpdated: false,
            provenance: overrides.has(part.path) ? 'user override' : 'shipped default',
          })),
          overrides: [...overrides].map(([partPath, text]) => ({ path: partPath, text })),
        })
      }
      if (route === 'GET /api/prompts/defaults') return json({ parts })
      if (route === 'PUT /api/prompts') {
        if (body.base_revision !== revision) return json({ error: 'stale_base' }, 409)
        for (const part of body.parts as Array<{ path: string; text: string }>) {
          overrides.set(part.path, part.text)
        }
        revision += 1
        return json({ revision })
      }
      if (route === 'GET /api/backups') {
        return json({
          ...(lastBackup !== undefined && { lastAt: lastBackup }),
          note: 'Sample backup note.',
          excluded: 'Sample exclusions.',
        })
      }
      if (route === 'POST /api/backups') {
        lastBackup = '2026-11-05T10:00:00.000Z'
        return json({ status: 'done', lastAt: lastBackup, archive: 'sample.tgz' })
      }

      const impact = /^\/api\/slots\/([^/]+)\/impact$/.exec(path)
      if (method === 'GET' && impact) {
        const slot = slots.find((entry) => entry.id === impact[1])
        return json({
          slotId: slot?.id,
          label: slot?.label,
          running: 1,
          queued: 2,
          metaSlot: false,
          keyStored: slot?.credential === 'api_key',
        })
      }
      const retire = /^\/api\/slots\/([^/]+)\/retire$/.exec(path)
      if (method === 'POST' && retire) {
        const index = slots.findIndex((entry) => entry.id === retire[1])
        if (body.label !== slots[index]?.label) return json({ error: 'label_mismatch' }, 400)
        slots.splice(index, 1)
        return json({ id: retire[1], state: 'retired' })
      }
      const repository = /^\/api\/repositories\/([^/]+)$/.exec(path)
      if (method === 'PATCH' && repository) {
        const repo = repositories.find((entry) => entry.id === repository[1])
        if (repo === undefined) return json({ error: 'repository not found' }, 404)
        if (body.base_revision !== repo.revision) return json({ error: 'stale_base' }, 409)
        if (typeof body.trusted === 'boolean') repo.trust = body.trusted
        if (Array.isArray(body.bootstrapCmds)) repo.bootstrap = body.bootstrapCmds as string[]
        repo.revision = `${repo.revision}x`
        return json({ id: repo.id, revision: repo.revision })
      }
      return json({ error: 'not found' }, 404)
    },
  }
}
