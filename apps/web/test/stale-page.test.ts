// The 9 November walkthrough: a tab left open across an upgrade (0.3.5 to 0.3.6) read "Could not read
// this delivery: The answer could not be read by this version of the page" until it was reloaded.
// A page that cannot decode an answer asks the server its version; a different one says so.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DecodeError } from '../src/api-decode'
import { createInspection, type InspectionClient } from '../src/live/inspection'
import { isStalePage, PAGE_VERSION } from '../src/live/stale'
import { DeliveryReadFailure } from '../src/next/WorkView'

const READ_AT = '2026-11-09T18:40:00.000Z'

const rig = (server: string | undefined, fail: unknown = new DecodeError('/api/inspect/work/wi_1', 'x')) => {
  const asked: number[] = []
  const client = {
    work: async () => ({ items: [], nextCursor: null, observedAt: READ_AT }),
    needs: async () => ({ items: [], nextCursor: null, observedAt: READ_AT }),
    meta: async () => ({ observedAt: READ_AT, connection: null, repositories: [] }),
    workDetail: async () => {
      throw fail
    },
  } as unknown as InspectionClient
  const serverVersion = async () => {
    asked.push(1)
    return server
  }
  return { inspection: createInspection(client, { serverVersion, pageVersion: '0.3.5' }), asked }
}

describe('a page from an older build', () => {
  it('knows its own version, from the build', () => {
    expect(PAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('is stale only when the server names a different version', () => {
    expect(isStalePage('0.3.6', '0.3.5')).toBe(true)
    expect(isStalePage('0.3.5', '0.3.5')).toBe(false)
    // A server that does not say, or cannot read its own, is no evidence of an upgrade.
    expect(isStalePage(undefined, '0.3.5')).toBe(false)
    expect(isStalePage('unknown', '0.3.5')).toBe(false)
  })

  it('an answer it cannot decode, from a newer server, marks the page stale', async () => {
    const { inspection } = rig('0.3.6')
    expect(inspection.getState().stale).toBe(false)
    inspection.selectWork('wi_1')
    await vi.waitFor(() => expect(inspection.getState().stale).toBe(true))
    expect(inspection.getState().delivery.read.status).toBe('failed')
  })

  it('the same version is a real decode bug, and keeps its own words', async () => {
    const { inspection, asked } = rig('0.3.5')
    inspection.selectWork('wi_1')
    await vi.waitFor(() => expect(asked.length).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(inspection.getState().stale).toBe(false)
  })

  it('a failure that is not a decode never asks the server', async () => {
    const { inspection, asked } = rig('0.3.6', new Error('timed out'))
    inspection.selectWork('wi_1')
    await vi.waitFor(() => expect(inspection.getState().delivery.read.status).toBe('failed'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(asked).toEqual([])
    expect(inspection.getState().stale).toBe(false)
  })
})

describe('the delivery notice', () => {
  const render = (stale: boolean) =>
    renderToStaticMarkup(
      createElement(DeliveryReadFailure, {
        stale,
        message: 'The answer could not be read by this version of the page.',
        kept: false,
        onRetry: () => {},
      }),
    )

  it('says MEC was updated and offers a reload, on a stale page', () => {
    const html = render(true)
    expect(html).toContain('MEC was updated')
    expect(html).toContain('Reload this page to continue.')
    expect(html).toContain('>Reload<')
    expect(html).not.toContain('Could not read this delivery')
  })

  it('keeps the old words and Retry for a real decode bug', () => {
    const html = render(false)
    expect(html).toContain('Could not read this delivery')
    expect(html).toContain('>Retry<')
    expect(html).not.toContain('MEC was updated')
  })
})
