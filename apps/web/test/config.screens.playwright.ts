import { expect, type Page, test } from '@playwright/test'

/**
 * Setup, Connections and Settings through the whole live path, against the sample server in
 * fixtures/config-server.ts: real binding layer, calls, decoders and views.
 */

const HARNESS = '/test/fixtures/config-harness.html'

test.use({ timezoneId: 'UTC', locale: 'en-GB' })

async function open(page: Page, route: string, query = ''): Promise<void> {
  await page.goto(`${HARNESS}?${query}#${route}`)
  await expect(page.locator('.shell')).toBeVisible()
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const box = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  expect(box.width, 'document width').toBeLessThanOrEqual(box.innerWidth)
}

const connection = (page: Page, label: string) => page.locator('.connection').filter({ hasText: label })

test('retire arms, names the loss and disarms', async ({ page }) => {
  await open(page, 'slots')
  const row = connection(page, 'sample-key')
  await row.getByRole('button', { name: 'Retire', exact: true }).click()

  await expect(row.getByText('destroyed and cannot be recovered')).toBeVisible()
  await expect(row.getByText('1 running and 2 queued')).toBeVisible()
  const confirm = row.getByRole('button', { name: 'Retire sample-key' })
  await expect(confirm).toBeDisabled()

  await row.getByLabel('Type sample-key to confirm').fill('sample')
  await expect(confirm).toBeDisabled()

  await row.getByRole('button', { name: 'Keep this connection' }).click()
  await expect(confirm).toBeHidden()
  await expect(connection(page, 'sample-key')).toBeVisible()

  await row.getByRole('button', { name: 'Retire', exact: true }).click()
  await row.getByLabel('Type sample-key to confirm').press('Escape')
  await expect(confirm).toBeHidden()

  await row.getByRole('button', { name: 'Retire', exact: true }).click()
  await row.getByLabel('Type sample-key to confirm').fill('sample-key')
  await row.getByRole('button', { name: 'Retire sample-key' }).click()
  await expect(connection(page, 'sample-key')).toHaveCount(0)
})

test('an expired sign-in offers Sign in again, and Drain says why it is off', async ({ page }) => {
  await open(page, 'slots')
  const row = connection(page, 'sample-expired')
  await expect(row.getByRole('button', { name: 'Sign in again' })).toBeVisible()
  await expect(row.getByRole('button', { name: 'Drain' })).toBeDisabled()
  await expect(page.getByText('Draining a connection is not available')).toBeVisible()
  await expect(row.getByText('No reading yet')).toBeVisible()
})

async function startSignIn(page: Page): Promise<void> {
  await page.getByLabel(/Sign in to a dedicated connection/).check()
  await page.getByLabel('Connection name').fill('sample-new')
  await page.getByRole('button', { name: 'Start sign-in' }).click()
}

test('a sign-in that starts shows its card', async ({ page }) => {
  await open(page, 'setup', 'empty=1')
  await startSignIn(page)
  await expect(page.getByText('Waiting for the sign-in command…')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel sign-in' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('a sign-in that fails to start says so and keeps no waiting card', async ({ page }) => {
  await open(page, 'setup', 'empty=1&fail=/api/slots/login')
  await startSignIn(page)
  await expect(page.getByRole('alert')).toContainText('sample failure')
  await expect(page.getByRole('alert')).toContainText('did not start')
  await expect(page.getByText('Waiting for the sign-in command…')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Cancel sign-in' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start sign-in' })).toBeEnabled()
  await expect(page.getByLabel('Connection name')).toHaveValue('sample-new')
  await expect(page.getByText('A connection exists, but none has passed')).toBeVisible()
})

