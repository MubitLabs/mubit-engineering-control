import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeResumable } from '../src/live/events'
import { createInspection, type InspectionClient } from '../src/live/inspection'
import { createWorkspace, type WorkspaceClient } from '../src/live/workspace'
import { taskDetails } from './fixtures/inspection-fixtures'

/**
 * One merged connection that outlives a failure. The class below stands in for the browser's
 * EventSource: native reconnect replays the `after` in the original URL, so the client closes on
 * `error` and opens again from its own cursors.
 */

class FakeEventSource {
  static open: FakeEventSource[] = []
  static made: FakeEventSource[] = []
  readonly url: string
  onopen: (() => void) | null = null
  onmessage: ((message: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  private listeners = new Map<string, () => void>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.made.push(this)
    FakeEventSource.open.push(this)
  }

  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener)
  }

  close() {
    this.closed = true
    FakeEventSource.open = FakeEventSource.open.filter((source) => source !== this)
  }

  deliver(stream: string, seq: number) {
    this.onmessage?.({ data: JSON.stringify({ stream, seq, kind: 'x' }) })
  }

  dispatch(type: string) {
    this.listeners.get(type)?.()
  }

  after(): string {
    return new URL(this.url, 'http://x').searchParams.get('after') ?? ''
  }

  streams(): string {
    return new URL(this.url, 'http://x').searchParams.get('stream') ?? ''
  }
}

const latest = () => FakeEventSource.made.at(-1) as FakeEventSource

