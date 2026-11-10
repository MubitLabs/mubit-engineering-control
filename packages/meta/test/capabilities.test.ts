// What each connection's worker can run, as planning and placement see it (owner's horse tinder
// test, 9 November 2026, wi_mw9kvv161fy597y): a task whose objective said "load index.html in a
// real browser (headless Chromium via Playwright/Puppeteer)" was placed on an OpenCode slot,
// where MEC refuses every shell command, and its attempt could only report blocked.
import type { StoreDoc } from '@mec/contracts'
import { DEFAULT_CAPS, type SlotModelsView, type WorkerReach } from '@mec/domain'
import { MemoryRepositories } from '@mec/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import {
  compilePlannerContext,
  FollowUps,
  MetaAgentService,
  type PlacementTable,
  type PlannerContextInput,
  repoFields,
  type SchedulerDeps,
  schedulePass,
} from '../src'
import type { PlannerTools } from '../src/tools'

const AT = '2026-11-09T18:42:31.689Z'
const NOW = () => AT
const REPO = 'repo_a'
const POLICY = '{"preAuthorised":{}}'

const NO_SHELL: WorkerReach = { commands: false, edits: true, network: false }
const SHELL: WorkerReach = { commands: true, edits: true, network: false }

const BROWSER_CHECK =
  'In app.js, rename the global `top`. Then actually load index.html in a real browser (e.g. headless Chromium via Playwright/Puppeteer) and verify with no console errors.'
const EDIT_ONLY = 'In app.js, rename the global `top` to topCard and update both call sites.'

const TABLE = {
  tiers: ['fast', 'balanced', 'strong', 'frontier'],
  engines: {
    opencode: {
      select: { flag: '--model' },
      providers: {
        'zai-coding-plan': {
          models: {
            'glm-5.3': { tier: 'balanced', vendor_says: 'x' },
            'glm-5.3-flash': { tier: 'fast', vendor_says: 'x' },
          },
        },
      },
    },
    codex: { select: { flag: '-m' }, models: { 'gpt-x': { tier: 'balanced', vendor_says: 'x' } } },
  },
  routing: { subagents: {} },
}

const MARKS = {
  slot_glm: { 'zai-coding-plan/glm-5.3': 'available', 'zai-coding-plan/glm-5.3-flash': 'available' },
  slot_codex: { 'gpt-x': 'available' },
} as const

afterEach(() => {
  delete process.env.MEC_FAKE_ENGINE
})

// ── The planner's context and its tools, through the service ────────────────────────────────

function serviceRig(reach: Record<string, WorkerReach> | undefined) {
  process.env.MEC_FAKE_ENGINE = '1'
  const store = new MemoryRepositories()
  store.atomic(() => {
    store.engines.save({ id: REPO, url: 'https://example.test/a', bootstrap: [], checks: [], trust: true })
    store.slots.save({ id: 'slot_glm', engine: 'opencode', provider: 'zai-coding-plan', state: 'healthy' })
    store.slots.save({ id: 'slot_codex', engine: 'codex', state: 'healthy' })
  })
  const seen: { tools?: PlannerTools; snapshot?: PlannerContextInput } = {}
  const service = new MetaAgentService({
    store,
    effects: store.effects,
    now: NOW,
    brain: async (input) => {
      seen.tools = input.tools
      seen.snapshot = input.snapshot
      return { ack: 'noted' }
    },
    modelsTable: () => ({ table: TABLE, provenance: { sha256: 'x', origin: 'default' } }) as never,
    marks: () => MARKS as never,
    ...(reach !== undefined && { reach: () => reach }),
  })
  return { service, seen }
}

// `null` is a service with no reach supplier: an `undefined` argument would take the default.
async function turn(reach: Record<string, WorkerReach> | null = { slot_glm: NO_SHELL, slot_codex: SHELL }) {
  const rig = serviceRig(reach ?? undefined)
  await rig.service.onUserMessage({ messageId: 'msg_1', text: 'fix it', repoId: REPO })
  return rig.seen
}

const propose = (tools: PlannerTools | undefined, task: Record<string, unknown>) =>
  tools?.execute('propose_plan', {
    work_item: 'wi_turn',
    tasks: [
      {
        id: 'task_fix_top',
        role: 'implementer',
        model_request: { tier: 'balanced', reason: 'small fix' },
        ...task,
      },
    ],
  }) as { ok: boolean; issues?: string[] }

describe("the planner's context names what each connection can run", () => {
  it('an OpenCode slot reads as editing files with no commands, a sandboxed one as running them', async () => {
    const { snapshot } = await turn()
    const text = compilePlannerContext(snapshot as PlannerContextInput)
    const glm = text.split('\n').find((line) => line.startsWith('- slot_glm '))
    const codex = text.split('\n').find((line) => line.startsWith('- slot_codex '))
    expect(glm).toContain('opencode')
    expect(glm).toContain('edits files; cannot run commands')
    expect(codex).toContain('edits files; runs commands, no network')
  })

  it('a slot with nothing recorded claims nothing', async () => {
    const { snapshot } = await turn(null)
    const text = compilePlannerContext(snapshot as PlannerContextInput)
    expect(text).not.toContain('commands')
  })
})