test('Sign in again that fails to start says so and keeps no waiting card', async ({ page }) => {
  await open(page, 'slots', 'fail=/api/slots/login')
  await connection(page, 'sample-expired').getByRole('button', { name: 'Sign in again' }).click()
  await expect(page.getByRole('alert')).toContainText('sample failure')
  await expect(page.getByText('Waiting for the sign-in command…')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Cancel sign-in' })).toHaveCount(0)
})

test('trust arms and disarms', async ({ page }) => {
  await open(page, 'settings')
  await page.getByRole('button', { name: 'Repositories' }).click()
  await page.getByRole('button', { name: 'Trust…' }).click()
  await expect(page.getByText('can run commands on this machine')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByText('can run commands on this machine')).toBeHidden()
  await expect(page.getByText('Untrusted: engines ignore')).toBeVisible()

  await page.getByRole('button', { name: 'Trust…' }).click()
  await page.getByRole('button', { name: 'Trust this repository' }).click()
  await expect(page.getByText('Trusted: engines honour')).toBeVisible()
})

test('settings failure leaves navigation usable', async ({ page }) => {
  await open(page, 'settings', 'fail=/api/policy')
  await expect(page.getByRole('alert').getByText('Could not load the policy')).toBeVisible()
  await page.getByRole('button', { name: 'Backups' }).click()
  await expect(page.getByRole('button', { name: 'Back up now' })).toBeEnabled()
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Work' }).click()
  await expect(page).toHaveURL(/work$/)
})

test('a stale save keeps the draft and says so', async ({ page }) => {
  await open(page, 'settings')
  const text = page.getByLabel('Policy file')
  await text.fill('{"preAuthorised":{"install":[]}}')
  await expect(page.getByText('Unsaved changes')).toBeVisible()
  await page.evaluate(() => window.__server.saveElsewhere())
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Your draft is kept')).toBeVisible()
  await expect(text).toHaveValue('{"preAuthorised":{"install":[]}}')

  await page.getByRole('button', { name: 'Keep my draft on the newest version' }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved, not yet in force')).toBeVisible()
  await expect(page.getByText('Unsaved changes')).toBeHidden()
})

test('saved is not shown before the server confirms', async ({ page }) => {
  await open(page, 'settings', 'hold=1')
  await page.getByLabel('Policy file').fill('{"preAuthorised":{"install":[]}}')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeDisabled()
  await expect(page.getByText('Saved.', { exact: true })).toHaveCount(0)
  await page.evaluate(() => {
    for (const release of window.__held) release()
  })
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible()
})

test('leaving a section keeps its draft and marks it', async ({ page }) => {
  await open(page, 'settings')
  await page.getByLabel('Policy file').fill('{"preAuthorised":{"spend":[]}}')
  await page.getByRole('button', { name: 'Models' }).click()
  await expect(page.getByLabel('Capability table')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Policy Unsaved' })).toBeVisible()
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Work' }).click()
  await page
    .getByRole('navigation', { name: 'Configuration' })
    .getByRole('button', { name: 'Settings' })
    .click()
  await page.getByRole('button', { name: 'Policy Unsaved' }).click()
  await expect(page.getByLabel('Policy file')).toHaveValue('{"preAuthorised":{"spend":[]}}')
})

test('a refused save shows the reason the server gave and keeps the draft', async ({ page }) => {
  await open(page, 'settings')
  const text = page.getByLabel('Policy file')
  await text.fill('{"preAuthorised":{"pr_merge":[]}}')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    page.getByText("Not saved: invalid_policy: class 'pr_merge' is always-confirm (§13)"),
  ).toBeVisible()
  await expect(text).toHaveValue('{"preAuthorised":{"pr_merge":[]}}')

  await page.getByRole('button', { name: 'Models' }).click()
  await page.getByLabel('Capability table').fill('tiers: [unterminated')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    page.getByText('Not saved: invalid models table: line 1: unterminated flow sequence'),
  ).toBeVisible()
})

test('a refused proposal shows the reason the server gave', async ({ page }) => {
  await open(page, 'settings')
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByRole('alert')).toContainText("invalid_policy: class 'pr_merge' is always-confirm")
})

