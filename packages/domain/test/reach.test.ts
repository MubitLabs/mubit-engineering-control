// What a slot's worker can do, and which objectives need a worker that runs commands
// (owner's horse tinder test, 9 November 2026: a browser check went to an OpenCode slot).
import { describe, expect, it } from 'vitest'
import { commandNeed, reachWords, runsCommands, type WorkerReach } from '../src/reach'

const OPENCODE: WorkerReach = { commands: false, edits: true, network: false }
const SANDBOXED: WorkerReach = { commands: true, edits: true, network: false }

describe('reach words', () => {
  it('a worker with no shell says it edits files and cannot run commands', () => {
    expect(reachWords(OPENCODE)).toBe('edits files; cannot run commands')
  })

  it('a sandboxed shell says it runs commands with no network', () => {
    expect(reachWords(SANDBOXED)).toBe('edits files; runs commands, no network')
  })

  it('a read-only worker with network says both', () => {
    expect(reachWords({ commands: true, edits: false, network: true })).toBe(
      'cannot edit files; runs commands with network',
    )
  })
})

describe('an objective that needs commands', () => {
  it('the live objective is read as needing commands', () => {
    const objective =
      'Rename top in app.js. Then actually load index.html in a real browser (e.g. headless Chromium via Playwright/Puppeteer) and verify with no console errors.'
    expect(commandNeed(objective)).toBe('browser')
  })

  it.each([
    ['Run the tests before reporting', 'run'],
    ['execute the migration script', 'execute'],
    ['check it with npm test', 'npm'],
    ['start it with node server.js', 'node'],
    ['drive it with Playwright', 'playwright'],
    ['use puppeteer for screenshots', 'puppeteer'],
    ['open it headless', 'headless'],
    ['find the test command in package.json and use it', 'test command'],
  ])('%s → %s', (objective, word) => {
    expect(commandNeed(objective)).toBe(word)
  })

  it('an edit-only objective needs no commands', () => {
    expect(commandNeed('Rename the global top in app.js to topCard and update its two call sites.')).toBe(
      undefined,
    )
  })

  it('words that only contain a command word do not count', () => {
    expect(commandNeed('Fix the runtime error in the browserslist config and the nodes list')).toBe(undefined)
  })
})

describe('which slots run commands', () => {
  it('a slot with no reach recorded is not ruled out; one that cannot is', () => {
    expect(runsCommands({ reach: OPENCODE })).toBe(false)
    expect(runsCommands({ reach: SANDBOXED })).toBe(true)
    expect(runsCommands({})).toBe(true)
  })
})
