import { describe, expect, it } from 'vitest'
import { TOOL_SPECS, type ToolName, toolsForRole } from '../src/tools'

/** Plan §6 "The platform tool set": the meta agent's only write channel. */
const PLATFORM_TOOLS: readonly ToolName[] = [
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

const SPECIALIST_TOOL_SET: readonly ToolName[] = [
  'report',
  'ask_user',
  'request_confirmation',
  'handback',
  'read',
]

const EVERY_TOOL_NAME: readonly ToolName[] = [...PLATFORM_TOOLS, 'report', 'handback']

describe('toolsForRole', () => {
  it('gives the meta agent exactly the §6 platform tool set', () => {
    expect([...toolsForRole('meta_agent')].sort()).toEqual([...PLATFORM_TOOLS].sort())
  })

  it('gives a specialist report, ask_user, request_confirmation, handback and read', () => {
    expect([...toolsForRole('specialist')].sort()).toEqual([...SPECIALIST_TOOL_SET].sort())
  })

  it('a specialist lacks the meta agent tools propose_plan and spawn_agent', () => {
    const tools = toolsForRole('specialist')
    expect(tools).not.toContain('propose_plan')
    expect(tools).not.toContain('spawn_agent')
    expect(tools).not.toContain('route')
    expect(tools).not.toContain('stop_agent')
  })
})

describe('TOOL_SPECS', () => {
  it('has a spec for every ToolName and nothing more', () => {
    expect(Object.keys(TOOL_SPECS).sort()).toEqual([...EVERY_TOOL_NAME].sort())
    for (const name of EVERY_TOOL_NAME) {
      expect(TOOL_SPECS[name]).toBeDefined()
    }
  })

  it('covers every tool each role can be given', () => {
    for (const name of [...toolsForRole('meta_agent'), ...toolsForRole('specialist')]) {
      expect(Object.hasOwn(TOOL_SPECS, name)).toBe(true)
    }
  })

  it('every description is a non-empty string of at most 200 characters', () => {
    for (const spec of Object.values(TOOL_SPECS)) {
      expect(spec.description.length).toBeGreaterThan(0)
      expect(spec.description.length).toBeLessThanOrEqual(200)
    }
  })

  it('every inputSchema is a plain JSON object schema', () => {
    for (const spec of Object.values(TOOL_SPECS)) {
      expect(spec.inputSchema.type).toBe('object')
      expect(typeof spec.inputSchema.properties).toBe('object')
      expect(JSON.parse(JSON.stringify(spec.inputSchema))).toEqual(spec.inputSchema)
    }
  })
})
