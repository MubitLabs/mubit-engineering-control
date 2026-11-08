import type { HealthBoard, HealthClaim, HealthName, Store } from '@mec/contracts'
import { SetupAgent, type SetupSettingsApi } from '@mec/meta'
import { MemoryRepositories } from '@mec/testkit'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { type CliIo, runCli } from '../src/mec'
import { buildServer, type ServerDeps } from '../src/server'
import { ownerApproval, ownerHeaders } from './approval-rig'

/**
 * The setup agent behind Chat's Setup mode, at the route level (T7, review
 * 2026-11-04 §7): propose_change creates a DRAFT the user applies with a yes in the
 * conversation, policy-touching drafts are policy_change cards the agent can never
 * apply, and the drafts surface is the inbox-shaped view of the cards.
 */

const AT = '2026-11-04T12:00:00.000Z'

class FakeHealthBoard implements HealthBoard {
  claim(_name: HealthName): HealthClaim {
    const entry = { state: 'starting' }
    return {
      starting: () => {},
      ready: () => {
        entry.state = 'ready'
      },
      paused: () => {},
      error: () => {},
    }
  }
}

const apps: FastifyInstance[] = []

/**
 * The scripted engine (the decide seam standing in for the model, like fakeBrain): it
 * maps this test's two phrasings onto propose_change calls; everything else falls to the
 * honest default. Deterministic code still validates and executes the calls.
 */
const scriptedDecide = async ({ text, pendingDrafts }: { text: string; pendingDrafts: { id: string }[] }) => {
  if (text.includes('different provider')) {
    return {
      calls: [
        {
          tool: 'propose_change',
          args: {
            target: 'prompts',
            reason: 'reviewers always use a different provider',
            patch: {
              path: 'roles/code_reviewer.md',
              text: 'prefer a different provider than the implementer',
            },
          },
        },
      ],
    }
  }
  if (text.includes('pre-authorise')) {
    return {
      calls: [
        {
          tool: 'propose_change',
          args: {
            target: 'policy',
            reason: 'pre-authorise installs for the eng repo',
            patch: { preAuthorised: { install: [{ scope: 'repo', repoId: 'repo_eng' }] } },
          },
        },
      ],
    }
  }
  // The user's yes: the model applies the pending draft — the guard checks the recorded
  // approval, which handleMessage notes before this decide runs.
  if (text.trim().toLowerCase() === 'yes' && pendingDrafts[0] !== undefined) {
    return { calls: [{ tool: 'apply_change', args: { draft_id: pendingDrafts[0].id } }] }
  }
  return { calls: [] }
}

function makeServer(opts: { scripted?: boolean } = {}): { store: Store; app: FastifyInstance; api: FakeApi } {
  const store: Store = new MemoryRepositories()
  const api = fakeApi()
  const deps: ServerDeps = {
    store,
    effects: store.effects,
    health: new FakeHealthBoard(),
    policyText: '{"preAuthorised":{}}',
    now: () => new Date(AT),
    setupAgent: new SetupAgent({
      store,
      api,
      now: () => new Date(AT),
      idFactory: idFactory(),
      // The scripted engine drives the draft flows; without it the honest default answers.
      ...(opts.scripted !== false && { decide: scriptedDecide }),
    }),
    approval: ownerApproval(),
  }
  const app = buildServer(deps)
  apps.push(app)
  return { store, app, api }
}

const idFactory = () => {
  let n = 0
  return () => {
    n += 1
    return `r${n}`
  }
}

type FakeApi = SetupSettingsApi & { applied: string[] }

