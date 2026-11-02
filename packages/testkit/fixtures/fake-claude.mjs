#!/usr/bin/env node
// A stand-in for the `claude` CLI used by tests. It accepts the flags the adapter passes, speaks
// stream-json on stdin/stdout, and calls the real `mec` MCP server from --mcp-config exactly as
// Claude Code would for permission prompts and questions. Instructions are read from user text:
//   NEEDS_APPROVAL: <command>   -> permission prompt via the configured prompt tool
//   ASK: <question>             -> mcp__mec__ask_question
//   WRITE: <path>=<content>     -> writes a file in the working directory
//   FAIL_QUOTA                  -> ends the turn with a usage-limit error
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('2.1.292 (Claude Code)')
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(
    JSON.stringify({ loggedIn: process.env.FAKE_CLAUDE_LOGGED_OUT !== '1', authMethod: 'claude.ai' }),
  )
  process.exit(0)
}
const opt = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const session = opt('--session-id') ?? opt('--resume') ?? 'no-session'
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

let mcp = null
async function tools() {
  if (mcp) return mcp
  const config = JSON.parse(readFileSync(opt('--mcp-config'), 'utf8')).mcpServers.mec
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...process.env, ...config.env },
  })
  mcp = new Client({ name: 'fake-claude', version: '1.0.0' })
  await mcp.connect(transport)
  return mcp
}
const call = async (name, a) =>
  JSON.parse((await (await tools()).callTool({ name, arguments: a })).content[0].text)

let started = false
const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  if (!line.trim()) continue
  const msg = JSON.parse(line)
  const text = msg.message.content.map((c) => c.text ?? '').join('')
  if (!started) {
    started = true
    out({
      type: 'system',
      subtype: 'init',
      session_id: session,
      model: 'fake-model',
      permissionMode: opt('--permission-mode'),
      tools: ['Read', 'Bash'],
      mcp_servers: [{ name: 'mec', status: 'connected' }],
    })
  }
  if (args.includes('--replay-user-messages'))
    out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, uuid: 'echo' })
  let resultText = 'done'
  let ok = true
  for (const part of text.split('\n')) {
    const approval = /^NEEDS_APPROVAL: (.+)$/.exec(part)
    const ask = /^ASK: (.+)$/.exec(part)
    const write = /^WRITE: ([^=]+)=(.*)$/.exec(part)
    if (approval) {
      const id = `toolu_${Math.random().toString(36).slice(2)}`
      const decision = await call(opt('--permission-prompt-tool').replace('mcp__mec__', ''), {
        tool_name: 'Bash',
        input: { command: approval[1] },
        tool_use_id: id,
      })
      if (decision.behavior === 'allow') {
        out({
          type: 'assistant',
          message: {
            id: 'msg1',
            content: [{ type: 'tool_use', id, name: 'Bash', input: decision.updatedInput }],
          },
        })
        out({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: id, content: 'ran ok', is_error: false }],
          },
        })
        out({
          type: 'assistant',
          message: { id: 'msg2', content: [{ type: 'text', text: `Ran: ${approval[1]}` }] },
        })
      } else {
        out({
          type: 'assistant',
          message: { id: 'msg2', content: [{ type: 'text', text: `Denied: ${decision.message}` }] },
        })
      }
    } else if (ask) {
      const r = await call('ask_question', { question: ask[1], options: ['yes', 'no'] })
      out({
        type: 'assistant',
        message: { id: 'msg3', content: [{ type: 'text', text: `Answer: ${r.answer ?? 'none'}` }] },
      })
    } else if (write) {
      mkdirSync(dirname(write[1]), { recursive: true })
      writeFileSync(write[1], write[2] + '\n')
      out({
        type: 'assistant',
        message: {
          id: 'msg4',
          content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: write[1] } }],
        },
      })
    } else if (part === 'FAIL_QUOTA') {
      ok = false
      resultText = 'Claude AI usage limit reached|resets 5pm (UTC)'
    } else if (part === 'SLOW') {
      await new Promise((r) => setTimeout(r, 30_000))
    }
  }
  await call('report_result', { summary: resultText }).catch(() => {})
  out({
    type: 'result',
    subtype: ok ? 'success' : 'error_during_execution',
    is_error: !ok,
    result: resultText,
    session_id: session,
    num_turns: 1,
    duration_ms: 5,
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 5 },
  })
}
await mcp?.close()
process.exit(0)
