import { expect, type Page, test } from '@playwright/test'

/**
 * The work surfaces against fixtures/work-harness.html: fixture, real decoder, work-model, real
 * components. The numbers in the test names are the prototype defects the design audit found.
 * Time zone, locale and the clock are pinned so the baselines do not depend on the machine or the
 * day: a time on another day names its date.
 */

const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
] as const
const THEMES = ['light', 'dark'] as const
const HARNESS = '/test/fixtures/work-harness.html'

test.use({ timezoneId: 'UTC', locale: 'en-GB' })

async function harness(page: Page, hash = 'work', query = ''): Promise<void> {
  await page.clock.setFixedTime('2026-11-05T10:00:00.000Z')
  await page.goto(`${HARNESS}?${query}#${hash}`)
  await expect(page.locator('.shell')).toBeVisible()
}

async function setTheme(page: Page, theme: string): Promise<void> {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('mec-next-theme', value)
    } catch {}
  }, theme)
}

const effects = (page: Page) => page.evaluate(() => window.__effects ?? [])

async function expectBounded(page: Page): Promise<void> {
  const box = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    width: document.documentElement.scrollWidth,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
  }))
  expect(box.height, 'document height').toBeLessThanOrEqual(box.innerHeight)
  expect(box.width, 'document width').toBeLessThanOrEqual(box.innerWidth)
}

/** Every visible text is at least 12px and every control meets the target for this width. */
async function sweep(page: Page, minimum: number): Promise<string[]> {
  return page.evaluate((min) => {
    const found: string[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement
      if (!parent || !walker.currentNode.textContent?.trim()) continue
      if (parent.closest('.sr-only, script, style, option')) continue
      if (Number.parseFloat(getComputedStyle(parent).fontSize) < 12) {
        found.push(`small text: ${walker.currentNode.textContent}`)
      }
    }
    for (const control of document.querySelectorAll('button, a[href], select, [role="tab"], summary')) {
      const box = control.getBoundingClientRect()
      if (box.width === 0 || control.classList.contains('skip-link') || control.closest('[inert]')) continue
      if (box.height < min) found.push(`short target: ${control.textContent} ${box.height}`)
      if (control.classList.contains('btn-primary') && box.height < 40) {
        found.push(`short primary: ${control.textContent} ${box.height}`)
      }
    }
    return found
  }, minimum)
}

const row = (page: Page, name: RegExp | string) => page.locator('.work-row').filter({ hasText: name })
const taskRow = (page: Page, name: RegExp | string) => page.locator('.task-row').filter({ hasText: name })
const inspector = (page: Page) => page.locator('.inspector-content')

async function openDelivery(page: Page): Promise<void> {
  await row(page, 'search for the console').click()
  await expect(page.locator('.work-detail')).toBeVisible()
}

async function chooseRepository(page: Page, label: string): Promise<void> {
  await page.locator('.repo-scope select').selectOption({ label })
}

