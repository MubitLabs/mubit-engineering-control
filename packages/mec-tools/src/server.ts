/**
 * The mec-tools MCP transport — plan §6 "Transport: mec-tools".
 *
 * One streamable-HTTP server on 127.0.0.1:0, deliberately minimal: POST /mcp
 * only, plain `application/json` responses (no SSE stream), no GET or DELETE,
 * no sessions and no `initialize` handshake state. MEC's engine clients speak
 * request/response JSON-RPC 2.0 over that one endpoint; the full MCP session
 * machinery would buy nothing for a localhost server whose lifetime is the
 * host process, so a stdio shim for an engine that cannot speak HTTP MCP (plan
 * §6) remains the only planned addition.
 *
 * Everything is scoped by the bearer token:
 * - `Authorization: Bearer` is verified (tokens.ts) before any JSON-RPC
 *   processing; a token that fails verification is a 401.
 * - tools/list maps toolsForRole(token.role) onto TOOL_SPECS; tools/call
 *   refuses a tool the role does not have ('tool not available for role').
 * - Generation fencing (plan §8.6) extends to tool calls: a token whose
 *   generation is behind the server's current generation for that attempt
 *   gets an empty tool list and 'stale generation' on every call.
 * - Batches run each item independently, one result per item (plan §6 batch
 *   semantics); a refused item never stops the others.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { PermissionBridge } from '@mec/contracts'
import { type VerifiedToken, verifyToken } from './tokens'
import { TOOL_SPECS, type ToolName, toolsForRole } from './tools'

const MAX_BODY_BYTES = 1024 * 1024
const BEARER_PATTERN = /^Bearer (.+)$/

// JSON-RPC 2.0 codes from the spec, plus -32002: this server's own application
// error for role violations, generation fencing and unknown tools.
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const INVALID_PARAMS = -32602
const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603
const MEC_TOOLS_ERROR = -32002

type JsonRpcId = string | number | null

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string } }

export type ToolCallHandler = (ctx: VerifiedToken, tool: ToolName, args: unknown) => Promise<unknown>

export interface MecToolsServerOptions {
  /** The secret tokens are signed with; shared with the host process. */
  secret: string
  /** Stream A of the permission bridge; adapters share this instance (`mcp__mec__confirm`). */
  bridge: PermissionBridge
  /** Executes a validated tool call for the token's attempt. */
  onCall: ToolCallHandler
}

export interface StartedServer {
  port: number
  url: string
}

export class MecToolsServer {
  private readonly secret: string
  private readonly permissionBridge: PermissionBridge
  private readonly onCall: ToolCallHandler
  /** The current generation per attempt; a token behind it is fenced out. */
  private readonly generations = new Map<string, number>()
  private server: Server | null = null

  constructor(options: MecToolsServerOptions) {
    this.secret = options.secret
    this.permissionBridge = options.bridge
    this.onCall = options.onCall
  }

  /** The bridge adapters route native permission requests through (plan §9). */
  get bridge(): PermissionBridge {
    return this.permissionBridge
  }

  /**
   * Marks `attemptId` as having moved on: from this call onward every token of
   * an older generation is fenced out (empty tool list, 'stale generation').
   */
  bumpGeneration(attemptId: string): void {
    this.generations.set(attemptId, (this.generations.get(attemptId) ?? 0) + 1)
  }

  /** The generation this server currently knows for the attempt, if any was bumped. */
  currentGeneration(attemptId: string): number | undefined {
    return this.generations.get(attemptId)
  }

