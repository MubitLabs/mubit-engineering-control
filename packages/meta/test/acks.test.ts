import { describe, expect, it } from 'vitest'
import { Acknowledger } from '../src'

describe('Acknowledger (plan §12.2 / §6)', () => {
  it('acknowledges once per message id; later calls return the first text', () => {
    const acknowledger = new Acknowledger()
    const text = 'On it: adding audit-log viewing to the console and the API, with tests'
    expect(acknowledger.acknowledge('m1', text)).toEqual({ first: true, text })
    expect(acknowledger.acknowledge('m1', 'Different wording')).toEqual({ first: false, text })
    expect(acknowledger.acknowledge('m1', text)).toEqual({ first: false, text })
  })

  it('a new message gets its own acknowledgement', () => {
    const acknowledger = new Acknowledger()
    acknowledger.acknowledge('m1', 'On it: the audit task')
    expect(acknowledger.acknowledge('m2', 'On it: the release check')).toEqual({
      first: true,
      text: 'On it: the release check',
    })
  })

  it('textFor returns the recorded text and undefined for an unknown id', () => {
    const acknowledger = new Acknowledger()
    acknowledger.acknowledge('m1', 'On it: the audit task')
    expect(acknowledger.textFor('m1')).toBe('On it: the audit task')
    expect(acknowledger.textFor('m-unknown')).toBeUndefined()
  })
})