beforeEach(() => {
  vi.useFakeTimers()
  FakeEventSource.open = []
  FakeEventSource.made = []
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('subscribeResumable', () => {
  it('reopen uses latest cursors', async () => {
    const seen: number[] = []
    const stop = subscribeResumable(
      [
        { stream: 'work:a', after: 5 },
        { stream: 'repositories', after: 0 },
      ],
      (event) => seen.push(event.seq),
    )
    expect(latest().after()).toBe('5,0')
    latest().deliver('work:a', 6)
    latest().deliver('work:a', 7)
    latest().deliver('repositories', 2)

    const first = latest()
    first.onerror?.()
    expect(first.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(FakeEventSource.made).toHaveLength(2)
    expect(latest().after()).toBe('7,2')
    expect(seen).toEqual([6, 7, 2])
    stop()
  })

  it('asks for compact frames, and a compact frame still moves the cursor', () => {
    const seen: number[] = []
    subscribeResumable([{ stream: 'attempt:a', after: 1 }], (event) => seen.push(event.seq))
    expect(new URL(latest().url, 'http://x').searchParams.get('compact')).toBe('1')
    latest().onmessage?.({
      data: JSON.stringify({ stream: 'attempt:a', seq: 2, type: 'tool_call', at: 'now' }),
    })
    latest().onerror?.()
    expect(seen).toEqual([2])
  })

  it('only one connection is ever open', async () => {
    const stop = subscribeResumable([{ stream: 'work:a', after: 0 }], () => {})
    for (let i = 0; i < 4; i += 1) {
      latest().onerror?.()
      expect(FakeEventSource.open).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(FakeEventSource.open).toHaveLength(1)
    }
    stop()
    expect(FakeEventSource.open).toHaveLength(0)
  })

  it('a replayed event is applied once', () => {
    const seen: number[] = []
    subscribeResumable([{ stream: 'work:a', after: 5 }], (event) => seen.push(event.seq))
    latest().deliver('work:a', 5)
    latest().deliver('work:a', 6)
    latest().deliver('work:a', 6)
    expect(seen).toEqual([6])
  })

  it('stopping cancels a reopen that was waiting', async () => {
    const stop = subscribeResumable([{ stream: 'work:a', after: 0 }], () => {})
    latest().onerror?.()
    stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeEventSource.made).toHaveLength(1)
  })

  it('backs off while the server stays away, and says when it returns', async () => {
    const reopened: number[] = []
    subscribeResumable([{ stream: 'work:a', after: 0 }], () => {}, {
      onReopen: () => reopened.push(1),
    })
    latest().onopen?.()
    expect(reopened).toEqual([])
    latest().onerror?.()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(FakeEventSource.made).toHaveLength(2)
    latest().onerror?.()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(FakeEventSource.made).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(FakeEventSource.made).toHaveLength(3)
    latest().onopen?.()
    expect(reopened).toEqual([1])
  })
})

describe('compact frames', () => {
  const ATTEMPT = 'attempt_active'
  const frame = (stream: string, seq: number) =>
    latest().onmessage?.({
      data: JSON.stringify({ stream, seq, type: 'tool_call', at: '2026-11-05T10:00:00.000Z' }),
    })

  async function live() {
    const reads = { chat: 0, work: 0, snapshot: 0, inspectWork: 0, task: 0, activity: 0 }
    const client: WorkspaceClient = {
      repositories: async () => [],
      chat: async () => {
        reads.chat += 1
        return []
      },
      work: async () => {
        reads.work += 1
        return []
      },
      snapshot: async () => {
        reads.snapshot += 1
        return { cursors: { repositories: 1, 'work:w': 3 }, labels: {} }
      },
      subscribe: subscribeResumable,
    }
    const reader = {
      meta: async () => ({ observedAt: '', connection: null, repositories: [] }),
      work: async () => {
        reads.inspectWork += 1
        return { items: [], nextCursor: null, observedAt: '' }
      },
      needs: async () => ({ items: [], nextCursor: null, observedAt: '' }),
      taskDetail: async () => {
        reads.task += 1
        return taskDetails.task_active
      },
      activity: async () => {
        reads.activity += 1
        return { items: [], nextCursor: null, observedAt: '' }
      },
    } as unknown as InspectionClient
    const workspace = createWorkspace(client)
    const inspection = createInspection(reader)
    workspace.onRefresh(inspection.refresh)
    workspace.onInvalidate(inspection.invalidate)
    workspace.setScope('repo_a')
    workspace.start()
    await vi.advanceTimersByTimeAsync(0)
    inspection.selectTask('task_active')
    await vi.advanceTimersByTimeAsync(0)
    workspace.followAttempt({ stream: `attempt:${ATTEMPT}`, after: 4 })
    return { reads }
  }

  it('compact frame invalidates one read', async () => {
    const { reads } = await live()
    const before = { ...reads }
    frame(`attempt:${ATTEMPT}`, 5)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(reads).toEqual({ ...before, activity: before.activity + 1 })
  })

  it('a burst of frames is one read', async () => {
    const { reads } = await live()
    const before = reads.activity
    frame(`attempt:${ATTEMPT}`, 5)
    frame(`attempt:${ATTEMPT}`, 6)
    frame(`attempt:${ATTEMPT}`, 7)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(reads.activity).toBe(before + 1)
  })

  it('a frame on a work stream still refreshes the lists', async () => {
    const { reads } = await live()
    const before = { ...reads }
    frame('work:w', 4)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(reads.work).toBeGreaterThan(before.work)
    expect(reads.inspectWork).toBe(before.inspectWork + 1)
  })
})

describe('the workspace on one connection', () => {
  function rig() {
    let snapshots = 0
    let resolveSnapshot: (cursors: Record<string, number>) => void = () => {}
    const client: WorkspaceClient = {
      repositories: async () => [],
      chat: async () => [],
      work: async () => [],
      snapshot: () => {
        snapshots += 1
        return new Promise((resolve) => {
          resolveSnapshot = (cursors) => resolve({ cursors, labels: {} })
        })
      },
      subscribe: subscribeResumable,
    }
    const workspace = createWorkspace(client)
    return {
      workspace,
      snapshots: () => snapshots,
      answer: async (cursors: Record<string, number>) => {
        resolveSnapshot(cursors)
        await vi.advanceTimersByTimeAsync(0)
      },
    }
  }

  it('follows the snapshot’s cursors, so history is not replayed', async () => {
    const { workspace, answer } = rig()
    workspace.start()
    await answer({ repositories: 9, 'work:a': 4 })
    expect(latest().streams()).toBe('repositories,work:a')
    expect(latest().after()).toBe('9,4')
    expect(FakeEventSource.open).toHaveLength(1)
  })

  it('reset triggers one snapshot', async () => {
    const { workspace, snapshots, answer } = rig()
    workspace.start()
    await answer({ repositories: 9 })
    expect(snapshots()).toBe(1)

    latest().dispatch('reset')
    latest().dispatch('reset')
    expect(snapshots()).toBe(2)
    await answer({ repositories: 40 })

    expect(snapshots()).toBe(2)
    expect(latest().after()).toBe('40')
    expect(FakeEventSource.open).toHaveLength(1)
    expect(workspace.getState().resetAt).not.toBeNull()
  })

  it('a selected attempt joins the one connection, at the cursor it was given', async () => {
    const { workspace, answer } = rig()
    workspace.start()
    await answer({ repositories: 9 })
    workspace.followAttempt({ stream: 'attempt:a', after: 12 })
    expect(FakeEventSource.open).toHaveLength(1)
    expect(latest().streams()).toBe('repositories,attempt:a')
    expect(latest().after()).toBe('9,12')
    workspace.followAttempt({ stream: 'attempt:a', after: 30 })
    expect(latest().after()).toBe('9,12')
    // A later delivery read cannot skip frames: the next connection still starts from 12.
    workspace.start()
    await answer({ repositories: 9 })
    expect(latest().after()).toBe('9,12')
    workspace.followAttempt(null)
    expect(latest().streams()).toBe('repositories')
    expect(FakeEventSource.open).toHaveLength(1)
  })

  it('a reset drops the attempt, so its old cursor cannot reset the new connection', async () => {
    const { workspace, answer } = rig()
    workspace.start()
    await answer({ repositories: 9 })
    workspace.followAttempt({ stream: 'attempt:a', after: 12 })
    latest().dispatch('reset')
    workspace.followAttempt({ stream: 'attempt:a', after: 12 })
    await answer({ repositories: 40 })
    expect(latest().streams()).toBe('repositories')
    workspace.followAttempt({ stream: 'attempt:a', after: 20_000 })
    expect(latest().streams()).toBe('repositories,attempt:a')
    expect(latest().after()).toBe('40,20000')
  })

  it('a reset cursor can move backwards, because the old history is gone', async () => {
    const { workspace, answer } = rig()
    workspace.start()
    await answer({ repositories: 90 })
    latest().dispatch('reset')
    await answer({ repositories: 3 })
    expect(latest().after()).toBe('3')
  })
})