test.describe('the audit defects, wide', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('7 completed state does not say checks have not run', async ({ page }) => {
    await harness(page)
    await openDelivery(page)
    await taskRow(page, 'read the code').click()
    await page.getByRole('tab', { name: 'Checks' }).click()
    await expect(inspector(page).getByText('Checks passed on this commit')).toBeVisible()
    await expect(inspector(page)).not.toContainText(/not run|have not run/i)
    await expect(inspector(page)).toContainText('typecheck')
    await expect(inspector(page)).not.toContainText('stale check')
  })

  test('8 each row opens its own task and stays selected', async ({ page }) => {
    await harness(page)
    await openDelivery(page)
    for (const title of ['read the code', 'build the index', 'run the combined checks']) {
      await taskRow(page, title).click()
      await expect(inspector(page).getByRole('heading', { level: 2 })).toContainText(title)
      await expect(page.locator('.task-row[aria-current="true"]')).toHaveCount(1)
      await expect(taskRow(page, title)).toHaveAttribute('aria-current', 'true')
    }
    await expect(row(page, 'search for the console')).toHaveAttribute('aria-current', 'true')
  })

  test('9 working state shows no passed checks', async ({ page }) => {
    await harness(page)
    await openDelivery(page)
    await taskRow(page, 'build the index').click()
    await page.getByRole('tab', { name: 'Checks' }).click()
    await expect(inspector(page).getByText('Not run yet')).toBeVisible()
    await expect(inspector(page)).not.toContainText(/passed/i)
  })

  test('partial coverage says not recorded on every evidence tab', async ({ page }) => {
    await harness(page)
    await openDelivery(page)
    await taskRow(page, 'run the combined checks').click()
    for (const tab of ['Checks', 'Activity', 'Diff']) {
      await page.getByRole('tab', { name: tab }).click()
      await expect(inspector(page).getByText('Not recorded yet').first()).toBeVisible()
    }
  })

  test('requested and actual stay apart, and ids stay folded', async ({ page }) => {
    await harness(page)
    await openDelivery(page)
    await taskRow(page, 'build the index').click()
    await expect(inspector(page).getByText('strong, sample-model-2')).toBeVisible()
    await expect(inspector(page).getByText('sample-model-1')).toBeVisible()
    await expect(inspector(page).getByText('attempt_active')).toBeHidden()
    await inspector(page).getByText('Technical details').click()
    await expect(inspector(page).getByText('attempt_active')).toBeVisible()
  })

  test('10 a blocked question is on Needs you', async ({ page }) => {
    await harness(page)
    await expect(row(page, 'export of audit rows')).toContainText('Needs your answer')
    await page.locator('.nav-item', { hasText: 'Needs you' }).click()
    await expect(page.locator('.decision').filter({ hasText: 'include archived rows?' })).toBeVisible()
  })

  test('11 a resolved approval does not carry to another repo', async ({ page }) => {
    await harness(page, 'needs')
    const card = page.locator('.decision').filter({ hasText: 'push search to sample-console' })
    await card.getByRole('button', { name: 'Inspect checks and diff' }).click()
    await expect(inspector(page)).toBeVisible()
    await page.getByRole('button', { name: 'Close details' }).first().click()
    await card.getByRole('button', { name: 'Approve' }).click()
    await card.getByRole('button', { name: /^Confirm: push in sample-console/ }).click()
    await expect(card).toContainText('Pushed')
    expect(await effects(page)).toEqual(['approve card_pending'])

    await chooseRepository(page, 'sample-billing')
    await expect(page.locator('.page')).not.toContainText('Pushed')
    await expect(page.locator('.page')).not.toContainText('push search')
    await expect(page.getByRole('button', { name: 'Open details' })).toHaveCount(0)
    await expect(page.locator('.decision').filter({ hasText: 'merge pull request 9' })).toBeVisible()
  })

  test('12 amber leaves a settled item', async ({ page }) => {
    await harness(page, 'needs')
    const card = page.locator('.decision').filter({ hasText: 'push search to sample-console' })
    await expect(card.locator('.attention-label')).toHaveCount(1)
    await card.getByRole('button', { name: 'Deny' }).click()
    await expect(card.locator('.attention-label')).toHaveCount(0)
    await expect(card.locator('.settled-label')).toHaveText('Denied')
    const settled = page.locator('.decision[data-state="resolved"], .decision[data-state="expired"]')
    expect(await settled.count()).toBeGreaterThan(1)
    await expect(settled.locator('.attention-label')).toHaveCount(0)
  })

  test('13 expired is shown', async ({ page }) => {
    await harness(page, 'needs')
    const expired = page.locator('.decision[data-state="expired"]')
    await expect(expired).toContainText('Expired')
    await expect(expired).toContainText('open a pull request')
    await expect(expired.getByRole('button', { name: 'Approve' })).toHaveCount(0)
  })

  test('a hold keeps the card open and names why', async ({ page }) => {
    await harness(page, 'needs', 'state=hold')
    const card = page.locator('.decision').filter({ hasText: 'push search to sample-console' })
    await card.getByRole('button', { name: 'Approve' }).click()
    await card.getByRole('button', { name: /^Confirm/ }).click()
    await expect(page.getByText('Required checks are still running.')).toBeVisible()
    await expect(card).toHaveAttribute('data-state', 'open')
  })

  test('a card with no evidence cannot be approved, and can be denied', async ({ page }) => {
    await harness(page, 'needs', 'state=no-evidence')
    const missing = page.locator('.decision-missing').first()
    await expect(missing).toContainText('cannot be approved yet')
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0)
    await missing.getByRole('button', { name: 'Deny' }).click()
    expect((await effects(page))[0]).toMatch(/^deny /)
  })

  test('a question answered elsewhere says so', async ({ page }) => {
    await harness(page, 'needs', 'state=conflict')
    const card = page.locator('.decision').filter({ hasText: 'include archived rows?' })
    await card.getByRole('radio').first().check()
    await card.getByRole('button', { name: 'Send answer' }).click()
    await expect(card.locator('.settled-label')).toHaveText('Already answered')
  })

  test('one question, shown in the thread and on Needs you, settles once', async ({ page }) => {
    await harness(page, 'chat')
    const card = page.locator('.decision').filter({ hasText: 'include archived rows?' })
    await expect(card).toBeVisible()
    await page.locator('.nav-item', { hasText: 'Needs you' }).click()
    await card.getByRole('radio').first().check()
    await card.getByRole('button', { name: 'Send answer' }).click()
    await expect(card.locator('.settled-label')).toHaveText('Answered')
    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect(page.locator('.conversation .decision')).toHaveCount(0)
    expect(await effects(page)).toEqual(['answer question_open'])
  })

  test('the sidebar count is the waiting list, and unknown shows none', async ({ page }) => {
    await harness(page, 'needs')
    const waiting = await page.locator('.decision[data-state="open"], .notice-blocked').count()
    await expect(page.locator('.count')).toContainText(String(waiting))

    await harness(page, 'needs', 'state=failed')
    await expect(page.locator('.count')).toHaveCount(0)
    await expect(page.getByRole('alert')).toContainText('Could not read what needs you')
    await expect(page.locator('.page')).not.toContainText(/nothing/i)
  })

  test('a healthy empty Needs you takes no space and claims nothing', async ({ page }) => {
    await harness(page, 'needs', 'state=empty')
    await expect(page.locator('.page > *')).toHaveCount(1)
    await expect(page.locator('.page h1')).toHaveText('Needs you')
    await expect(page.locator('.decision, .notice, .empty')).toHaveCount(0)
  })

  test('selected row not marked: exactly one work row is current', async ({ page }) => {
    await harness(page)
    await expect(page.locator('.work-row[aria-current="true"]')).toHaveCount(0)
    await openDelivery(page)
    await expect(page.locator('.work-row[aria-current="true"]')).toHaveCount(1)
  })

  test('inspector drops a task from another repository', async ({ page }) => {
    await harness(page)
    await openDelivery(page)
    await taskRow(page, 'build the index').click()
    await expect(inspector(page)).toBeVisible()
    await chooseRepository(page, 'sample-billing')
    await expect(inspector(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Open details' })).toHaveCount(0)
  })

  test('all repositories: an action names and uses the item’s repository', async ({ page }) => {
    await harness(page)
    await row(page, 'retry the ledger sync').click()
    await page.getByRole('button', { name: 'Hold in sample-billing' }).click()
    expect(await effects(page)).toEqual(['hold work_quota repo_b'])
  })

  test('unassigned work is shown and has no action', async ({ page }) => {
    await harness(page)
    await row(page, 'work from before repositories').click()
    await expect(row(page, 'work from before repositories')).toContainText('Unassigned')
    await expect(page.locator('.work-detail .actions')).toHaveCount(0)
  })

  test('held work offers an explicit lift, and pause is not offered', async ({ page }) => {
    await harness(page)
    await row(page, 'theme cleanup').click()
    await page.getByRole('button', { name: 'Lift hold in sample-console' }).click()
    expect(await effects(page)).toEqual(['lift work_held repo_a'])
    await expect(page.getByRole('button', { name: /pause/i })).toHaveCount(0)
  })

  test('stop takes two steps, names what stops, and disarms', async ({ page }) => {
    await harness(page)
    await openDelivery(page)
    await page.getByRole('button', { name: 'Stop in sample-console' }).click()
    const stop = page.locator('.work-detail .decision')
    await expect(stop).toContainText('Stop SAMPLE-ONLY search for the console')
    const first = stop.getByRole('button', { name: 'Stop in sample-console' })
    await first.click()
    await expect(stop.getByRole('button', { name: /^Confirm: stop this delivery/ })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(first).toBeVisible()
    expect(await effects(page)).toEqual([])
    await first.click()
    await stop.getByRole('button', { name: /^Confirm: stop this delivery/ }).click()
    expect(await effects(page)).toEqual(['stop work_working repo_a'])
  })

  test('ended rows show their outcome', async ({ page }) => {
    await harness(page)
    await expect(page.getByRole('region', { name: 'Ended' })).toContainText('Merged')
    await expect(page.getByRole('region', { name: 'Ended' })).toContainText('Dropped')
    await expect(page.getByRole('region', { name: 'Held' })).toContainText('theme cleanup')
  })

  test('search keeps composer intent', async ({ page }) => {
    await harness(page, 'chat')
    await page.getByRole('textbox', { name: 'Message the meta agent' }).fill('a draft')
    await page.getByRole('button', { name: 'Follow up' }).click()
    const scope = page.getByText('Following up on this delivery')
    await expect(scope).toBeVisible()

    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await page.getByRole('searchbox').fill('build the index')
    await page.locator('.search-results button').first().click()
    await expect(page).toHaveURL(/#work$/)
    await expect(taskRow(page, 'build the index')).toHaveAttribute('aria-current', 'true')
    await expect(row(page, 'search for the console')).toHaveAttribute('aria-current', 'true')

    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect(scope).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Message the meta agent' })).toHaveValue('a draft')
  })

  test('search labels kind and repository, opens from the palette, and says when it finds nothing', async ({
    page,
  }) => {
    await harness(page, 'chat')
    await page.getByRole('button', { name: 'Open commands' }).click()
    await page.getByRole('option', { name: 'Search', exact: true }).click()
    const box = page.getByRole('searchbox')
    await expect(box).toBeFocused()
    await box.fill('pull request')
    await expect(page.locator('.search-results')).toContainText('Reference in sample-console')
    await box.fill('no such thing')
    await expect(page.getByText('No match for that search.')).toBeVisible()
  })

  test('error keeps content and offers retry', async ({ page }) => {
    await harness(page, 'work', 'state=error')
    await expect(page.getByRole('alert')).toContainText('Could not read work')
    await expect(row(page, 'search for the console')).toBeVisible()
    await expect(page.locator('.freshness')).toContainText('Stale. Last read 10:00')
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('.freshness')).toHaveText('Last read 10:00')
  })

  test('a failed read with nothing kept is not empty', async ({ page }) => {
    await harness(page, 'work', 'state=failed')
    await expect(page.getByRole('alert')).toContainText('Could not read work')
    await expect(page.getByText('No deliveries yet')).toHaveCount(0)
  })

  test('the glossary opens, traps and returns focus', async ({ page }) => {
    await harness(page)
    const button = page.getByRole('button', { name: 'Open glossary' })
    await button.click()
    await expect(page.getByRole('dialog')).toContainText('Attempt')
    await page.keyboard.press('Escape')
    await expect(button).toBeFocused()
  })

  test('the conversation leads with the request and keeps tool activity out', async ({ page }) => {
    await harness(page, 'chat')
    await expect(page.locator('.conversation h1')).toContainText('search for the console')
    await expect(page.locator('.conversation')).not.toContainText('tool call')
    await page.getByRole('button', { name: 'Inspect', exact: true }).click()
    await expect(inspector(page).getByRole('heading', { level: 2 })).toContainText('build the index')
  })
})

test.describe('narrow', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('no horizontal scroll at 390', async ({ page }) => {
    for (const hash of ['chat', 'work', 'needs']) {
      await harness(page, hash)
      await expectBounded(page)
      // The scroller clips sideways, so an overflowing child would not move the document.
      const overflowing = await page.evaluate(() =>
        [...document.querySelectorAll('.scroller *')]
          .filter((element) => !element.closest('.sr-only'))
          .filter((element) => element.getBoundingClientRect().right > window.innerWidth)
          .map((element) => `${element.tagName}.${element.className}`),
      )
      expect(overflowing, hash).toEqual([])
    }
    await harness(page)
    await openDelivery(page)
    await expectBounded(page)
    await taskRow(page, 'read the code').click()
    await expect(page.locator('[role="dialog"]')).toBeVisible()
    await expectBounded(page)
  })

  test('the originating row stays selected behind the sheet', async ({ page }) => {
    await harness(page)
    await openDelivery(page)
    const task = taskRow(page, 'build the index')
    await task.click()
    await page.keyboard.press('Escape')
    await expect(task).toBeFocused()
    await expect(task).toHaveAttribute('aria-current', 'true')
  })
})

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`${viewport.name} ${theme}`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } })
      test.beforeEach(({ page }) => setTheme(page, theme))

      const shot = (name: string) => `${name}-${viewport.name}-${theme}.png`
      const target = viewport.width <= 760 ? 44 : 32

      test('work list', async ({ page }) => {
        await harness(page)
        await expectBounded(page)
        expect(await sweep(page, target)).toEqual([])
        await expect(page).toHaveScreenshot(shot('work'))
      })

      test('selected delivery and inspector', async ({ page }) => {
        await harness(page, 'work', 'work=work_working')
        await taskRow(page, 'build the index').click()
        await expect(inspector(page)).toBeVisible()
        await expectBounded(page)
        expect(await sweep(page, target)).toEqual([])
        await expect(page).toHaveScreenshot(shot('work-inspector'))
      })

      test('needs you', async ({ page }) => {
        await harness(page, 'needs')
        await expectBounded(page)
        expect(await sweep(page, target)).toEqual([])
        await expect(page).toHaveScreenshot(shot('work-needs'))
      })

      test('conversation', async ({ page }) => {
        await harness(page, 'chat')
        await expectBounded(page)
        expect(await sweep(page, target)).toEqual([])
        await expect(page).toHaveScreenshot(shot('work-conversation'))
      })

      test('search sheet', async ({ page }) => {
        await harness(page, 'chat')
        await page.getByRole('button', { name: 'Search', exact: true }).click()
        await page.getByRole('searchbox').fill('sample-only')
        await expectBounded(page)
        expect(await sweep(page, target)).toEqual([])
        await expect(page).toHaveScreenshot(shot('work-search'))
      })
    })
  }
}