describe('a plan task that needs commands', () => {
  it('pinned to a slot that cannot run them is refused with a plain reason', async () => {
    const { tools } = await turn()
    const result = propose(tools, { objective: BROWSER_CHECK, slot_hint: { slot_id: 'slot_glm' } })
    expect(result.ok).toBe(false)
    const said = result.issues?.join('\n') ?? ''
    expect(said).toContain("task 'task_fix_top'")
    expect(said).toContain('"browser"')
    expect(said).toContain("slot 'slot_glm' (opencode) cannot run commands")
    expect(said).toContain('slot_codex')
  })

  it('pinned to a slot that can run them is accepted', async () => {
    const { tools } = await turn()
    const result = propose(tools, { objective: BROWSER_CHECK, slot_hint: { slot_id: 'slot_codex' } })
    expect(result).toMatchObject({ ok: true })
  })

  it('with no pin is accepted: placement takes it to a slot that can', async () => {
    const { tools } = await turn()
    expect(propose(tools, { objective: BROWSER_CHECK })).toMatchObject({ ok: true })
  })

  it('an edit-only task pinned to the slot with no shell is accepted, acceptance checks or not', async () => {
    const { tools } = await turn()
    const result = propose(tools, {
      objective: EDIT_ONLY,
      slot_hint: { slot_id: 'slot_glm' },
      acceptance_checks: ['manual-review'],
    })
    expect(result).toMatchObject({ ok: true })
  })

  it('where no connection can run commands is refused, saying MEC still runs the checks', async () => {
    const { tools } = await turn({ slot_glm: NO_SHELL, slot_codex: NO_SHELL })
    const result = propose(tools, { objective: BROWSER_CHECK })
    expect(result.ok).toBe(false)
    const said = result.issues?.join('\n') ?? ''
    expect(said).toContain('no connection here can run commands')
    expect(said).toContain('MEC runs the acceptance checks itself')
  })

  it('whose tier is served only where commands cannot run is refused; an edit-only one is not', async () => {
    const { tools } = await turn()
    const fast = (objective: string) =>
      propose(tools, { objective, model_request: { tier: 'fast', reason: 'mechanical' } })
    const refused = fast(BROWSER_CHECK)
    expect(refused.ok).toBe(false)
    expect(refused.issues?.join('\n') ?? '').toContain(
      "tier 'fast' is served only by connections that cannot run commands",
    )
    expect(fast(EDIT_ONLY)).toMatchObject({ ok: true })
  })
})

// ── Placement ──────────────────────────────────────────────────────────────────────────────

const view = (slotId: string, engine: string, reach: WorkerReach | undefined, utilisation: number) =>
  ({
    slotId,
    engine,
    healthy: true,
    marks: {},
    concurrency: 2,
    utilisation,
    ...(reach !== undefined && { reach }),
  }) as SlotModelsView

function schedulerRig(views: SlotModelsView[]) {
  const store = new MemoryRepositories()
  store.atomic(() => {
    store.engines.save({
      id: REPO,
      url: 'https://example.test/a',
      bootstrap: [],
      checks: [],
      trust: true,
      hostRunAgreedAt: AT,
    })
    store.workItems.save({
      id: 'wi_1',
      state: 'executing',
      mandate: { originMessageId: 'msg_1', status: 'active' },
      ...repoFields(store, REPO, POLICY),
    })
  })
  const deps: SchedulerDeps = {
    store,
    effects: store.effects,
    caps: DEFAULT_CAPS,
    slots: () => views,
    table: () => TABLE as unknown as PlacementTable,
    followups: new FollowUps({ store, effects: store.effects, now: NOW }),
  }
  const addTask = (id: string, extra: StoreDoc) =>
    store.atomic(() =>
      store.tasks.save({
        id,
        workItemId: 'wi_1',
        repoId: REPO,
        role: 'implementer',
        status: 'ready',
        dependsOn: [],
        basePolicy: 'contract',
        createdAt: AT,
        ...extra,
      }),
    )
  const pass = () => store.atomic(() => schedulePass(deps, { at: AT }))
  return { store, addTask, pass }
}

// The OpenCode slot is the least used, so without its reach it wins every tiebreak.
const LIVE_SLOTS = () => [view('slot_glm', 'opencode', NO_SHELL, 0), view('slot_codex', 'codex', SHELL, 0.5)]

describe('placement of a task that needs commands', () => {
  it('goes to a slot that can run them, though another is less used', () => {
    const { addTask, pass } = schedulerRig(LIVE_SLOTS())
    addTask('task_fix_top', { objective: BROWSER_CHECK })
    expect(pass().map((launch) => launch.slotId)).toEqual(['slot_codex'])
  })

  it('an edit-only task still takes the least used slot', () => {
    const { addTask, pass } = schedulerRig(LIVE_SLOTS())
    addTask('task_rename', { objective: EDIT_ONLY })
    expect(pass().map((launch) => launch.slotId)).toEqual(['slot_glm'])
  })

  it('pinned to a slot that cannot run them waits, saying why, and launches nothing', () => {
    const { store, addTask, pass } = schedulerRig(LIVE_SLOTS())
    addTask('task_fix_top', { objective: BROWSER_CHECK, slotHint: { slotId: 'slot_glm' } })
    expect(pass()).toEqual([])
    const deferred = store.tasks.get('task_fix_top')?.deferred as { reason: string; releases: string }
    expect(deferred.reason).toContain('slot_glm cannot run commands')
    expect(deferred.releases).toContain('a replan')
  })

  it('where no slot can run them waits for one, and launches nothing', () => {
    const { store, addTask, pass } = schedulerRig([view('slot_glm', 'opencode', NO_SHELL, 0)])
    addTask('task_fix_top', { objective: BROWSER_CHECK })
    expect(pass()).toEqual([])
    const deferred = store.tasks.get('task_fix_top')?.deferred as { reason: string; releases: string }
    expect(deferred.reason).toContain('no connection can run commands')
    expect(deferred.releases).toContain('can run commands')
  })

  it('a slot with nothing recorded is not ruled out', () => {
    const { addTask, pass } = schedulerRig([view('slot_x', 'claude', undefined, 0)])
    addTask('task_fix_top', { objective: BROWSER_CHECK })
    expect(pass().map((launch) => launch.slotId)).toEqual(['slot_x'])
  })
})
