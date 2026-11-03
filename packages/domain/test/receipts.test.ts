import { describe, expect, it } from 'vitest'
import { ReceiptLadder } from '../src'

const ladder = () => new ReceiptLadder()

describe('ReceiptLadder', () => {
  it('walks the full ladder: received → delivered → read → handled → settled', () => {
    const l = ladder()
    expect(l.advance('m1', 'received', 't0')).toEqual({ from: 'received', to: 'received' })
    expect(l.advance('m1', 'delivered', 't1')).toEqual({ from: 'received', to: 'delivered' })
    expect(l.markTurnEnd('t2')).toEqual(['m1'])
    expect(l.stageOf('m1')).toBe('read')
    expect(l.advance('m1', 'handled', 't3')).toEqual({ from: 'read', to: 'handled' })
    expect(l.advance('m1', 'settled', 't4')).toEqual({ from: 'handled', to: 'settled' })
    expect(l.stageOf('m1')).toBe('settled')
    expect(l.unsettled()).toEqual([])
  })

  it('throws on a skip without forceStage (received → handled)', () => {
    const l = ladder()
    l.advance('m1', 'received', 't0')
    expect(() => l.advance('m1', 'handled', 't1')).toThrow(/cannot move/)
    expect(l.stageOf('m1')).toBe('received')
  })

  it('throws on a two-step skip (received → read and delivered → settled)', () => {
    const l = ladder()
    l.advance('m1', 'received', 't0')
    expect(() => l.advance('m1', 'read', 't1')).toThrow()
    l.advance('m2', 'received', 't0')
    l.advance('m2', 'delivered', 't1')
    expect(() => l.advance('m2', 'settled', 't2')).toThrow(/cannot move/)
    expect(l.stageOf('m2')).toBe('delivered')
  })

  it('throws on a regression (read → delivered)', () => {
    const l = ladder()
    l.advance('m1', 'received', 't0')
    l.advance('m1', 'delivered', 't1')
    l.markTurnEnd('t2')
    expect(() => l.advance('m1', 'delivered', 't3')).toThrow(/cannot move/)
    expect(l.stageOf('m1')).toBe('read')
  })

  it('refuses a first sighting above received', () => {
    const l = ladder()
    expect(() => l.advance('m1', 'delivered', 't0')).toThrow(/first enters the ladder at 'received'/)
    expect(l.stageOf('m1')).toBeUndefined()
  })

  it('crash between delivered and read: stays delivered, never marked handled', () => {
    const l = ladder()
    l.advance('m1', 'received', 't0')
    l.advance('m1', 'delivered', 't1')
    // Crash: no report, no turn end — a successful transport write is not 'read'.
    expect(l.stageOf('m1')).toBe('delivered')
    expect(() => l.advance('m1', 'handled', 't2')).toThrow()
    expect(l.unsettled()).toEqual(['m1'])
  })

  it('a late turn end still promotes a message delivered before a crash', () => {
    const l = ladder()
    l.advance('m1', 'received', 't0')
    l.advance('m1', 'delivered', 't1')
    // Restart, reconciliation finds the engine took m1 into its session; the next
    // report counts as the turn end for everything delivered before it.
    expect(l.markTurnEnd('t9')).toEqual(['m1'])
    expect(l.stageOf('m1')).toBe('read')
  })

  it('markTurnEnd flushes every message delivered before it, in order', () => {
    const l = ladder()
    for (const id of ['m1', 'm2', 'm3']) {
      l.advance(id, 'received', 't0')
      l.advance(id, 'delivered', 't1')
    }
    expect(l.markTurnEnd('t2')).toEqual(['m1', 'm2', 'm3'])
    expect(l.stageOf('m2')).toBe('read')
  })

  it('a message delivered after the turn end waits for the next one', () => {
    const l = ladder()
    l.advance('m1', 'received', 't0')
    l.advance('m1', 'delivered', 't1')
    expect(l.markTurnEnd('t2')).toEqual(['m1'])
    l.advance('m2', 'received', 't3')
    l.advance('m2', 'delivered', 't4')
    expect(l.markTurnEnd('t5')).toEqual(['m2'])
    expect(l.stageOf('m1')).toBe('read')
    expect(l.stageOf('m2')).toBe('read')
  })

  it('direct advance to read is refused — read is counted only after a turn end', () => {
    const l = ladder()
    l.advance('m1', 'received', 't0')
    l.advance('m1', 'delivered', 't1')
    expect(() => l.advance('m1', 'read', 't2')).toThrow(/markTurnEnd/)
    expect(l.stageOf('m1')).toBe('delivered')
  })

  it('markTurnEnd leaves received, handled and settled messages untouched', () => {
    const l = ladder()
    l.advance('m1', 'received', 't0') // not yet handed to the engine
    l.advance('m2', 'received', 't0')
    l.advance('m2', 'delivered', 't1')
    l.markTurnEnd('t2')
    l.advance('m2', 'handled', 't3')
    l.advance('m3', 'received', 't0')
    l.advance('m3', 'delivered', 't1')
    l.markTurnEnd('t2')
    l.advance('m3', 'handled', 't3')
    l.advance('m3', 'settled', 't4')
    expect(l.markTurnEnd('t5')).toEqual([])
    expect(l.stageOf('m1')).toBe('received')
    expect(l.stageOf('m2')).toBe('handled')
    expect(l.stageOf('m3')).toBe('settled')
  })

  it('same-stage advance is an idempotent no-op (journal replay after restart)', () => {
    const l = ladder()
    l.advance('m1', 'received', 't0')
    l.advance('m1', 'delivered', 't1')
    expect(l.advance('m1', 'delivered', 't1')).toEqual({ from: 'delivered', to: 'delivered' })
    expect(l.stageOf('m1')).toBe('delivered')
  })

  it('forceStage writes the reconciled truth, forward or backward, never past it', () => {
    const l = ladder()
    l.advance('m1', 'received', 't0')
    l.advance('m1', 'delivered', 't1')
    // Journal replay proves the ack landed: the durable stage write was lost.
    expect(l.forceStage('m1', 'handled', 't2')).toEqual({ from: 'delivered', to: 'handled' })
    expect(l.stageOf('m1')).toBe('handled')
    // The settled write turns out not to be durable: repair backwards to the truth.
    l.forceStage('m1', 'settled', 't3')
    expect(l.forceStage('m1', 'read', 't4')).toEqual({ from: 'settled', to: 'read' })
    expect(l.advance('m1', 'handled', 't5')).toEqual({ from: 'read', to: 'handled' })
  })

  it('unsettled lists only unsettled messages, in arrival order', () => {
    const l = ladder()
    for (const id of ['m1', 'm2', 'm3']) {
      l.advance(id, 'received', 't0')
      l.advance(id, 'delivered', 't1')
    }
    l.markTurnEnd('t2')
    l.advance('m1', 'handled', 't3')
    l.advance('m1', 'settled', 't4')
    expect(l.unsettled()).toEqual(['m2', 'm3'])
  })

  it('stageOf is undefined for an unknown message', () => {
    expect(ladder().stageOf('nope')).toBeUndefined()
  })
})
