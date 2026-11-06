import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LiveApp } from '../../src/live/LiveApp'
import '../../src/next/styles'
import '../../src/live/live.css'
import { sampleServer } from './config-server'

/**
 * The whole live path against an in-page sample server: real binding layer, real calls, real
 * decoders, real views. Only `fetch` and `EventSource` are replaced, and only here. `?fail=` and
 * `?delay=` come from the address, so a test can hold a save open or refuse a read.
 */
const params = new URLSearchParams(window.location.search)
const server = sampleServer({
  fail: params.get('fail')?.split(',') ?? [],
  empty: params.has('empty'),
  noChecks: params.has('nochecks'),
  longProposals: params.has('longproposals'),
})

declare global {
  interface Window {
    __server: typeof server
    __held: Array<() => void>
  }
}
window.__server = server
window.__held = []

const hold = params.has('hold')
window.fetch = async (input, init) => {
  const url = new URL(String(input), window.location.origin)
  const response = server.respond(url.pathname, init?.method ?? 'GET', init?.body)
  if (hold && (init?.method ?? 'GET') !== 'GET') {
    await new Promise<void>((resolve) => window.__held.push(resolve))
  }
  return response
}
window.EventSource = class {
  addEventListener() {}
  onmessage = null
  close() {}
} as unknown as typeof EventSource

const container = document.getElementById('root')
if (!container) throw new Error('expected #root')
createRoot(container).render(
  <StrictMode>
    <LiveApp />
  </StrictMode>,
)
