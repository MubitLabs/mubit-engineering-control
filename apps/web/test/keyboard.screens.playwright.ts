import { expect, type Locator, type Page, test } from '@playwright/test'
import { VIEWPORTS } from './matrix-cells'

/**
 * The complete keyboard journey (M3.4 B4): every surface at every width, by keys alone. Nothing
 * here clicks, fills or calls focus(); a control a Tab cannot reach fails the journey. next.screens
 * pins the single rules. This walks them together, the way one person would.
 */

const NEXT = '/test/fixtures/next-harness.html'
const WORK = '/test/fixtures/work-harness.html'
const CONFIG = '/test/fixtures/config-harness.html'

test.use({ timezoneId: 'UTC', locale: 'en-GB' })

const isFocused = (target: Locator) =>
  target.evaluate((el) => el === document.activeElement, undefined, { timeout: 2_000 }).catch(() => false)

/** Tabs from where focus is until `target` has it. Failing to arrive is the failure. */
async function tabTo(page: Page, target: Locator, key: 'Tab' | 'Shift+Tab' = 'Tab'): Promise<void> {
  for (let press = 0; press < 70; press += 1) {
    await page.keyboard.press(key)
    if (await isFocused(target)) return
  }
  throw new Error(`Tab never reached ${target}`)
}

const shortcut = (page: Page, key: 'Control+k' | 'Meta+k') => page.keyboard.press(key)
const named = (page: Page, name: string | RegExp) =>
  page.getByRole('button', { name, exact: typeof name === 'string' })
const notOnBody = (page: Page) =>
  expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true)
const inInspector = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(() => document.activeElement?.closest('.inspector-content, [role="dialog"]') != null),
    )
    .toBe(true)