test('a proposal changes nothing until Apply', async ({ page }) => {
  await open(page, 'settings')
  await expect(page.getByText('Sample proposal from setup chat')).toBeVisible()
  await expect(page.getByText('Default, never saved')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply' })).toBeEnabled()
})

test('compare shows what differs from the default', async ({ page }) => {
  await open(page, 'settings')
  await page.getByRole('button', { name: 'Prompts' }).click()
  await page.getByLabel('rules text').fill('SAMPLE-ONLY shared text\nline changed')
  await page.getByRole('button', { name: 'Compare with default' }).click()
  await expect(page.locator('.diff-removed')).toHaveText('- line two\n')
  await expect(page.locator('.diff-added')).toHaveText('+ line changed\n')
})

test('setup shows what is true, and Finish says why it is shut', async ({ page }) => {
  await open(page, 'setup')
  await expect(page.locator('.stage')).toHaveCount(5)
  await expect(page.getByRole('button', { name: 'Finish' })).toBeDisabled()
  await expect(page.getByText('Meta agent is still needed')).toBeVisible()
  await expect(page.getByText('sample-max', { exact: true })).toBeVisible()
  await expect(page.getByText('sample-expired is not healthy')).toBeVisible()
  await expect(page.getByText('reads its README')).toHaveCount(0)
})

test('an empty install starts at the first missing stage with the shared form', async ({ page }) => {
  await open(page, 'setup', 'empty=1')
  await expect(page.getByRole('button', { name: 'Add connection' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Finish' })).toBeDisabled()
})

test('Open Repositories lands on Repositories', async ({ page }) => {
  await open(page, 'setup', 'nochecks=1')
  await page.getByRole('button', { name: 'Open Repositories' }).click()
  await expect(page).toHaveURL(/settings$/)
  await expect(page.getByRole('button', { name: 'Trust…' })).toBeVisible()
  await expect(page.getByLabel('Policy file')).toHaveCount(0)
})

test('the add form offers only what an engine supports', async ({ page }) => {
  await open(page, 'slots')
  await page.getByRole('button', { name: 'Add connection' }).click()
  await page.getByLabel('Engine').selectOption({ label: 'Codex' })
  await expect(page.getByRole('radio')).toHaveCount(1)
  await expect(page.getByLabel(/Sign in to a dedicated connection/)).toBeChecked()
  await expect(page.getByText('was not found on PATH')).toBeVisible()
})

test('pause sits beside Needs you and waits for the server', async ({ page }) => {
  await open(page, 'chat', 'hold=1')
  const button = page.getByRole('button', { name: 'Pause processing' })
  await button.click()
  await expect(page.getByText('Processing paused')).toHaveCount(0)
  await page.evaluate(() => {
    for (const release of window.__held) release()
  })
  await expect(page.getByText('Processing paused')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume processing' })).toBeVisible()
})

test('backup reports what the server said', async ({ page }) => {
  await open(page, 'settings')
  await page.getByRole('button', { name: 'Backups' }).click()
  await page.getByRole('button', { name: 'Back up now' }).click()
  await expect(page.getByText('Backed up as sample.tgz')).toBeVisible()
})

test.describe('at 390', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  for (const route of ['setup', 'slots', 'settings'] as const) {
    test(`no horizontal scroll at 390: ${route}`, async ({ page }) => {
      await open(page, route)
      await expect(page.locator('.page')).toBeVisible()
      await noHorizontalScroll(page)
    })
  }

  test('no horizontal scroll at 390: prompts', async ({ page }) => {
    await open(page, 'settings')
    await page.getByRole('button', { name: 'Prompts' }).click()
    await expect(page.getByLabel('rules text')).toBeVisible()
    await noHorizontalScroll(page)
  })
})

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' })

  test('reduced motion leaves no transition on the armed panel', async ({ page }) => {
    await open(page, 'slots')
    const row = connection(page, 'sample-key')
    await row.getByRole('button', { name: 'Retire', exact: true }).click()
    const duration = await row
      .locator('.armed-panel')
      .evaluate((node) => getComputedStyle(node).transitionDuration)
    expect(Number.parseFloat(duration)).toBe(0)
  })
})

for (const theme of ['light', 'dark'] as const) {
  test(`baselines in ${theme}`, async ({ page }) => {
    await page.addInitScript((value) => {
      try {
        localStorage.setItem('mec-next-theme', value)
      } catch {}
    }, theme)
    await page.setViewportSize({ width: 1440, height: 900 })
    for (const route of ['setup', 'slots', 'settings'] as const) {
      await open(page, route)
      await expect(page.locator('.page')).toBeVisible()
      await expect(page).toHaveScreenshot(`config-${route}-${theme}.png`, { fullPage: false })
    }
  })
}
