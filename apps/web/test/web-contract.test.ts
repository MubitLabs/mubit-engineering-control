import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HealthBoard, HealthClaim, HealthName, Store } from '@mec/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// Relative on purpose: the web package has no dependency on @mec/*; this contract test is the one place
// the web client meets the real server, so a drift in either shape fails here (M1.1).
import { MemoryRepositories } from '../../../packages/testkit/src/index'
import { buildServer } from '../../desktop/src/server'
import { api } from '../src/api'

const AT = new Date('2026-11-05T12:00:00.000Z')

class FakeHealthBoard implements HealthBoard {
  claim(_name: HealthName): HealthClaim {
    return { starting: () => {}, ready: () => {}, paused: () => {}, error: () => {} }
  }
}

const originalFetch = globalThis.fetch
let root: string
let store: Store
let app: ReturnType<typeof buildServer>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mec-web-contract-'))
  const webDist = join(root, 'web')
  mkdirSync(webDist)
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>shell</title>')
  store = new MemoryRepositories()
  app = buildServer({
    store,
    effects: store.effects,
    health: new FakeHealthBoard(),
    policyText: '{"preAuthorised":{}}',
    now: () => AT,
    keystoreRoot: root,
    webDist,
  })
  // The web client's own fetch answers from the REAL server, in-process.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body === undefined ? {} : { payload: String(init.body) }),
    })
    return new Response(res.body, { status: res.statusCode, headers: res.headers as HeadersInit })
  }) as typeof fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await app.close()
  rmSync(root, { recursive: true, force: true })
})

describe('the web client against the real server', () => {
  it('real /api/prompts decodes to a part array', async () => {
    const parts = await api.prompts()
    expect(Array.isArray(parts)).toBe(true)
    expect(parts.length).toBeGreaterThan(20)
    const protocol = parts.find((part) => part.id === 'roles/meta_agent/protocol.md')
    expect(protocol).toMatchObject({ edited: false, defaultUpdated: false, provenance: 'shipped default' })
    expect(typeof protocol?.layer).toBe('string')
    expect(typeof protocol?.name).toBe('string')
  })

  it('real /api/models decodes to providers and rows', async () => {
    const tiers = await api.models()
    expect(tiers.providers.length).toBeGreaterThanOrEqual(3)
    expect(tiers.rows.map((row) => row.tier)).toEqual(['fast', 'balanced', 'strong', 'frontier'])
    for (const row of tiers.rows) expect(row.cells).toHaveLength(tiers.providers.length)
    const cells = tiers.rows.flatMap((row) => row.cells).filter((cell) => cell !== undefined)
    expect(cells.length).toBeGreaterThan(0)
    for (const cell of cells) expect(typeof cell?.text).toBe('string')
  })

  it('real questions decode and the answer body is accepted', async () => {
    store.engines.save({
      id: 'question/q_7',
      questionId: 'q_7',
      question: 'Keep the user id?',
      options: ['Keep it', 'Anonymise'],
      status: 'open',
      workItemId: 'wi_1',
      createdAt: AT.toISOString(),
    })
    store.engines.save({
      id: 'question/q_6',
      questionId: 'q_6',
      question: 'Already settled?',
      options: ['Yes'],
      status: 'answered',
      answer: 'Yes',
      createdAt: AT.toISOString(),
    })
    const questions = await api.questions()
    expect(questions.map((q) => q.id)).toEqual(['q_7'])
    expect(questions[0]).toMatchObject({ what: 'Keep the user id?', options: ['Keep it', 'Anonymise'] })

    const result = await api.answerQuestion('q_7', 'Anonymise')
    expect(result).toMatchObject({ status: 'answered' })
    expect(store.engines.get('question/q_7')).toMatchObject({ status: 'answered', answer: 'Anonymise' })
  })

  it('unknown /api GET is JSON 404 with dist present', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/backups' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.json()).toEqual({ error: 'not found' })
    // The SPA fallback still serves the shell for a client route.
    const shell = await app.inject({ method: 'GET', url: '/settings' })
    expect(shell.statusCode).toBe(200)
    expect(shell.body).toContain('shell')
  })
})
