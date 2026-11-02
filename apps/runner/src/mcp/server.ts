import { connectBridge } from '@mec/agents'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

/**
 * The per-attempt `mec` MCP server (PDF §7, §25). Claude Code starts it over stdio from the
 * attempt's --mcp-config; it forwards each call to the runner over a private Unix socket. It holds
 * no credentials and cannot do anything the runner does not decide.
 */
const socketPath = process.env.MEC_BRIDGE_SOCKET
if (!socketPath) {
  console.error('MEC_BRIDGE_SOCKET is required')
  process.exit(2)
}
const enabled = new Set((process.env.MEC_TOOLS ?? 'approve,ask_question,report_result').split(','))
const bridge = connectBridge(socketPath)
const server = new McpServer({ name: 'mec', version: '1.0.0' })
const asText = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
})

if (enabled.has('approve')) {
  server.registerTool(
    'approve',
    {
      description:
        'Permission prompt handler. Asks the owner of this account to approve or deny one tool call; returns {behavior, updatedInput|message}.',
      inputSchema: {
        tool_name: z.string(),
        input: z.record(z.string(), z.unknown()),
        tool_use_id: z.string().optional(),
      },
    },
    async (args) => asText(await bridge.call('approve', args)),
  )
}

if (enabled.has('ask_question')) {
  server.registerTool(
    'ask_question',
    {
      description:
        'Ask the people coordinating this delivery a question and wait for the answer. Use this instead of asking in prose.',
      inputSchema: {
        question: z.string().min(1),
        options: z.array(z.string()).optional(),
      },
    },
    async (args) => asText(await bridge.call('ask_question', args)),
  )
}

if (enabled.has('report_result')) {
  server.registerTool(
    'report_result',
    {
      description: 'Record a structured completion report for this task. Call once when you are done.',
      inputSchema: {
        summary: z.string(),
        requirements_covered: z.array(z.string()).optional(),
        open_questions: z.array(z.string()).optional(),
      },
    },
    async (args) => asText(await bridge.call('report_result', args)),
  )
}

if (enabled.has('propose_tasks')) {
  server.registerTool(
    'propose_tasks',
    {
      description:
        'Submit the proposed requirements and task graph for this delivery. Returns validation errors to fix, or confirmation that the plan was submitted for human approval.',
      inputSchema: {
        requirements: z.array(z.object({ id: z.string(), text: z.string() })),
        tasks: z.array(z.record(z.string(), z.unknown())),
        notes: z.string().optional(),
      },
    },
    async (args) => asText(await bridge.call('propose_tasks', args)),
  )
}

await server.connect(new StdioServerTransport())
