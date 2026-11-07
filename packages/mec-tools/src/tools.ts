/**
 * The platform tool set — plan §6 "The platform tool set": the meta agent's
 * only write channel, and the specialist's closed report vocabulary. Every
 * engine sees the same tools through the mec-tools MCP server; the token's
 * role picks the subset. Schemas are plain JSON objects (no schema library)
 * and descriptions stay under 200 characters.
 */
import type { AgentRole } from './tokens'

export type ToolName =
  | 'acknowledge'
  | 'propose_plan'
  | 'spawn_agent'
  | 'route'
  | 'request_confirmation'
  | 'ask_user'
  | 'report_result'
  | 'read'
  | 'stop_agent'
  | 'cancel_task'
  | 'report'
  | 'handback'
  | 'confirm'

/** Plan §6: the meta agent's ten platform tools — its only write channel. */
export const META_AGENT_TOOLS: readonly ToolName[] = [
  'acknowledge',
  'propose_plan',
  'spawn_agent',
  'route',
  'request_confirmation',
  'ask_user',
  'report_result',
  'read',
  'stop_agent',
  'cancel_task',
]

/** A specialist reports, asks, requests confirmation, hands back and reads. */
export const SPECIALIST_TOOLS: readonly ToolName[] = [
  'report',
  'ask_user',
  'request_confirmation',
  'handback',
  'read',
  'confirm',
]

export function toolsForRole(role: AgentRole): ToolName[] {
  return [...(role === 'meta_agent' ? META_AGENT_TOOLS : SPECIALIST_TOOLS)]
}

