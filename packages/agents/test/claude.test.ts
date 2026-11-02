import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classifyFailure, modeArgs, normalise, redact, redactDeep } from '../src'

const fixture = (name: string) =>
  readFileSync(new URL(`../../testkit/fixtures/claude/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

describe('stream-json normalisation', () => {
  it('turns a recorded turn into evidence events with native ids', () => {
    const all = fixture('turn-with-tool.jsonl').map((m) => normalise(m))
    const types = all.flatMap((r) => r.events.map((e) => e.type))
    expect(types).toEqual([
      'agent.session',
      'agent.message',
      'agent.tool_use',
      'agent.tool_result',
      'agent.message',
      'agent.usage',
      'agent.turn_result',
    ])
    const toolUse = all.flatMap((r) => r.events).find((e) => e.type === 'agent.tool_use')!
    expect(toolUse.payload).toMatchObject({
      toolUseId: 'toolu_01',
      name: 'Bash',
      input: { command: 'node --test' },
    })
    const result = all.find((r) => r.result)!.result!
    expect(result).toMatchObject({ ok: true, sessionId: 'sess-1', numTurns: 3 })
  })

  it('records unreported usage as unknown, not zero', () => {
    const { events } = normalise({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
    expect(events[0]!.payload).toMatchObject({ usage: null, reportedCostUsd: null })
  })

  it('does not record thinking blocks', () => {
    const { events } = normalise({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'secret reasoning' },
          { type: 'text', text: 'visible' },
        ],
      },
    })
    expect(events.map((e) => e.payload.text)).toEqual(['visible'])
  })
})

describe('failure classification', () => {
  it('separates quota and sign-in failures from ordinary errors', () => {
    expect(classifyFailure('Claude AI usage limit reached|resets 5pm (UTC)')).toMatchObject({
      status: 'quota',
    })
    expect(classifyFailure('Invalid API key · Please run /login')).toMatchObject({ status: 'auth' })
    expect(classifyFailure('TypeError: x is undefined')).toMatchObject({ status: 'failed' })
  })
})

describe('execution modes', () => {
  const allowed = (args: string[]) => {
    const i = args.indexOf('--allowedTools')
    const end = args.findIndex((a, j) => j > i && a.startsWith('--'))
    return args.slice(i + 1, end)
  }
  it('observe cannot edit or run commands', () => {
    const args = modeArgs('observe', [])
    expect(args).toContain('dontAsk')
    expect(allowed(args)).not.toEqual(expect.arrayContaining(['Edit']))
    expect(args.slice(args.indexOf('--disallowedTools'))).toEqual(
      expect.arrayContaining(['Edit', 'Write', 'Bash']),
    )
  })
  it('implement accepts edits and pre-approves only the acceptance commands', () => {
    const args = modeArgs('implement', [['node', 'checks/require-files.mjs']])
    expect(args).toContain('acceptEdits')
    expect(allowed(args)).toEqual(expect.arrayContaining(['Edit', 'Bash(node checks/require-files.mjs:*)']))
    expect(allowed(args)).not.toContain('Bash')
  })
  it('assisted surfaces edits as decisions', () => {
    const args = modeArgs('assisted', [])
    expect(args).toContain('manual')
    expect(allowed(args)).not.toContain('Edit')
  })
})

describe('redaction', () => {
  it('removes credentials before storage', () => {
    expect(redact('token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB in output')).toBe(
      'token [REDACTED GITHUB TOKEN] in output',
    )
    expect(redact('export API_KEY=supersecretvalue123')).toBe('export API_KEY=[REDACTED]')
    expect(redact('sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa')).toBe('[REDACTED ANTHROPIC KEY]')
    expect(redactDeep({ a: ['password: hunter2hunter2'], n: 1 })).toEqual({
      a: ['password: [REDACTED]'],
      n: 1,
    })
    expect(redact('ordinary text with token count 12')).toBe('ordinary text with token count 12')
  })
})