  async start(): Promise<StartedServer> {
    if (this.server !== null) throw new Error('mec-tools server already started')
    const server = createServer((req, res) => {
      // A client that hangs up mid-response must not crash the host.
      res.on('error', () => {})
      this.handle(req, res).catch(() => {
        if (!res.headersSent) send(res, 500, errorFor(null, INTERNAL_ERROR, 'internal error'))
        else res.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      server.close()
      throw new Error(`unexpected listen address: ${JSON.stringify(address)}`)
    }
    this.server = server
    return { port: address.port, url: `http://127.0.0.1:${address.port}/mcp` }
  }

  async stop(): Promise<void> {
    const server = this.server
    if (server === null) return
    this.server = null
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0]
    if (path !== '/mcp') {
      send(res, 404, { error: 'not found' })
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      send(res, 405, { error: 'method not allowed' })
      return
    }
    let body: string
    try {
      body = await readBody(req)
    } catch {
      send(res, 413, { error: 'request body too large' })
      return
    }
    const ctx = this.authenticate(req.headers.authorization)
    if (ctx === null) {
      res.setHeader('www-authenticate', 'Bearer')
      send(res, 401, errorFor(null, -32000, 'unauthorized'))
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      send(res, 400, errorFor(null, PARSE_ERROR, 'parse error'))
      return
    }
    const isBatch = Array.isArray(parsed)
    const items: unknown[] = isBatch ? (parsed as unknown[]) : [parsed]
    if (items.length === 0) {
      send(res, 400, errorFor(null, INVALID_REQUEST, 'invalid request: empty batch'))
      return
    }
    const responses: JsonRpcResponse[] = []
    for (const item of items) {
      const response = await this.processItem(ctx, item)
      if (response !== null) responses.push(response)
    }
    if (responses.length === 0) {
      send(res, 204) // a request of only notifications gets no content, per JSON-RPC
      return
    }
    send(res, 200, isBatch ? responses : responses[0])
  }

  private authenticate(header: string | string[] | undefined): VerifiedToken | null {
    if (typeof header !== 'string') return null
    const token = BEARER_PATTERN.exec(header)?.[1]
    if (token === undefined) return null
    return verifyToken(token, this.secret)
  }

  private async processItem(ctx: VerifiedToken, item: unknown): Promise<JsonRpcResponse | null> {
    if (typeof item !== 'object' || item === null) {
      return errorFor(null, INVALID_REQUEST, 'invalid request')
    }
    const { jsonrpc, id, method, params } = item as {
      jsonrpc?: unknown
      id?: unknown
      method?: unknown
      params?: unknown
    }
    // Notifications (no id) are dropped: this server executes nothing it cannot answer.
    if (id === undefined) return null
    if (typeof id !== 'string' && typeof id !== 'number' && id !== null) {
      return errorFor(null, INVALID_REQUEST, 'invalid request: id must be a string, number or null')
    }
    if (jsonrpc !== '2.0') {
      return errorFor(id, INVALID_REQUEST, 'invalid request: jsonrpc must be "2.0"')
    }
    if (typeof method !== 'string') {
      return errorFor(id, INVALID_REQUEST, 'invalid request: method must be a string')
    }
    switch (method) {
      case 'tools/list':
        return resultFor(id, { tools: this.toolListFor(ctx) })
      case 'tools/call':
        return this.callTool(ctx, id, params)
      case 'resources/list':
        // Read resources (plan §6) arrive with the core behind them; here: empty pages.
        return resultFor(id, { resources: [] })
      case 'resources/read':
        return resultFor(id, { contents: [] })
      default:
        return errorFor(id, METHOD_NOT_FOUND, `method not found: ${method}`)
    }
  }

  private toolListFor(ctx: VerifiedToken): Array<{
    name: ToolName
    description: string
    inputSchema: Record<string, unknown>
  }> {
    // A fenced-out token sees an empty list: there is nothing left it may call.
    if (this.isStale(ctx)) return []
    return toolsForRole(ctx.role).map((name) => {
      const spec = TOOL_SPECS[name]
      return { name, description: spec.description, inputSchema: spec.inputSchema }
    })
  }

  private async callTool(ctx: VerifiedToken, id: JsonRpcId, params: unknown): Promise<JsonRpcResponse> {
    if (typeof params !== 'object' || params === null) {
      return errorFor(id, INVALID_PARAMS, "invalid params: expected an object with 'name'")
    }
    const { name, arguments: args } = params as { name?: unknown; arguments?: unknown }
    if (typeof name !== 'string') {
      return errorFor(id, INVALID_PARAMS, "invalid params: 'name' must be a string")
    }
    if (this.isStale(ctx)) return errorFor(id, MEC_TOOLS_ERROR, 'stale generation')
    if (!Object.hasOwn(TOOL_SPECS, name)) {
      return errorFor(id, MEC_TOOLS_ERROR, `unknown tool '${name}'`)
    }
    const tool = name as ToolName
    if (!toolsForRole(ctx.role).includes(tool)) {
      return errorFor(id, MEC_TOOLS_ERROR, 'tool not available for role')
    }
    try {
      const value = await this.onCall(ctx, tool, args ?? {})
      return resultFor(id, {
        content: [{ type: 'text', text: JSON.stringify(value ?? null) }],
        isError: false,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return errorFor(id, INTERNAL_ERROR, `tool '${tool}' failed: ${message}`)
    }
  }

  private isStale(ctx: VerifiedToken): boolean {
    const current = this.generations.get(ctx.attemptId)
    return current !== undefined && ctx.generation < current
  }
}

function resultFor(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function errorFor(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status)
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
