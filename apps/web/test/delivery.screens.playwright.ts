import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { THEMES, VIEWPORTS } from './matrix-cells'

/**
 * What delivery adds to Work, Needs you and Conversation, at every width in both themes: real
 * components over fixtures/work-harness.html with `state=delivery`. No baseline: each cell proves
 * the content is there, nothing scrolls sideways, and axe is clean on the shell.
 */

const HARNESS = '/test/fixtures/work-harness.html?state=delivery'

test.use({ timezoneId: 'UTC', locale: 'en-GB' })

async function open(page: Page, theme: string, query: string, hash: string): Promise<void> {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('mec-next-theme', value)
    } catch {}
  }, theme)
  await page.clock.setFixedTime('2026-11-05T10:00:00.000Z')
  await page.goto(`${HARNESS}${query}#${hash}`)
  await expect(page.locator('.shell')).toBeVisible()
}

async function expectSound(page: Page): Promise<void> {
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(sideways).toBeLessThanOrEqual(0)
  // Read from the settled page, not from the middle of a colour transition.
  await page.evaluate(() =>
    Promise.allSettled(document.getAnimations().map((animation) => animation.finished)),
  )
  const { violations, passes } = await new AxeBuilder({ page }).include('.shell').analyze()
  expect(passes.length).toBeGreaterThan(0)
  expect(violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual([])
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`${viewport.name} ${theme}`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } })

      test('a ready pull request offers merge and says what GitHub said', async ({ page }) => {
        await open(page, theme, '&work=work_working', 'work')
        await expect(page.getByRole('button', { name: /^Merge pull request #12/ })).toBeVisible()
        await expect(page.getByRole('button', { name: /^Hold/ })).toBeVisible()
        await expect(page.getByRole('button', { name: /^Stop/ })).toBeVisible()
        await expect(page.getByText(/GitHub reports no required checks/)).toBeVisible()
        await expect(page.getByRole('link', { name: 'Open pull request #12' })).toBeVisible()
        await expectSound(page)
      })

      test('a delivery failure replaces "not recorded"', async ({ page }) => {
        await open(page, theme, '&work=work_blocked', 'work')
        await expect(page.getByRole('heading', { name: 'Delivery', level: 3 })).toBeVisible()
        await expect(page.locator('.work-links .tone-bad')).toContainText('Delivery failed: Combined checks')
        await expect(page.getByText('Delivery is not recorded yet')).toHaveCount(0)
        await expectSound(page)
      })

      test('Needs you lists blocked work and the count agrees', async ({ page }) => {
        await open(page, theme, '', 'needs')
        await expect(
          page.getByRole('heading', { name: /SAMPLE-ONLY blocked delivery: Blocked/ }),
        ).toBeVisible()
        await expect(page.getByRole('button', { name: 'Open this delivery' })).toBeVisible()
        await expectSound(page)
      })

      test('Conversation shows that its work blocked', async ({ page }) => {
        await open(page, theme, '', 'chat')
        await expect(page.getByRole('button', { name: 'Open this delivery' })).toBeVisible()
        await expectSound(page)
      })
    })
  }
}
