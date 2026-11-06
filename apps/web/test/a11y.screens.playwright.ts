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
