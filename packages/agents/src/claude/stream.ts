/**
 * Normalises Claude Code `--output-format stream-json` lines into platform evidence events, once,
 * keeping the native ids (PDF §16: normalise native events once and retain their source IDs).
 * Thinking blocks are not recorded: private reasoning is not evidence we should infer from.
 */

export interface NormalisedEvent {
  type: string
  payload: Record<string, unknown>
}

export interface TurnResult {
  ok: boolean
  subtype: string
  text: string
  sessionId: string | null
  usage: Record<string, unknown> | null
  costUsd: number | null
  numTurns: number | null
  durationMs: number | null
}

const clip = (s: string, n = 20_000) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s)

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .join('')
  }
  return ''
}

export function normalise(msg: Record<string, unknown>): { events: NormalisedEvent[]; result?: TurnResult } {
  const events: NormalisedEvent[] = []
  switch (msg.type) {
    case 'system': {
      if (msg.subtype === 'init') {
        const servers = Array.isArray(msg.mcp_servers)
          ? (msg.mcp_servers as { name: string; status: string }[])
          : []
        events.push({
          type: 'agent.session',
          payload: {
            sessionId: msg.session_id ?? null,
            model: msg.model ?? null,
            permissionMode: msg.permissionMode ?? null,
            tools: Array.isArray(msg.tools) ? (msg.tools as unknown[]).length : null,
            mcpServers: servers.map((s) => ({ name: s.name, status: s.status })),
            version: msg.claude_code_version ?? null,
          },
        })
      } else {
        events.push({
          type: 'agent.log',
          payload: { stream: 'system', subtype: msg.subtype ?? null, line: clip(JSON.stringify(msg), 2_000) },
        })
      }
      return { events }
    }
    case 'assistant': {
      const message = (msg.message ?? {}) as { content?: unknown[]; id?: string }
      for (const block of message.content ?? []) {
        const b = block as { type?: string; text?: string; id?: string; name?: string; input?: unknown }
        if (b.type === 'text' && b.text?.trim()) {
          events.push({
            type: 'agent.message',
            payload: { role: 'assistant', text: clip(b.text), nativeId: message.id ?? null },
          })
        } else if (b.type === 'tool_use') {
          events.push({
            type: 'agent.tool_use',
            payload: {
              toolUseId: b.id ?? null,
              name: b.name ?? 'unknown',
              input: b.input ?? {},
              parentToolUseId: msg.parent_tool_use_id ?? null,
            },
          })
        }
      }
      return { events }
    }
    case 'user': {
      const message = (msg.message ?? {}) as { content?: unknown }
      const content = message.content
      if (typeof content === 'string') {
        events.push({
          type: 'agent.user_echo',
          payload: { text: clip(content, 4_000), uuid: msg.uuid ?? null },
        })
        return { events }
      }
      for (const block of (content as unknown[]) ?? []) {
        const b = block as {
          type?: string
          tool_use_id?: string
          content?: unknown
          is_error?: boolean
          text?: string
        }
        if (b.type === 'tool_result') {
          events.push({
            type: 'agent.tool_result',
            payload: {
              toolUseId: b.tool_use_id ?? null,
              ok: b.is_error !== true,
              output: clip(textOf(b.content), 4_000),
            },
          })
        } else if (b.type === 'text') {
          events.push({
            type: 'agent.user_echo',
            payload: { text: clip(b.text ?? '', 4_000), uuid: msg.uuid ?? null },
          })
        }
      }
      return { events }
    }
    case 'result': {
      const result: TurnResult = {
        ok: msg.subtype === 'success' && msg.is_error !== true,
        subtype: String(msg.subtype ?? 'unknown'),
        text: typeof msg.result === 'string' ? msg.result : '',
        sessionId: typeof msg.session_id === 'string' ? msg.session_id : null,
        usage: (msg.usage as Record<string, unknown>) ?? null,
        costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
        numTurns: typeof msg.num_turns === 'number' ? msg.num_turns : null,
        durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : null,
      }
      // Usage is recorded when reported and left unknown otherwise — never zero by default.
      events.push({
        type: 'agent.usage',
        payload: {
          usage: result.usage,
          reportedCostUsd: result.costUsd,
          numTurns: result.numTurns,
          durationMs: result.durationMs,
          resultSubtype: result.subtype,
        },
      })
      if (result.text)
        events.push({ type: 'agent.turn_result', payload: { ok: result.ok, text: clip(result.text, 8_000) } })
      return { events, result }
    }
    default:
      return {
        events: [
          { type: 'agent.log', payload: { stream: 'stdout', line: clip(JSON.stringify(msg), 2_000) } },
        ],
      }
  }
}

export type Classified =
  | { status: 'quota'; detail: string; resetAt: string | null }
  | { status: 'auth'; detail: string }
  | { status: 'failed'; detail: string }

/** Known exhaustion and sign-in failures need a different resolution than an ordinary error (PDF §11). */
export function classifyFailure(text: string): Classified {
  const t = text.slice(0, 2_000)
  if (/usage limit|rate limit|limit reached|quota|too many requests|429/i.test(t)) {
    const reset = /reset[s]?\s*(?:at)?\s*([0-9:apm\s]+(?:\([^)]+\))?|\d{4}-\d{2}-\d{2}T[\d:.Z+-]+)/i.exec(t)
    return { status: 'quota', detail: t, resetAt: reset?.[1]?.trim() ?? null }
  }
  if (
    /not logged in|please run \/login|\/login|invalid api key|authentication|unauthori[sz]ed|oauth token|401/i.test(
      t,
    )
  ) {
    return { status: 'auth', detail: t }
  }
  return { status: 'failed', detail: t || 'Claude Code exited without a result' }
}
