import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

/**
 * The accessibility gate (axe) of the screens suite. Like the rest of it, deliberately NOT in CI
 * or `pnpm check`: run it with `pnpm test:screens` (see docs/agent-workflow/commands.md).
 * No rule is disabled. A page passes only when its target surface is present, axe ran at least
 * one passing rule on it, and it reports no violations, so an empty page can never pass.
 */

const BROKEN = '/test/fixtures/a11y-broken.html'

type AxeOutcome = Awaited<ReturnType<AxeBuilder['analyze']>>

/** Runs axe over `surface`. Throws when the surface is missing or axe checked nothing. */
async function runAxe(page: Page, surface: string): Promise<AxeOutcome> {
  const count = await page.locator(surface).count()
  if (count === 0) throw new Error(`axe target "${surface}" is not on the page`)
  const outcome = await new AxeBuilder({ page }).include(surface).analyze()
  if (outcome.passes.length === 0) throw new Error(`axe recorded no passing rule inside "${surface}"`)
  return outcome
}

/** Fails on any violation, listing each rule with its first target. */
async function expectNoViolations(page: Page, surface: string): Promise<void> {
  const { violations } = await runAxe(page, surface)
  const lines = violations.flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`))
  expect(lines, 'axe violations').toEqual([])
}

test('axe reports violations on the broken page', async ({ page }) => {
  await page.goto(BROKEN)
  const { violations } = await runAxe(page, '#broken-surface')
  const ids = violations.map((v) => v.id)
  expect(ids).toContain('color-contrast')
  expect(ids).toContain('label')
  expect(ids).toContain('button-name')
  await expect(expectNoViolations(page, '#broken-surface')).rejects.toThrow()
})

test('an absent surface fails rather than passes', async ({ page }) => {
  await page.goto(BROKEN)
  await expect(runAxe(page, '#no-such-surface')).rejects.toThrow(/not on the page/)
  await expect(expectNoViolations(page, '#no-such-surface')).rejects.toThrow(/not on the page/)
})

test('an empty page fails rather than passes', async ({ page }) => {
  await page.goto('about:blank')
  await expect(runAxe(page, '.shell')).rejects.toThrow(/not on the page/)
})

test('the conversation shell has no violations', async ({ page }) => {
  await page.goto('/test/fixtures/next-harness.html?state=working#chat')
  await expectNoViolations(page, '.shell')
})

test('the lighthouse script exits non-zero on the broken page', async ({ baseURL }) => {
  test.setTimeout(120_000)
  const script = fileURLToPath(new URL('../scripts/lighthouse.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, `${baseURL}${BROKEN}`, '#broken'], {
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: tmpdir() },
  })
  expect(result.stdout).toContain('FAIL')
  expect(result.status).not.toBe(0)
})

// ── The six surfaces, three widths, two themes (M3.4 Stage B) ─────────────────────────────────

const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
] as const
const THEMES = ['light', 'dark'] as const

const NEXT = '/test/fixtures/next-harness.html'
const WORK = '/test/fixtures/work-harness.html'
const CONFIG = '/test/fixtures/config-harness.html'

/** `ready` is what must be on screen before axe reads it, so a half-drawn page cannot pass. */
const SURFACES = [
  { name: 'Conversation', url: `${NEXT}#chat`, ready: '.composer' },
  { name: 'Work', url: `${WORK}#work`, ready: '.page h1' },
  { name: 'Needs you', url: `${WORK}#needs`, ready: '.page h1' },
  { name: 'Connections', url: `${CONFIG}#slots`, ready: '.connection' },
  { name: 'Setup', url: `${CONFIG}#setup`, ready: '.page h1' },
  { name: 'Settings', url: `${CONFIG}#settings`, ready: '.page h1' },
] as const

const STATES = [
  { name: 'inspector', url: `${NEXT}?task=task_build&inspector=open#chat`, ready: '[role="tab"]' },
  { name: 'empty', url: `${NEXT}?state=empty#chat`, ready: '.empty' },
  { name: 'blocked', url: `${NEXT}?state=blocked&task=task_build#chat`, ready: '.conversation' },
  { name: 'error', url: `${NEXT}?state=error#chat`, ready: '.conversation' },
  { name: 'completed', url: `${NEXT}?state=completed#chat`, ready: '.conversation' },
  { name: 'state notices', url: `${NEXT}?state=states#chat`, ready: '.shell' },
  { name: 'work empty', url: `${WORK}?state=empty#work`, ready: '.page h1' },
  { name: 'work failed', url: `${WORK}?state=failed#work`, ready: '.page h1' },
  { name: 'needs empty', url: `${WORK}?state=empty#needs`, ready: '.page h1' },
] as const

async function openAt(page: Page, theme: string, url: string, ready: string): Promise<void> {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('mec-next-theme', value)
    } catch {}
  }, theme)
  await page.goto(url)
  await expect(page.locator('.shell')).toBeVisible()
  await expect(page.locator(ready).first()).toBeVisible()
  // Contrast is read from the settled page, not from the middle of a colour transition.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)))
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`${viewport.name} ${theme}`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } })

      for (const surface of SURFACES) {
        test(`${surface.name} ${viewport.name} ${theme} has no violations`, async ({ page }) => {
          await openAt(page, theme, surface.url, surface.ready)
          await expectNoViolations(page, '.shell')
        })
      }

      for (const state of STATES) {
        test(`${state.name} ${viewport.name} ${theme} has no violations`, async ({ page }) => {
          await openAt(page, theme, state.url, state.ready)
          await expectNoViolations(page, '.shell')
        })
      }

      test(`palette ${viewport.name} ${theme} has no violations`, async ({ page }) => {
        await openAt(page, theme, `${NEXT}#chat`, '.composer')
        await page.keyboard.press('Control+k')
        await expect(page.getByRole('dialog')).toBeVisible()
        await expectNoViolations(page, '[role="dialog"]')
      })

      if (viewport.width <= 760) {
        test(`drawer ${viewport.name} ${theme} has no violations`, async ({ page }) => {
          await openAt(page, theme, `${NEXT}#chat`, '.composer')
          await page.getByRole('button', { name: 'Open navigation' }).click()
          await expect(page.getByRole('dialog')).toBeVisible()
          await expectNoViolations(page, '[role="dialog"]')
        })
      }

      test(`default entry, no repository ${viewport.name} ${theme} has no violations`, async ({ page }) => {
        await page.route('**/api/**', (route) => {
          const { pathname } = new URL(route.request().url())
          if (pathname === '/api/events') {
            return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' })
          }
          if (pathname === '/api/inspect/work' || pathname === '/api/inspect/needs') {
            return route.fulfill({ json: { items: [], nextCursor: null, observedAt: '' } })
          }
          return route.fulfill({ json: [] })
        })
        await openAt(page, theme, '/#chat', '.empty')
        await expectNoViolations(page, '.shell')
      })
    })
  }
}
