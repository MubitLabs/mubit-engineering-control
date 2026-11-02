import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startBridge } from '@mec/agents'
import { TEST_MCP_SERVER } from '@mec/testkit'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, describe, expect, it } from 'vitest'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of closers.splice(0)) await c()
})

async function connect(
  tools: string,
  handler: (method: string, params: Record<string, unknown>) => Promise<unknown>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mec-mcp-'))
  const bridge = await startBridge(path.join(dir, 'bridge.sock'), handler)
  closers.push(() => bridge.close())
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: TEST_MCP_SERVER.command,
      args: TEST_MCP_SERVER.args,
      env: { PATH: process.env.PATH ?? '', MEC_BRIDGE_SOCKET: bridge.socketPath, MEC_TOOLS: tools },
    }),
  )
  closers.push(() => client.close())
  return client
}

const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text)

describe('mec MCP server', () => {
  it('exposes only the tools enabled for the attempt', async () => {
    const client = await connect('approve,ask_question,report_result', async () => ({}))
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['approve', 'ask_question', 'report_result'])
  })

  it('forwards a permission prompt to the runner and returns its decision', async () => {
    const seen: unknown[] = []
    const client = await connect('approve', async (method, params) => {
      seen.push({ method, params })
      return { behavior: 'deny', message: 'not today' }
    })
    const result = await client.callTool({
      name: 'approve',
      arguments: { tool_name: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'toolu_9' },
    })
    expect(text(result)).toEqual({ behavior: 'deny', message: 'not today' })
    expect(seen).toEqual([
      {
        method: 'approve',
        params: { tool_name: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'toolu_9' },
      },
    ])
  })

  it('lets the coordinator call propose_tasks only when enabled', async () => {
    const client = await connect('propose_tasks', async (method) => ({ ok: true, method }))
    const r = await client.callTool({ name: 'propose_tasks', arguments: { requirements: [], tasks: [] } })
    expect(text(r)).toEqual({ ok: true, method: 'propose_tasks' })
  })
})
