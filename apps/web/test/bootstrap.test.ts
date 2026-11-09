// main.tsx, the page's first code: the approval code leaves the address before the shell mounts,
// and a shell that cannot load says so. One shell, so there is no choice to make first.
import { afterEach, describe, expect, it, vi } from 'vitest'

const order: string[] = []
let approval: () => Promise<void> = async () => {}
let mount: (container: unknown) => void = () => {}

vi.mock('../src/approval', () => ({
  startApproval: () => {
    order.push('approval')
    return approval()
  },
}))
vi.mock('../src/live/entry', () => ({
  mount: (container: unknown) => {
    order.push('mount')
    mount(container)
  },
}))

function stubRoot() {
  const root = { textContent: '' }
  vi.stubGlobal('document', { getElementById: (id: string) => (id === 'root' ? root : null) })
  return root
}

async function boot(): Promise<void> {
  vi.resetModules()
  await import('../src/main')
  await vi.waitFor(() => expect(order.length).toBeGreaterThan(0))
  // The chain is three promises long; let it settle.
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

afterEach(() => {
  order.length = 0
  approval = async () => {}
  mount = () => {}
  vi.unstubAllGlobals()
})

describe('the bootstrap', () => {
  it('reads the approval code before the shell mounts, then mounts it on #root', async () => {
    const root = stubRoot()
    let seen: unknown
    let release = () => {}
    approval = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    mount = (container) => {
      seen = container
    }
    await boot()
    // Nothing mounts while the code is still being redeemed.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(order).toEqual(['approval'])
    release()
    await vi.waitFor(() => expect(order).toEqual(['approval', 'mount']))
    expect(seen).toBe(root)
  })

  it('a shell that cannot load says so on the page', async () => {
    const root = stubRoot()
    mount = () => {
      throw new Error('chunk failed')
    }
    await boot()
    await vi.waitFor(() =>
      expect(root.textContent).toBe('The workbench could not load. Reload the page to try again.'),
    )
  })
})