function fakeApi(): FakeApi {
  const applied: string[] = []
  return {
    applied,
    read: async (resource) => {
      if (resource === 'doctor') return 'claude 2.1.317'
      if (resource === 'slots') return []
      if (resource === 'status') return { setup: { has_slot: true } }
      return null
    },
    applyDraft: async (draft) => {
      applied.push(draft.id)
      return { ok: true, detail: `applied ${draft.target}` }
    },
    openLoginCard: () => {},
    openKeyForm: () => {},
    registerRepository: async () => ({ ok: true, id: 'repo_1' }),
    setMetaSlot: () => {},
    runDoctor: async () => 'doctor report',
  }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

const chat = (app: FastifyInstance, text: string) =>
  app.inject({
    method: 'POST',
    url: '/api/chat/messages',
    payload: { text, setup: true },
    headers: { 'x-mec-client': '1', origin: 'http://127.0.0.1:5173', ...ownerHeaders },
  })

describe('Setup mode over the chat route', () => {
  it('a change request becomes a draft card; the yes applies it through the Settings API', async () => {
    const { app, api } = makeServer()

    const propose = await chat(app, 'make reviewers always use a different provider')
    expect(propose.statusCode).toBe(200)
    const proposed = (await propose.json()) as { drafts: { id: string; target: string; reason: string }[] }
    expect(proposed.drafts).toHaveLength(1)
    expect(proposed.drafts[0]?.target).toBe('prompts')
    expect(api.applied).toEqual([])

    const yes = await chat(app, 'yes')
    const yesBody = (await yes.json()) as { drafts: { id: string; status?: string }[]; applied: string[] }
    expect(yesBody.applied).toEqual([proposed.drafts[0]?.id])
    expect(api.applied).toEqual([proposed.drafts[0]?.id])

    const drafts = await app.inject({ method: 'GET', url: '/api/setup/drafts' })
    const list = (await drafts.json()) as { id: string; status: string; reason: string }[]
    expect(list[0]).toMatchObject({ id: proposed.drafts[0]?.id, status: 'applied' })
  })

  it('a policy-widening request becomes a policy_change card the agent never applies', async () => {
    const { app, api } = makeServer()
    const propose = await chat(app, 'pre-authorise installs for the eng repo')
    const proposed = (await propose.json()) as { drafts: { id: string; cls?: string }[] }
    expect(proposed.drafts[0]?.cls).toBe('policy_change')

    await chat(app, 'yes')
    const after = (await app.inject({ method: 'GET', url: '/api/setup/drafts' }).then((r) => r.json())) as {
      id: string
      status: string
    }[]
    expect(after[0]?.status).toBe('pending')
    expect(api.applied).toEqual([])
  })

  it('the honest default opener: real reads, no invented dialogue, secrets kept out', async () => {
    const { store, app } = makeServer({ scripted: false })
    const first = await chat(app, 'hello')
    const body = (await first.json()) as { reply: string; mode: string }
    expect(body.mode).toBe('setup')
    expect(body.reply).toContain('Setup mode ready')
    expect(body.reply).toContain('claude 2.1.317')
    expect(body.reply).toContain('credentials never pass through this chat')
    // The setup message is recorded like any chat message, marked as setup routing.
    const doc = store.messages.list().at(0)
    expect(doc?.routing).toBe('setup')
  })

  it('a setup message is never routed into the work planner', async () => {
    const { store, app } = makeServer()
    await chat(app, 'check doctor')
    expect(store.workItems.list()).toEqual([])
  })
})

describe('`mec setup` (the CLI stays thin, T7)', () => {
  it('prints the honest pointer to the workbench and configures nothing itself', async () => {
    const lines: string[] = []
    const io: CliIo = {
      readSnapshotText: () => null,
      initialized: () => false,
      markerDir: '/tmp/mec-marker',
      dataDir: '/tmp/mec-data',
      stdout: (line) => lines.push(line),
      restartServer: async () => ({ started: true, lines: [] }),
    }
    const code = await runCli(['setup'], io)
    expect(code).toBe(0)
    const said = lines.join('\n')
    expect(said).toContain('open the workbench → Chat → Setup mode')
    expect(said).toContain('configures nothing itself')
    expect(said).not.toMatch(/slot add|api-key/i)
  })
})
