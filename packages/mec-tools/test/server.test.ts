import type { PermissionBridge } from '@mec/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MecToolsServer } from '../src/server'
import { type AgentRole, issueToken } from '../src/tokens'
import { TOOL_SPECS, type ToolName } from '../src/tools'

const SECRET = 'test-secret'

const noopBridge: PermissionBridge = { request: async () => 'deny' }

type RpcBody = { id?: number; result?: unknown; error?: { code: number; message: string } }
type ToolsResult = { tools: Array<{ name: ToolName; description: string; inputSchema: unknown }> }

let server: MecToolsServer
let url: string
let calls: Array<{ role: AgentRole; attemptId: string; tool: ToolName; args: unknown }>

beforeEach(async () => {
  calls = []
  server = new MecToolsServer({
    secret: SECRET,
    bridge: noopBridge,
    onCall: async (ctx, tool, args) => {
      calls.push({ role: ctx.role, attemptId: ctx.attemptId, tool, args })
      return { ok: true, tool }
    },
  })
  const started = await server.start()
  url = started.url
})

afterEach(async () => {
  await server.stop()
})

function tokenFor(role: AgentRole, attemptId = 'att_1', generation = 0): string {
  return issueToken({ attemptId, generation, role, secret: SECRET })
}

function rpc(id: number, method: string, params?: unknown) {
  return { jsonrpc: '2.0', id, method, params }
}

async function post(body: unknown, token: string = tokenFor('specialist')): Promise<RpcBody> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as RpcBody
}

function toolNames(result: unknown): ToolName[] {
  return (result as ToolsResult).tools.map((tool) => tool.name)
}

describe('MecToolsServer over real HTTP', () => {
  it('tools/list exposes only the role’s tools, mapped onto TOOL_SPECS', async () => {
    const specialist = await post(rpc(1, 'tools/list'))
    const specialistNames = toolNames(specialist.result)
    expect(specialistNames).not.toContain('spawn_agent')
    expect(specialistNames).not.toContain('propose_plan')
    expect(specialistNames).toEqual(
      expect.arrayContaining(['report', 'ask_user', 'request_confirmation', 'handback', 'read']),
    )
    for (const tool of (specialist.result as ToolsResult).tools) {
      expect(tool.description).toBe(TOOL_SPECS[tool.name].description)
      expect(tool.inputSchema).toEqual(TOOL_SPECS[tool.name].inputSchema)
    }

    const meta = await post(rpc(2, 'tools/list'), tokenFor('meta_agent'))
    const metaNames = toolNames(meta.result)
    expect(metaNames).toContain('spawn_agent')
    expect(metaNames).toContain('propose_plan')
    expect(metaNames).toHaveLength(10)
  })

  it('tools/call refuses a tool the role does not have and runs one it does', async () => {
    const deniedPlan = await post(rpc(1, 'tools/call', { name: 'propose_plan', arguments: {} }))
    expect(deniedPlan.error?.message).toBe('tool not available for role')

    const deniedSpawn = await post(
      rpc(2, 'tools/call', { name: 'spawn_agent', arguments: { task: 'task_1', role: 'implementer' } }),
    )
    expect(deniedSpawn.error?.message).toBe('tool not available for role')

    const ok = await post(
      rpc(3, 'tools/call', { name: 'report', arguments: { kind: 'ready', summary: 'done' } }),
    )
    expect(ok.error).toBeUndefined()
    expect(ok.result).toBeDefined()
    expect(calls).toEqual([
      {
        role: 'specialist',
        attemptId: 'att_1',
        tool: 'report',
        args: { kind: 'ready', summary: 'done' },
      },
    ])
  })

  it('a stale generation sees an empty tools/list and a call error; a fresh token still works', async () => {
    server.bumpGeneration('att_1')
    const stale = tokenFor('meta_agent', 'att_1', 0)

    const list = await post(rpc(1, 'tools/list'), stale)
    expect(toolNames(list.result)).toEqual([])

    const call = await post(
      rpc(2, 'tools/call', { name: 'read', arguments: { resource: 'work_items' } }),
      stale,
    )
    expect(call.error?.message).toBe('stale generation')
    expect(calls).toHaveLength(0)

    const fresh = await post(
      rpc(3, 'tools/call', { name: 'read', arguments: { resource: 'work_items' } }),
      tokenFor('meta_agent', 'att_1', 1),
    )
    expect(fresh.error).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('a token that fails verification is a 401', async () => {
    const badToken = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not.a.token' },
      body: JSON.stringify(rpc(1, 'tools/list')),
    })
    expect(badToken.status).toBe(401)

    const noHeader = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rpc(1, 'tools/list')),
    })
    expect(noHeader.status).toBe(401)

    const wrongSecret = issueToken({ attemptId: 'att_1', generation: 0, role: 'meta_agent', secret: 'other' })
    const foreign = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${wrongSecret}` },
      body: JSON.stringify(rpc(1, 'tools/list')),
    })
    expect(foreign.status).toBe(401)
  })

  it('a batch of [ok-call, bad-call] returns two independent results', async () => {
    const body = await post([
      rpc(1, 'tools/call', { name: 'report', arguments: { kind: 'progress', summary: 'halfway' } }),
      rpc(2, 'tools/call', { name: 'spawn_agent', arguments: { task: 'task_1', role: 'implementer' } }),
    ])
    expect(Array.isArray(body)).toBe(true)
    const results = body as unknown as RpcBody[]
    expect(results).toHaveLength(2)
    expect(results[0]?.id).toBe(1)
    expect(results[0]?.result).toBeDefined()
    expect(results[1]?.id).toBe(2)
    expect(results[1]?.error?.message).toBe('tool not available for role')
    expect(calls).toHaveLength(1) // the refused item never reached onCall
  })

  it('resources/list and resources/read return empty stub pages', async () => {
    const list = await post(rpc(1, 'resources/list'))
    expect(list.result).toEqual({ resources: [] })
    const read = await post(rpc(2, 'resources/read', { uri: 'mec://work_items' }))
    expect(read.result).toEqual({ contents: [] })
  })
})
