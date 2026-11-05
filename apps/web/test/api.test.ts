import { afterEach, describe, expect, it } from 'vitest'
import { api, isAlreadyHandled, newIdempotencyKey, subscribeEvents } from '../src/api'

const originalFetch = globalThis.fetch
const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource

afterEach(() => {
  globalThis.fetch = originalFetch
  ;(globalThis as { EventSource?: unknown }).EventSource = originalEventSource
})

type RecordedCall = { url: string; init?: RequestInit }

/** Installs a fetch stub that answers every call from `respond`; records calls. */
function stubFetch(respond: (call: RecordedCall) => { status?: number; body: unknown }): RecordedCall[] {
  const calls: RecordedCall[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init }
    calls.push(call)
    const { status = 200, body } = respond(call)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return calls
}

function headersOf(call: RecordedCall | undefined): Record<string, string> {
  return (call?.init?.headers ?? {}) as Record<string, string>
}

function bodyOf(call: RecordedCall | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init?.body ?? '{}')) as Record<string, unknown>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('operator commands', () => {
  it('lift posts to the work item and returns the launch count', async () => {
    const calls = stubFetch(() => ({ body: { id: 'wi 1', status: 'lifted', launches: 2 } }))

    await expect(api.liftWorkItem('wi 1')).resolves.toMatchObject({ status: 'lifted', launches: 2 })

    expect(calls[0]?.url).toBe('/api/work/wi%201/lift')
    expect(calls[0]?.init?.method).toBe('POST')
  })

  it('a refused lift surfaces the 409, not a served answer', async () => {
    stubFetch(() => ({ status: 409, body: { error: 'mandate_withdrawn' } }))
    await expect(api.liftWorkItem('wi_1')).rejects.toThrow('mandate_withdrawn')
  })

  it('resume posts and processing reads the stored state', async () => {
    const calls = stubFetch(({ url }) => ({
      body: url.endsWith('/resume') ? { status: 'running' } : { paused: true, pausedAt: 'then' },
    }))

    await expect(api.resumeProcessing()).resolves.toEqual({ status: 'running' })
    await expect(api.processing()).resolves.toEqual({ paused: true, pausedAt: 'then' })

    expect(calls[0]?.url).toBe('/api/processing/resume')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[1]?.url).toBe('/api/processing')
  })
})

describe('api.sendChat', () => {
  it('attaches the given idempotency key header, the text and the reference, and parses the response', async () => {
    const calls = stubFetch(() => ({ body: { messageId: 'm_1', workItemId: 'w_9' } }))

    const result = await api.sendChat('ship it', 'w_9', 'idem-1')

    expect(result).toEqual({ messageId: 'm_1', workItemId: 'w_9' })
    const call = calls[0]
    expect(call?.url).toBe('/api/chat/messages')
    expect(call?.init?.method).toBe('POST')
    expect(headersOf(call)['x-idempotency-key']).toBe('idem-1')
    expect(bodyOf(call)).toEqual({ text: 'ship it', referencesWorkItem: 'w_9' })
  })

  it('generates a fresh UUID idempotency key per call when none is given and omits referencesWorkItem', async () => {
    const calls = stubFetch(() => ({ body: { messageId: 'm_2' } }))

    await api.sendChat('hello')
    await api.sendChat('hello again')

    const firstKey = headersOf(calls[0])['x-idempotency-key']
    const secondKey = headersOf(calls[1])['x-idempotency-key']
    expect(firstKey).toMatch(UUID_RE)
    expect(secondKey).toMatch(UUID_RE)
    expect(firstKey).not.toBe(secondKey)
    expect(bodyOf(calls[0])).toEqual({ text: 'hello' })
    expect(newIdempotencyKey()).not.toBe(firstKey)
  })
})

describe('api.resolve', () => {
  it('posts the answer and returns the status payload', async () => {
    const calls = stubFetch(() => ({ body: { status: 'approved' } }))

    await expect(api.resolve('in_7', 'approve')).resolves.toEqual({ status: 'approved' })

    const call = calls[0]
    expect(call?.url).toBe('/api/inbox/in_7/resolve')
    expect(call?.init?.method).toBe('POST')
    expect(bodyOf(call)).toEqual({ answer: 'approve' })
  })

  it('maps a 409 to an error carrying alreadyHandled: true', async () => {
    stubFetch(() => ({ status: 409, body: { error: 'already_handled' } }))

    let caught: unknown
    try {
      await api.resolve('in_7', 'deny')
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({ alreadyHandled: true })
    expect(isAlreadyHandled(caught)).toBe(true)
  })
})

describe('api reads', () => {
  it('status() GETs /api/status and returns the snapshot', async () => {
    const snapshot = {
      runtime: { state: 'ready', instances: 1, answering: true },
      parts: { 'slot:max-1': { state: 'ok' } },
      setup: { has_slot: true, has_repository: false },
    }
    const calls = stubFetch(() => ({ body: snapshot }))

    await expect(api.status()).resolves.toEqual(snapshot)
    expect(calls[0]?.url).toBe('/api/status')
    expect(calls[0]?.init?.method).toBeUndefined()
  })

  it('chat() returns the newest-last message array', async () => {
    const messages = [
      { id: 'm_1', text: 'first', at: '2026-11-03T09:00:00Z' },
      { id: 'm_2', text: 'second', at: '2026-11-03T09:01:00Z', workItemId: 'w_1' },
    ]
    const calls = stubFetch(() => ({ body: messages }))

    await expect(api.chat()).resolves.toEqual(messages)
    expect(calls[0]?.url).toBe('/api/chat/messages')
  })

  it('inbox() and work() hit their endpoints', async () => {
    const calls = stubFetch((call) => ({
      body:
        call.url === '/api/inbox'
          ? [{ id: 'in_1', cls: 'confirmation', operationHash: 'h1', expiresAt: '2026-11-03T12:00:00Z' }]
          : [],
    }))

    await expect(api.inbox()).resolves.toHaveLength(1)
    await expect(api.work()).resolves.toEqual([])
    expect(calls.map((call) => call.url)).toEqual(['/api/inbox', '/api/work'])
  })

  it('surfaces non-2xx responses as errors', async () => {
    stubFetch(() => ({ status: 500, body: { error: 'boom' } }))
    await expect(api.work()).rejects.toThrow(/500/)
  })
})

describe('subscribeEvents', () => {
  class FakeEventSource {
    static instances: FakeEventSource[] = []
    url: string
    closed = false
    onmessage: ((event: { data: string }) => void) | null = null

    constructor(url: string) {
      this.url = url
      FakeEventSource.instances.push(this)
    }

    close(): void {
      this.closed = true
    }
  }

  it('connects with the stream and after cursor, dispatches parsed events, and disposes', () => {
    FakeEventSource.instances = []
    ;(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource

    const seen: Array<{ seq: number } & Record<string, unknown>> = []
    const dispose = subscribeEvents('fleet', 41, (event) => seen.push(event))

    const source = FakeEventSource.instances[0]
    expect(source?.url).toBe('/api/events?stream=fleet&after=41')

    source?.onmessage?.({ data: '{"seq":42,"type":"chat.message","workItemId":"w_1"}' })
    source?.onmessage?.({ data: '{"type":"frame_without_seq"}' })
    source?.onmessage?.({ data: 'not-json' })

    expect(seen).toEqual([{ seq: 42, type: 'chat.message', workItemId: 'w_1' }])

    dispose()
    expect(source?.closed).toBe(true)
  })
})
