import { describe, expect, it } from 'vitest'
import { type Address, addressHash, parseAddress } from '../src/next/address'

const at = (route: Address['route'], repoId: string | null, workId = null, taskId = null): Address => ({
  route,
  repoId,
  workId,
  taskId,
})

describe('addresses', () => {
  it('round-trips repo work task', () => {
    const address: Address = { route: 'work', repoId: 'repo_a', workId: 'wi_1', taskId: 'task_2' }
    expect(addressHash(address)).toBe('#repo/repo_a/work/wi_1/task/task_2')
    expect(parseAddress(addressHash(address))).toEqual(address)
  })

  it.each(['chat', 'work', 'needs', 'slots', 'setup', 'settings'] as const)('round-trips %s', (route) => {
    const address = at(route, 'repo_a')
    expect(addressHash(address)).toBe(`#repo/repo_a/${route}`)
    expect(parseAddress(addressHash(address))).toEqual(address)
  })

  it('percent-encodes ids', () => {
    const address: Address = { route: 'work', repoId: 'a/b c', workId: 'w#1', taskId: null }
    expect(addressHash(address)).toBe('#repo/a%2Fb%20c/work/w%231')
    expect(parseAddress(addressHash(address))).toEqual(address)
  })

  it('old hashes resolve to the active repo', () => {
    expect(parseAddress('#chat')).toEqual(at('chat', null))
    expect(parseAddress('#/work')).toEqual(at('work', null))
    expect(parseAddress('#/inbox')).toEqual(at('needs', null))
    expect(parseAddress('#wizard')).toEqual(at('setup', null))
    expect(parseAddress('')).toEqual(at('chat', null))
  })

  it('a repoless address stays the plain hash', () => {
    expect(addressHash(at('work', null))).toBe('#work')
  })

  it.each([
    '#repo',
    '#repo/',
    '#repo/a',
    '#repo//chat',
    '#repo/a/bogus',
    '#repo/a/chat/extra',
    '#repo/a/work/',
    '#repo/a/work/w/task',
    '#repo/a/work/w/task/',
    '#repo/a/work/w/task/t/more',
    '#repo/a/work/w/nope/t',
    '#repo/%E0%A4%A/chat',
  ])('a malformed address falls back to chat: %s', (hash) => {
    expect(parseAddress(hash)).toEqual(at('chat', null))
  })
})
