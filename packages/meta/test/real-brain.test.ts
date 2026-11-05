import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { EngineEvent, EngineEventBody, LaunchSpec } from '@mec/contracts'
import { describe, expect, it } from 'vitest'
import { issueToken } from '../../mec-tools/src/tokens'
import { type BrainEngine, RealClaudeBrain } from '../src/real-brain'

/**
 * RealClaudeBrain over a FAKE adapter: the decision must come from the normalised
 * event stream alone — first acknowledge text or first assistant sentence for the ack,
 * the LAST validating propose_plan for the plan — and the launch spec must carry the
 * read-only isolation, the slot-layer env and the brain-owned settings pair. The
 * tools server is real (loopback HTTP, no engine): the last case drives `onCall`
 * through it and checks the recorded `calls`.
 */

const NOW = () => new Date('2026-11-03T12:00:00.000Z')

const AT = '2026-11-03T12:00:00.000Z'

function fakeEngine(bodies: EngineEventBody[]): { engine: BrainEngine; specs: LaunchSpec[] } {
  const specs: LaunchSpec[] = []
  return {
    specs,
    engine: {
      async launch(spec) {
        specs.push(spec)
        return {
          attempt_id: spec.brief.attempt_id,
          generation: spec.brief.generation,
          pid: 4242,
          session_id: 'sess_fake',
        }
      },
      async *events(handle) {
        let seq = 1
        for (const body of bodies) {
          yield {
            ...body,
            seq: seq++,
            at: AT,
            attempt_id: handle.attempt_id,
            generation: handle.generation,
          } as EngineEvent
        }
      },
      async stop() {},
    },
  }
}

const started = (): EngineEventBody => ({
  type: 'session_started',
  session_id: 'sess_fake',
  engine: 'claude',
  engine_version: '2.1.317',
})

const exited = (): EngineEventBody => ({ type: 'exit', code: 0, terminal_reason: 'completed' })

const toolCall = (tool: string, input: unknown): EngineEventBody => ({
  type: 'tool_call',
  tool,
  input: input as never,
  ok: true,
})

const validTasks = [
  { id: 'task_docs', objective: 'Document installation', depends_on: [], role: 'test_author' },
  { id: 'task_example', objective: 'Add the command example', depends_on: ['task_docs'] },
]

