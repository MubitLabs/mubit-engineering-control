// The browser's side of the approval key, in a stand-in window: where the key is kept, and that a
// code leaves the address before anything else happens to it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError, requestResponse } from '../src/api'
import {
  APPROVAL_HEADER,
  approvalKey,
  forgetApprovalKey,
  onApprovalChange,
  requestApprovalLink,
  startApproval,
} from '../src/approval'

const CODE = 'c'.repeat(64)
const KEY = 'k'.repeat(64)

type Sent = { path: string; init?: RequestInit }

function stubWindow(hash: string, answers: Response[] = []) {
  const stored = new Map<string, string>()
  const sent: Sent[] = []
  const replaced: string[] = []
  vi.stubGlobal('window', {
    location: { hash, pathname: '/', search: '' },
    history: { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
    sessionStorage: {
      getItem: (name: string) => stored.get(name) ?? null,
      setItem: (name: string, value: string) => stored.set(name, value),
      removeItem: (name: string) => stored.delete(name),
    },
  })
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    sent.push({ path, ...(init !== undefined && { init }) })
    return answers.shift() ?? new Response('{}', { status: 200 })
  })
  return { sent, replaced, stored }
}

const channels: { onmessage: ((event: { data: unknown }) => void) | null; posted: unknown[] }[] = []

beforeEach(() => {
  channels.length = 0
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      onmessage = null
      posted: unknown[] = []
      constructor() {
        channels.push(this)
      }
      postMessage(data: unknown) {
        this.posted.push(data)
      }
    },
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('taking a key from a link', () => {
  it('scrubs the code from the address, redeems it once, and tells the other tabs', async () => {
    const { sent, replaced } = stubWindow(`#pair=${CODE}`, [
      new Response(JSON.stringify({ key: KEY }), { status: 200 }),
    ])
    await startApproval()
    expect(replaced).toEqual(['/'])
    expect(sent).toHaveLength(1)
    expect(sent[0]?.path).toBe('/api/approval/redeem')
    expect(sent[0]?.init?.body).toBe(JSON.stringify({ code: CODE }))
    expect(approvalKey()).toBe(KEY)
    expect(channels[0]?.posted).toEqual([{ key: KEY }])
  })

  it('a code that is refused leaves no key', async () => {
    stubWindow(`#pair=${CODE}`, [new Response('{}', { status: 403 })])
    await startApproval()
    expect(approvalKey()).toBeNull()
  })

  it('an address with no code calls nothing, and asks the other tabs', async () => {
    const { sent } = stubWindow('#/work')
    await startApproval()
    expect(sent).toEqual([])
    expect(channels[0]?.posted).toEqual([{ ask: true }])
  })

  it('a tab that holds a key answers one that asks, and takes one it is sent', async () => {
    const { stored } = stubWindow('#/work')
    await startApproval()
    channels[0]?.onmessage?.({ data: { key: KEY } })
    expect(approvalKey()).toBe(KEY)
    channels[0]?.onmessage?.({ data: { ask: true } })
    expect(channels[0]?.posted.at(-1)).toEqual({ key: KEY })
    expect([...stored.values()]).toEqual([KEY])
  })
})

describe('a request', () => {
  it('carries the key once there is one, and none before', async () => {
    const { sent, stored } = stubWindow('')
    await requestResponse('/api/inbox')
    stored.set('mec.approval-key', KEY)
    await requestResponse('/api/inbox')
    const header = (index: number) =>
      (sent[index]?.init?.headers as Record<string, string> | undefined)?.[APPROVAL_HEADER]
    expect(header(0)).toBeUndefined()
    expect(header(1)).toBe(KEY)
  })

  it('a key the server refuses is forgotten, and the page hears of it', async () => {
    const { stored } = stubWindow('', [
      new Response(JSON.stringify({ error: 'approval_required' }), { status: 403 }),
    ])
    stored.set('mec.approval-key', KEY)
    const heard = vi.fn()
    const off = onApprovalChange(heard)
    await expect(requestResponse('/api/inbox/x/resolve', { method: 'POST' })).rejects.toBeInstanceOf(
      HttpError,
    )
    off()
    expect(approvalKey()).toBeNull()
    expect(heard).toHaveBeenCalledOnce()
  })

  it('asking for a link sends nothing of a key', async () => {
    const { sent } = stubWindow('')
    await requestApprovalLink()
    expect(sent[0]?.path).toBe('/api/approval/link')
    expect(JSON.stringify(sent[0]?.init)).not.toContain(KEY)
    forgetApprovalKey()
  })
})