export interface ToolSpec {
  /** One line, at most 200 characters. */
  description: string
  inputSchema: Record<string, unknown>
}

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  acknowledge: {
    description: 'Acknowledge one message in a single sentence; idempotent per message id',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['message_id', 'text'],
      additionalProperties: false,
    },
  },
  propose_plan: {
    description:
      'Propose a task graph for a work item: tasks with dependencies, role, model_request and owned paths; validated deterministically, repairs returned',
    inputSchema: {
      type: 'object',
      properties: {
        work_item: { type: 'string' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              objective: { type: 'string' },
              original_request_ref: { type: 'string' },
              owned_paths: { type: 'array', items: { type: 'string' } },
              acceptance_checks: { type: 'array', items: { type: 'string' } },
              sensitive: {
                type: 'boolean',
                description:
                  'True when the task touches secrets, sign-in, permissions, money, deleting or migrating stored data, or a public post: it then gets one read-only review',
              },
              no_change_ok: {
                type: 'boolean',
                description:
                  'True when finishing with no change is a valid outcome (a check or an investigation). Otherwise a task that ends on its base with no ready report is sent back',
              },
              depends_on: { type: 'array', items: { type: 'string' } },
              role: { type: 'string' },
              base_policy: {
                type: 'string',
                enum: ['integration', 'contract'],
                description:
                  'integration (default): starts from the merged result of its dependencies. contract: starts from the pinned base once they are accepted',
              },
              model_request: {
                type: 'object',
                properties: {
                  tier: { type: 'string', enum: ['fast', 'balanced', 'strong', 'frontier'] },
                  model: { type: 'string' },
                  effort: { type: 'string' },
                  reason: { type: 'string' },
                },
                required: ['reason'],
              },
              slot_hint: {
                type: 'object',
                properties: { slot_class: { type: 'string' }, slot_id: { type: 'string' } },
              },
              budget: {
                type: 'object',
                properties: {
                  turns: { type: 'number' },
                  wall_clock_ms: { type: 'number' },
                  usd: { type: 'number' },
                },
              },
              subagent_policy: {
                type: 'object',
                properties: { max_tier: { type: 'string' }, depth: { type: 'number' } },
              },
            },
            required: ['id', 'objective', 'role', 'model_request'],
          },
        },
        deps: { type: 'array', items: { type: 'string' } },
      },
      required: ['work_item', 'tasks'],
    },
  },
  spawn_agent: {
    description:
      'Spawn a specialist for a task with a role and an optional slot class or slot, bounded by caps and budget',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        role: { type: 'string' },
        slot_class: { type: 'string' },
        slot: { type: 'string' },
      },
      required: ['task', 'role'],
    },
  },
  // T5 (review 2026-11-04 §5.2): the §12 routing vocabulary — attach/stop/hold carry their
  // target in `target`; only these decisions exist, and only the owner lifts a hold (#20).
  route: {
    description:
      'Attach a message to live work, new work, a stop, a hold, or the conversation, with an optional bounded note',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        decision: {
          type: 'string',
          enum: ['new_work', 'attach', 'stop', 'hold', 'conversation'],
        },
        target: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['message_id', 'decision'],
    },
  },
  request_confirmation: {
    description:
      'Request user confirmation for a guarded operation with evidence; the card never self-approves',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'object' },
        evidence: { type: 'object' },
      },
      required: ['operation', 'evidence'],
    },
  },
  ask_user: {
    description:
      'Ask the user one concrete question, optionally bound to the message that raised it, with options',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        for_message_id: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
        evidence_ref: { type: 'string' },
      },
      required: ['question'],
    },
  },
  report_result: {
    description: 'Report a work item result to the user with a summary and artifacts',
    inputSchema: {
      type: 'object',
      properties: {
        work_item: { type: 'string' },
        summary: { type: 'string' },
        artifacts: {
          type: 'array',
          items: {
            type: 'object',
            properties: { kind: { type: 'string' }, ref: { type: 'string' } },
            required: ['kind', 'ref'],
          },
        },
      },
      required: ['work_item', 'summary'],
    },
  },
  read: {
    description: 'Read one bounded, role-scoped page of a read resource, continuing from an optional cursor',
    inputSchema: {
      type: 'object',
      properties: {
        resource: { type: 'string' },
        cursor: { type: 'string' },
      },
      required: ['resource'],
    },
  },
  stop_agent: {
    description: 'Stop a running agent instance; scoped cancellation within the current work item',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string' },
      },
      required: ['agent'],
    },
  },
  cancel_task: {
    description: 'Cancel a task in the current work item; scoped cancellation',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
      },
      required: ['task'],
    },
  },
  report: {
    description:
      'Report status: progress, waiting, ready, blocked, failed or dropped; optionally one question. List a follow-up you handled in handled_inputs by input id; one you cannot own goes to handback',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'],
        },
        summary: { type: 'string' },
        head_sha: { type: 'string' },
        checks_run: { type: 'array', items: { type: 'string' } },
        artifacts: {
          type: 'array',
          items: { type: 'object' },
          description: "A reviewer lists each finding as {kind: 'finding', ref: what is wrong and where}",
        },
        question: { type: 'object' },
        round: {
          type: 'object',
          description: 'The review round from your brief, {count}, so a later attempt continues it',
        },
        handled_inputs: { type: 'array', items: { type: 'string' } },
      },
      required: ['kind', 'summary'],
    },
  },
  confirm: {
    description:
      'Bridge one engine permission request to the platform; answers allow/deny per policy or card',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        tool_input: { type: 'object' },
      },
      required: ['tool_name', 'tool_input'],
    },
  },
  handback: {
    description: 'Hand a follow-up back to the meta agent once, naming the message and the reason',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['message_id', 'reason'],
      additionalProperties: false,
    },
  },
}

/**
 * The Claude Code permission-prompt tool (plan §9): Claude calls it as
 * `mcp__mec__confirm` when `--permission-prompt-tool` names it; the response uses
 * Claude's {behavior, updatedInput?} shape. Codex/OpenCode adapters call the
 * bridge in-process instead (§3).
 */
TOOL_SPECS.confirm = {
  description: 'Bridge one engine permission request to the platform; answers allow/deny per policy or card',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      tool_input: { type: 'object' },
    },
    required: ['tool_name', 'tool_input'],
  },
}