describe('RealClaudeBrain over a fake adapter', () => {
  it('derives ack and plan from the tool-protocol stream', async () => {
    const { engine, specs } = fakeEngine([
      started(),
      toolCall('mcp__mec__acknowledge', { message_id: 'msg_turn', text: 'On it' }),
      toolCall('mcp__mec__propose_plan', {
        work_item: 'wi_turn',
        tasks: validTasks,
      }),
      { type: 'message', role: 'assistant', text: 'Done planning.' },
      exited(),
    ])
    const brain = new RealClaudeBrain({
      slotDir: '/slots/claude/meta-a',
      toolsSecret: 'unit-secret',
      now: NOW,
      adapter: engine,
    })
    const decision = await brain.decide({ messageText: 'Add install docs', liveWork: [] })

    expect(decision.ack).toBe('On it')
    expect(decision).toEqual({
      ack: 'On it',
      plan: {
        tasks: [
          { taskId: 'task_docs', objective: 'Document installation', dependsOn: [], role: 'test_author' },
          {
            taskId: 'task_example',
            objective: 'Add the command example',
            dependsOn: ['task_docs'],
            role: 'implementer',
          },
        ],
      },
    })

    // The launch the brain built: read-only, prompt-free, six turns, protocol in the objective.
    const brief = specs[0]?.brief
    expect(brief?.isolation).toEqual({
      sandbox: 'required',
      read_only: true,
      allow_write: [],
      deny_read: [],
      allowed_domains: [],
      blocked_commands: [],
      background_cap_ms: 30 * 60_000,
      permission_mode: 'none',
      repo_trusted: false,
    })
    expect(brief?.budget.turns).toBe(6)
    expect(brief?.objective).toContain('Add install docs')
    expect(brief?.objective).toContain('mcp__mec__propose_plan')
    expect(brief?.role).toEqual({ name: 'meta_agent', revision: brief?.bundle_revision })
    // Slot-layer env and the settings pair the adapter reads for argv.
    expect(specs[0]?.env.CLAUDE_CONFIG_DIR).toBe('/slots/claude/meta-a')
    expect(specs[0]?.env.MEC_TOOLS_TOKEN).toBeTruthy()
    const settingsPath = brief?.env.MEC_SETTINGS_PATH ?? ''
    const mcpPath = brief?.env.MEC_MCP_CONFIG_PATH ?? ''
    expect(existsSync(settingsPath)).toBe(true)
    expect(existsSync(mcpPath)).toBe(true)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      sandbox: {
        enabled: boolean
        filesystem: { allowWrite: string[] }
        network: { allowedDomains: string[] }
      }
    }
    expect(settings.sandbox.enabled).toBe(true)
    // The brain-owned tmpdir is the one writable path; it is the settings file's grandparent.
    expect(settings.sandbox.filesystem.allowWrite).toEqual([dirname(dirname(settingsPath))])
    expect(settings.sandbox.network.allowedDomains).toContain('claude.ai')
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
      mcpServers: { mec: { url: string; headers: { Authorization: string } } }
    }
    expect(mcp.mcpServers.mec.url).toBe(brain.toolsUrl)
    expect(mcp.mcpServers.mec.headers.Authorization).toBe(`Bearer ${specs[0]?.env.MEC_TOOLS_TOKEN}`)
    await brain.close()
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('a linked slot leaves CLAUDE_CONFIG_DIR unset on the turn and on its retry', async () => {
    const { engine, specs } = fakeEngine([started(), exited()])
    const brain = new RealClaudeBrain({
      slotDir: '/home/someone/.claude',
      linked: true,
      toolsSecret: 'unit-secret',
      now: NOW,
      adapter: engine,
    })
    await brain.decide({ messageText: 'hello', liveWork: [] }).catch(() => undefined)
    await brain.close()
    expect(specs).toHaveLength(2)
    for (const spec of specs) expect(spec.env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
  })

  it('carries base_policy, the model request and the slot pin into the plan', async () => {
    const { engine } = fakeEngine([
      started(),
      toolCall('mcp__mec__acknowledge', { message_id: 'msg_turn', text: 'On it' }),
      toolCall('mcp__mec__propose_plan', {
        work_item: 'wi_turn',
        tasks: [
          { id: 'task_a', objective: 'A' },
          {
            id: 'task_b',
            objective: 'B',
            depends_on: ['task_a'],
            base_policy: 'contract',
            model_request: { tier: 'strong', reason: 'hard' },
            slot_hint: { slot_id: 'slot_x' },
          },
        ],
      }),
      exited(),
    ])
    const brain = new RealClaudeBrain({
      slotDir: '/slots/claude/meta-a',
      toolsSecret: 'unit-secret',
      now: NOW,
      adapter: engine,
    })
    const decision = await brain.decide({ messageText: 'Two', liveWork: [] })
    expect(decision.plan?.tasks[0]?.basePolicy).toBeUndefined()
    expect(decision.plan?.tasks[1]).toMatchObject({
      basePolicy: 'contract',
      modelRequest: { tier: 'strong', reason: 'hard' },
      slotHint: { slotId: 'slot_x' },
    })
  })

  it('uses the LAST valid plan when an invalid one comes first', async () => {
    const { engine } = fakeEngine([
      started(),
      toolCall('mcp__mec__acknowledge', { message_id: 'msg_turn', text: 'On it' }),
      toolCall('mcp__mec__propose_plan', {
        work_item: 'wi_turn',
        tasks: [
          { id: 'task_a', objective: 'Cycles', depends_on: ['task_b'] },
          { id: 'task_b', objective: 'Back', depends_on: ['task_a'] },
        ],
      }),
      { type: 'message', role: 'assistant', text: 'Repairing the cycle.' },
      toolCall('mcp__mec__propose_plan', {
        work_item: 'wi_turn',
        tasks: [{ id: 'task_one', objective: 'The whole request in one task' }],
      }),
      { type: 'message', role: 'assistant', text: 'Planned.' },
      exited(),
    ])
    const brain = new RealClaudeBrain({
      slotDir: '/slots/claude/meta-a',
      toolsSecret: 'unit-secret',
      now: NOW,
      adapter: engine,
    })
    const decision = await brain.decide({ messageText: 'One small fix', liveWork: [] })
    expect(decision).toEqual({
      ack: 'On it',
      plan: {
        tasks: [
          {
            taskId: 'task_one',
            objective: 'The whole request in one task',
            dependsOn: [],
            role: 'implementer',
          },
        ],
      },
    })
    await brain.close()
  })

  it('returns an ack-only decision when no plan is proposed', async () => {
    const { engine } = fakeEngine([
      started(),
      { type: 'message', role: 'assistant', text: 'Noted as context. Nothing to plan here.' },
      exited(),
    ])
    const brain = new RealClaudeBrain({
      slotDir: '/slots/claude/meta-a',
      toolsSecret: 'unit-secret',
      now: NOW,
      adapter: engine,
    })
    const decision = await brain.decide({
      messageText: 'What is the audit log?',
      liveWork: [{ workItemId: 'wi_live', stage: 'executing' }],
    })
    expect(decision).toEqual({ ack: 'Noted as context.' })
    expect('plan' in decision).toBe(false)
    await brain.close()
  })

  it('falls back to the report summary, then to the default ack, never to empty', async () => {
    const reported = new RealClaudeBrain({
      slotDir: '/slots/claude/meta-a',
      toolsSecret: 'unit-secret',
      now: NOW,
      adapter: fakeEngine([
        started(),
        toolCall('mcp__mec__report_result', { work_item: 'wi_turn', summary: 'Planned two tasks.' }),
        exited(),
      ]).engine,
    })
    await expect(reported.decide({ messageText: 'Ship it', liveWork: [] })).resolves.toEqual({
      ack: 'Planned two tasks.',
    })
    await reported.close()

    const silent = new RealClaudeBrain({
      slotDir: '/slots/claude/meta-a',
      toolsSecret: 'unit-secret',
      now: NOW,
      adapter: fakeEngine([started(), exited()]).engine,
    })
    await expect(silent.decide({ messageText: 'Ship it', liveWork: [] })).resolves.toEqual({
      ack: 'On it.',
    })
    await silent.close()
  })

  it('throws on a stream that did not complete', async () => {
    const { engine } = fakeEngine([
      started(),
      { type: 'message', role: 'assistant', text: 'Half a turn.' },
      { type: 'exit', code: 1, terminal_reason: 'api_error' },
    ])
    const brain = new RealClaudeBrain({
      slotDir: '/slots/claude/meta-a',
      toolsSecret: 'unit-secret',
      now: NOW,
      adapter: engine,
    })
    await expect(brain.decide({ messageText: 'Do a thing', liveWork: [] })).rejects.toThrow(
      "meta engine ended 'api_error'",
    )
    await brain.close()
  })

  it('executes the platform tools over the real loopback server and records the calls', async () => {
    const { engine } = fakeEngine([started(), exited()])
    const brain = new RealClaudeBrain({
      slotDir: '/slots/claude/meta-a',
      toolsSecret: 'unit-secret',
      now: NOW,
      adapter: engine,
    })
    await brain.decide({ messageText: 'Wire the tools', liveWork: [] })
    const url = brain.toolsUrl
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    if (url === undefined) throw new Error('tools server did not start')
    const token = issueToken({
      attemptId: 'att_meta',
      generation: 1,
      role: 'meta_agent',
      secret: 'unit-secret',
    })

    const call = async (name: string, args: unknown): Promise<Record<string, unknown>> => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      })
      const body = (await response.json()) as {
        result?: { content?: { text?: string }[] }
      }
      const text = body.result?.content?.[0]?.text
      return JSON.parse(text ?? '{}') as Record<string, unknown>
    }

    expect(await call('acknowledge', { message_id: 'msg_turn', text: 'On it' })).toEqual({
      ok: true,
      text: 'On it',
    })
    const cycle = await call('propose_plan', {
      work_item: 'wi_turn',
      tasks: [
        { id: 'task_a', depends_on: ['task_b'] },
        { id: 'task_b', depends_on: ['task_a'] },
      ],
    })
    expect(cycle.ok).toBe(false)
    expect((cycle.issues as string[])[0]).toContain('cycle')
    expect(
      await call('propose_plan', { work_item: 'wi_turn', tasks: [{ id: 'task_a', objective: 'Do it' }] }),
    ).toEqual({
      ok: true,
      tasks: [{ taskId: 'task_a', objective: 'Do it', dependsOn: [], role: 'implementer' }],
    })
    expect(await call('report_result', { work_item: 'wi_turn', summary: 'Planned' })).toEqual({
      ok: true,
      summary: 'Planned',
    })
    expect(await call('ask_user', { question: 'Why?' })).toEqual({ ok: true })

    expect(brain.calls.map((entry) => entry.tool)).toEqual([
      'acknowledge',
      'propose_plan',
      'propose_plan',
      'report_result',
      'ask_user',
    ])
    expect(brain.calls[0]?.at).toBe(AT)
    await brain.close()
  })
})