/** Reaches a surface through the rail, by way of the drawer at phone width. */
async function goTo(page: Page, name: string | RegExp): Promise<void> {
  const menu = named(page, 'Open navigation')
  if (await menu.isVisible()) {
    await tabTo(page, menu)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
  }
  await tabTo(page, named(page, name))
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

for (const viewport of VIEWPORTS) {
  const wide = viewport.width >= 1150

  test.describe(`at ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('Conversation: skip, slash, send, a task, its tabs, and back', async ({ page }) => {
      await page.goto(`${NEXT}#chat`)
      await page.keyboard.press('Tab')
      await expect(named(page, 'Skip to content')).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.locator('.scroller')).toBeFocused()

      await page.keyboard.press('/')
      const composer = page.getByRole('textbox', { name: 'Message the meta agent' })
      await expect(composer).toBeFocused()
      await page.keyboard.type('sample request')
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('sent')).toHaveText('Sent: 1')

      const row = named(page, /Build the sample search/)
      await tabTo(page, row, 'Shift+Tab')
      await page.keyboard.press('Enter')
      await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible()
      await inInspector(page)
      await tabTo(page, page.getByRole('tab', { name: 'Overview' }))
      await page.keyboard.press('ArrowRight')
      await expect(page.getByRole('tab', { name: 'Checks' })).toBeFocused()
      await expect(page.getByRole('tabpanel', { name: 'Checks' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('tab', { name: 'Overview' })).toHaveCount(0)
      await expect(row).toBeFocused()
    })

    test('the palette: both shortcuts, a command by keys, and focus back', async ({ page }) => {
      await page.goto(`${NEXT}#chat`)
      const row = named(page, /Build the sample search/)
      await tabTo(page, row)
      for (const key of ['Control+k', 'Meta+k'] as const) {
        await shortcut(page, key)
        await expect(page.getByRole('combobox')).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(row).toBeFocused()
      }
      await shortcut(page, 'Control+k')
      await shortcut(page, 'Control+k')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(row).toBeFocused()

      await shortcut(page, 'Control+k')
      await page.keyboard.type('dark')
      await expect(page.getByRole('option')).toHaveCount(1)
      await page.keyboard.press('Enter')
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await notOnBody(page)
    })

    test('the Escape chain closes one surface at a time', async ({ page }) => {
      await page.goto(`${NEXT}#chat`)
      const row = named(page, /Build the sample search/)
      await tabTo(page, row)
      await page.keyboard.press('Enter')
      await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible()
      await inInspector(page)
      await shortcut(page, 'Control+k')
      if (wide) {
        // Beside the page, the inspector stays while the palette sits over it.
        await expect(page.getByRole('combobox')).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(page.getByRole('combobox')).toHaveCount(0)
        await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible()
        await inInspector(page)
      } else {
        // A modal holds the keyboard: the palette does not open over it.
        await expect(page.getByRole('combobox')).toHaveCount(0)
      }
      await page.keyboard.press('Escape')
      await expect(page.getByRole('tab', { name: 'Overview' })).toHaveCount(0)
      await expect(row).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(row).toBeFocused()
    })

    test('Work: a delivery, a task, the glossary, search, and back', async ({ page }) => {
      await page.goto(`${WORK}#chat`)
      await goTo(page, 'Work')

      const row = page.locator('.work-row', { hasText: 'search for the console' })
      await tabTo(page, row)
      await page.keyboard.press('Enter')
      await expect(page.locator('.work-detail')).toBeVisible()
      await expect(row).toHaveAttribute('aria-current', 'true')

      const task = page.locator('.task-row', { hasText: 'build the index' })
      await tabTo(page, task)
      await page.keyboard.press('Enter')
      await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible()
      await inInspector(page)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('tab', { name: 'Overview' })).toHaveCount(0)
      await expect(task).toBeFocused()

      const glossary = named(page, 'Open glossary')
      await tabTo(page, glossary, 'Shift+Tab')
      await page.keyboard.press('Enter')
      await expect(page.getByRole('dialog')).toContainText('Attempt')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(glossary).toBeFocused()

      await shortcut(page, 'Control+k')
      await page.keyboard.type('search')
      await page.keyboard.press('Enter')
      const box = page.getByRole('searchbox')
      await expect(box).toBeFocused()
      await page.keyboard.type('build the index')
      const hit = page.locator('.search-results button').first()
      await tabTo(page, hit)
      await page.keyboard.press('Enter')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.locator('.task-row', { hasText: 'build the index' })).toHaveAttribute(
        'aria-current',
        'true',
      )
      await notOnBody(page)
    })

    test('Needs you: arm, disarm, confirm, answer, and inspect', async ({ page }) => {
      await page.goto(`${NEXT}#needs`)
      await expect(page.locator('.decision').first()).toBeVisible()

      const inspect = named(page, 'Inspect checks and changes').first()
      await tabTo(page, inspect)
      await page.keyboard.press('Enter')
      await expect(page.getByRole('tab', { name: 'Checks' })).toBeVisible()
      await inInspector(page)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('tab', { name: 'Checks' })).toHaveCount(0)
      await expect(inspect).toBeFocused()

      const approve = named(page, 'Approve push').first()
      await tabTo(page, approve)
      await page.keyboard.press('Enter')
      const confirm = named(page, 'Confirm: push sample branch')
      await expect(confirm).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(approve).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(confirm).toBeFocused()
      await page.keyboard.press('Enter')
      const first = page.locator('.decision').first()
      await expect(first).toHaveAttribute('data-state', 'resolved')
      await expect(first.getByRole('heading', { level: 2 })).toBeFocused()

      const question = page.locator('.decision').nth(1)
      await tabTo(page, question.getByRole('radio').first())
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Space')
      await expect(question.getByRole('radio').nth(1)).toBeChecked()
      const send = question.getByRole('button', { name: 'Send answer' })
      await expect(send).not.toHaveAttribute('aria-disabled', 'true')
      await tabTo(page, send)
      await page.keyboard.press('Enter')
      await expect(question).toHaveAttribute('data-state', 'resolved')
      await expect(question.getByRole('heading', { level: 2 })).toBeFocused()
    })

    test('Connections: the add form, and retire armed and disarmed', async ({ page }) => {
      await page.goto(`${CONFIG}#chat`)
      await expect(page.locator('.shell')).toBeVisible()
      await goTo(page, 'Connections')

      const add = named(page, 'Add connection').first()
      await tabTo(page, add)
      await page.keyboard.press('Enter')
      const engine = page.getByLabel('Engine')
      await expect(engine).toBeFocused()
      await tabTo(page, named(page, 'Cancel'))
      await page.keyboard.press('Enter')
      await expect(engine).toHaveCount(0)
      await expect(add).toBeFocused()

      const row = page.locator('.connection').filter({ hasText: 'sample-key' })
      const retire = row.getByRole('button', { name: 'Retire', exact: true })
      await tabTo(page, retire)
      await page.keyboard.press('Enter')
      const typed = row.getByLabel('Type sample-key to confirm')
      await expect(typed).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(typed).toHaveCount(0)
      await expect(retire).toBeFocused()

      await page.keyboard.press('Enter')
      await expect(typed).toBeFocused()
      await expect(named(page, 'Retire sample-key')).toBeVisible()
      await expect(row.locator('.armed-panel li').first()).toBeVisible()
      await page.keyboard.type('sample-key')
      await page.keyboard.press('Enter')
      await expect(page.locator('.connection').filter({ hasText: 'sample-key' })).toHaveCount(0)
      await expect(add).toBeFocused()
    })

    test('Setup: stages open by keys, and a next step lands on its page', async ({ page }) => {
      await page.goto(`${CONFIG}?nochecks=1#chat`)
      await expect(page.locator('.shell')).toBeVisible()
      await goTo(page, 'Setup')
      await expect(page.locator('.stage')).toHaveCount(5)

      const next = named(page, 'Open Repositories')
      await tabTo(page, next)
      await page.keyboard.press('Enter')
      await expect(page).toHaveURL(/settings$/)
      await notOnBody(page)
      await tabTo(page, named(page, 'Trust…').first())
    })

    test('Settings: sections, an edit, and a save by keys', async ({ page }) => {
      await page.goto(`${CONFIG}#chat`)
      await expect(page.locator('.shell')).toBeVisible()
      await goTo(page, 'Settings')

      const models = named(page, 'Models')
      await tabTo(page, models)
      await page.keyboard.press('Enter')
      await expect(page.locator('.plain-summary')).toContainText('Tiers')
      await tabTo(page, named(page, 'Policy'), 'Shift+Tab')
      await page.keyboard.press('Enter')

      await tabTo(page, page.locator('.advanced > summary'))
      await page.keyboard.press('Enter')
      const text = page.getByLabel('Policy file')
      await tabTo(page, text)
      await page.keyboard.press('ControlOrMeta+a')
      await page.keyboard.type('{"preAuthorised":{"install":[]}}')
      await expect(page.getByText('Unsaved changes')).toBeVisible()
      await tabTo(page, named(page, 'Save'))
      await page.keyboard.press('Enter')
      await expect(page.getByText('Unsaved changes')).toBeHidden()
      await expect(text).toBeFocused()

      await tabTo(page, named(page, 'Repositories'), 'Shift+Tab')
      await page.keyboard.press('Enter')
      const add = named(page, 'Add repository')
      await tabTo(page, add)
      await page.keyboard.press('Enter')
      await expect(page.getByRole('textbox').first()).toBeFocused()
      await tabTo(page, named(page, 'Cancel'))
      await page.keyboard.press('Enter')
      await expect(add).toBeFocused()
    })
  })
}

test.describe('the drawer by keys', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('opens, traps, closes on Escape and returns to its button', async ({ page }) => {
    await page.goto(`${NEXT}#chat`)
    const menu = named(page, 'Open navigation')
    await tabTo(page, menu)
    await page.keyboard.press('Enter')
    const drawer = page.getByRole('dialog')
    await expect(drawer).toBeVisible()
    for (let press = 0; press < 14; press += 1) {
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') != null)).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await expect(menu).toBeFocused()
  })
})
