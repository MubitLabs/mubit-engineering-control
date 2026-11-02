import { appendFile, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AttemptJournal } from '../src/journal'

const init = {
  generation: 1,
  phase: 'active' as const,
  agentKind: 'fake',
  nativeSessionRef: null,
  workdir: null,
  start: { taskKey: 'T1' },
}

describe('AttemptJournal', () => {
  it('assigns increasing sequences and persists every event before returning', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mec-journal-'))
    const j = await AttemptJournal.open(root, 'r1', 'a1', init)
    const e0 = await j.append('attempt.preparing', {})
    const e1 = await j.append('agent.message', { text: 'hi' })
    expect([e0.sequence, e1.sequence]).toEqual([0, 1])
    expect(e0).toMatchObject({ runnerId: 'r1', attemptId: 'a1', generation: 1, schemaVersion: 1 })
    const lines = (await readFile(path.join(root, 'a1', 'events.jsonl'), 'utf8')).trim().split('\n')
    expect(lines.map((l) => JSON.parse(l).eventId)).toEqual([e0.eventId, e1.eventId])
    await j.close()
  })

  it('replays only unacknowledged events after reopening', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mec-journal-'))
    const j = await AttemptJournal.open(root, 'r1', 'a1', init)
    for (let i = 0; i < 5; i++) await j.append('agent.message', { i })
    await j.ack(2)
    expect(j.pending().map((e) => e.sequence)).toEqual([3, 4])
    await j.close()

    const reopened = await AttemptJournal.open(root, 'r1', 'a1')
    expect(reopened.pending().map((e) => e.sequence)).toEqual([3, 4])
    const next = await reopened.append('agent.message', {})
    expect(next.sequence).toBe(5)
    await reopened.close()
  })

  it('survives a torn final line from a crash mid-write', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mec-journal-'))
    const j = await AttemptJournal.open(root, 'r1', 'a1', init)
    await j.append('agent.message', {})
    await j.close()
    await appendFile(path.join(root, 'a1', 'events.jsonl'), '{"schemaVersion":1,"eventId":"to')
    const reopened = await AttemptJournal.open(root, 'r1', 'a1')
    expect(reopened.lastSequence).toBe(0)
    expect((await reopened.append('agent.message', {})).sequence).toBe(1)
    await reopened.close()
  })

  it('records processed command ids so a redelivered command runs once', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mec-journal-'))
    const j = await AttemptJournal.open(root, 'r1', 'a1', init)
    await j.recordCommand('cmd-1')
    await j.close()
    const reopened = await AttemptJournal.open(root, 'r1', 'a1')
    expect(reopened.hasCommand('cmd-1')).toBe(true)
    expect(reopened.hasCommand('cmd-2')).toBe(false)
    await reopened.close()
  })
})
