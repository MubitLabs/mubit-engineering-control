import { expect, type Locator, type Page, test } from '@playwright/test'

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

/** The raw policy or models text sits under Advanced, below its plain summary. */
async function advanced(page: Page): Promise<void> {
  await page.locator('.advanced > summary').click()
}

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

test('parked work states its facts, and a switch names its target and shows the card', async ({ page }) => {
  await open(page, 'slots', 'parked')
  const quota = connection(page, 'sample-key').locator('.parked-item')
  await expect(quota.getByText('Parked: out of quota')).toBeVisible()
  await expect(quota.getByText('sample rate limit')).toBeVisible()
  await expect(quota.getByText('Reset unknown')).toBeVisible()
  await expect(quota.getByText('The worktree is kept')).toBeVisible()

  await quota.getByRole('button', { name: 'Switch work to sample-max' }).click()
  await expect(quota.getByText('Moves Sample quota work from sample-key to sample-max.')).toBeVisible()
  await quota.getByRole('button', { name: 'Keep it parked' }).click()
  await expect(quota.getByText('Moves Sample quota work')).toBeHidden()

  await quota.getByRole('button', { name: 'Switch work to sample-max' }).click()
  await quota.getByRole('button', { name: 'Switch to sample-max', exact: true }).click()
  await expect(quota.getByRole('status')).toContainText('Approve it in Needs you')

  const auth = connection(page, 'sample-expired').locator('.parked-item')
  await expect(auth.getByRole('button', { name: 'Sign in again' })).toBeVisible()
  await expect(auth.getByRole('button', { name: /Switch work/ })).toHaveCount(0)
})

test('an expired sign-in offers Sign in again, and Drain is gone with the reason said', async ({ page }) => {
  await open(page, 'slots')
  const row = connection(page, 'sample-expired')
  await expect(row.getByRole('button', { name: 'Sign in again' })).toBeVisible()
  await expect(row.getByRole('button', { name: 'Drain' })).toHaveCount(0)
  await expect(page.getByText('Draining a connection is not available')).toBeVisible()
  await expect(row.getByText('No reading yet. MEC does not record usage')).toBeVisible()
  await expect(row.getByText('Default limit')).toBeVisible()
  await expect(row.getByText('None set')).toBeVisible()
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

test('Sign in again that starts shows its card', async ({ page }) => {
  await open(page, 'slots')
  await connection(page, 'sample-expired').getByRole('button', { name: 'Sign in again' }).click()
  await expect(page.getByText('Waiting for the sign-in command…')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel sign-in' })).toBeVisible()
})

test('a sign-in that finishes reads Healthy with no Check again', async ({ page }) => {
  await open(page, 'slots')
  await page.getByRole('button', { name: 'Add connection' }).click()
  await startSignIn(page)
  await expect(page.getByText('Waiting for the sign-in command…')).toBeVisible()
  const row = connection(page, 'sample-new')
  await expect(row).toContainText('Not checked yet')
  // The vendor command exits; the server checks the connection before the card's end is sent.
  await page.evaluate(() => {
    window.__server.checkedAfterSignIn('sample-new')
    const card = window.__sources.find((source) => source.url.includes('/api/slots/login/current'))
    card?.onmessage?.({ data: JSON.stringify({ kind: 'exit', code: 0 }) })
  })
  await expect(row).toContainText('Healthy')
  await expect(row).not.toContainText('Not checked yet')
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

test('screenshots before review: off by default, turned on in plain words, and saved', async ({ page }) => {
  await open(page, 'settings')
  await page.getByRole('button', { name: 'Repositories' }).click()
  const toggle = page.getByLabel('Require before and after screenshots for changes people can see')
  await expect(toggle).not.toBeChecked()
  await expect(page.getByText('changes no work in progress')).toBeVisible()
  await toggle.check()
  await page.getByLabel('Pages to capture').fill('/ /about.html')
  await page.getByRole('button', { name: 'Save screenshot setting' }).click()
  await expect(toggle).toBeChecked()
  await expect(page.getByLabel('Pages to capture')).toHaveValue('/ /about.html')

  await page.getByLabel('Pages to capture').fill('about')
  await page.getByRole('button', { name: 'Save screenshot setting' }).click()
  await expect(page.locator('.ui-evidence').getByRole('alert')).toContainText('Each page starts with /')
  await noHorizontalScroll(page)
})

test('the agreement says what it allows, arms, and can be withdrawn', async ({ page }) => {
  await open(page, 'settings')
  await page.getByRole('button', { name: 'Repositories' }).click()
  await expect(page.getByText('Waiting for your agreement: nothing runs')).toBeVisible()
  await expect(page.getByText('This browser cannot answer yet')).toBeVisible()
  await page.getByRole('button', { name: 'Review and agree…' }).click()
  await expect(page.getByText('outside any sandbox, with your files and your network')).toBeVisible()
  await expect(page.getByText('No work is waiting on this now.')).toBeVisible()
  await expect(page.getByText('You can withdraw this here at any time')).toBeVisible()
  await page.getByRole('button', { name: 'Agree to run here' }).click()
  await expect(page.getByText('Agreed: MEC may run work')).toBeVisible()
  await page.getByRole('button', { name: 'Withdraw…' }).click()
  await page.getByRole('button', { name: 'Withdraw agreement' }).click()
  await expect(page.getByText('Waiting for your agreement: nothing runs')).toBeVisible()
})

test('settings failure leaves navigation usable', async ({ page }) => {
  await open(page, 'settings', 'fail=/api/policy')
  await expect(page.getByRole('alert').getByText('Could not load the policy')).toBeVisible()
  await page.getByRole('button', { name: 'Backups' }).click()
  await expect(page.getByRole('button', { name: 'Back up now' })).toBeEnabled()
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Work' }).click()
  await expect(page).toHaveURL(/work$/)
})

test('a failing prompts or models read ends in an error, and the shell stays usable', async ({ page }) => {
  await open(page, 'settings', 'fail=/api/prompts,/api/models/text')
  await page.getByRole('button', { name: 'Prompts' }).click()
  await expect(page.getByRole('alert').getByText('Could not load', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Models' }).click()
  await expect(page.getByRole('alert').getByText('Could not load', { exact: false })).toBeVisible()
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Work' }).click()
  await expect(page).toHaveURL(/work$/)
})

test('a stale save keeps the draft and says so', async ({ page }) => {
  await open(page, 'settings')
  await advanced(page)
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
  await advanced(page)
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
  await advanced(page)
  await page.getByLabel('Policy file').fill('{"preAuthorised":{"spend":[]}}')
  await page.getByRole('button', { name: 'Models' }).click()
  await advanced(page)
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
  await advanced(page)
  const text = page.getByLabel('Policy file')
  await text.fill('{"preAuthorised":{"pr_merge":[]}}')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    page.getByText("Not saved: invalid_policy: class 'pr_merge' is always-confirm (§13)"),
  ).toBeVisible()
  await expect(text).toHaveValue('{"preAuthorised":{"pr_merge":[]}}')

  await page.getByRole('button', { name: 'Models' }).click()
  await advanced(page)
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

test('Setup talks to the setup agent, keeps a failed message and points at a proposal', async ({ page }) => {
  await open(page, 'setup')
  const chat = page.getByRole('region', { name: 'Setup chat' })
  const box = chat.getByLabel('Ask about setup')
  const sent = chat.getByRole('button', { name: 'Send' })

  await expect(sent).toBeDisabled()
  await box.fill('check my slots')
  await sent.click()
  await expect(chat.getByRole('status')).toContainText('Sample setup reply to: check my slots')
  await expect(box).toHaveValue('')
  await expect(chat.getByRole('button', { name: 'Open Settings' })).toHaveCount(0)

  await box.fill('propose a change')
  await sent.click()
  await chat.getByRole('button', { name: 'Open Settings' }).click()
  await expect(page.getByText('Sample proposal from setup chat')).toBeVisible()
})

test('a setup message the server refuses stays in the box', async ({ page }) => {
  await open(page, 'setup', 'fail=/api/chat/messages')
  const chat = page.getByRole('region', { name: 'Setup chat' })
  await chat.getByLabel('Ask about setup').fill('check my slots')
  await chat.getByRole('button', { name: 'Send' }).click()
  await expect(chat.getByRole('alert')).toBeVisible()
  await expect(chat.getByLabel('Ask about setup')).toHaveValue('check my slots')
})

test('a proposal changes nothing until Apply', async ({ page }) => {
  await open(page, 'settings')
  await expect(page.getByText('Sample proposal from setup chat')).toBeVisible()
  await expect(page.getByText('Default, never saved')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply' })).toBeEnabled()
})

test('a proposal marks what it replaces against the saved policy', async ({ page }) => {
  await open(page, 'settings')
  const proposal = page.locator('.proposal')
  await expect(proposal.locator('.diff-removed').first()).toHaveText(/"preAuthorised": \{\}/)
  await expect(proposal.locator('.diff-added').filter({ hasText: 'repo_prop' })).toBeVisible()
  await expect(proposal.getByText('Policy file', { exact: true })).toBeVisible()
  await expect(proposal.locator('.diff-same').first()).toBeVisible()
})

test('saving an edit redraws a proposal against the new text', async ({ page }) => {
  await open(page, 'settings')
  await advanced(page)
  await page.getByLabel('Policy file').fill('{"preAuthorised":{},"capsOverride":{"usd":5}}')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved, not yet in force')).toBeVisible()
  await expect(page.locator('.proposal .diff-removed').first()).toHaveText(/capsOverride/)
})

test('Apply answers for the comparison on screen, not a newer read', async ({ page }) => {
  await open(page, 'settings')
  await expect(page.locator('.proposal .diff-removed').first()).toBeVisible()
  await page.evaluate(() => window.__server.freezeDrafts())
  await advanced(page)
  await page.getByLabel('Policy file').fill('{"preAuthorised":{},"capsOverride":{"usd":5}}')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved, not yet in force')).toBeVisible()
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByRole('alert')).toContainText('nothing was applied')
})

test('a stale proposal says so and redraws against the text that moved', async ({ page }) => {
  await open(page, 'settings')
  await expect(page.locator('.proposal .diff-removed').first()).toBeVisible()
  await page.evaluate(() => window.__server.saveElsewhere())
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByRole('alert')).toContainText('nothing was applied')
  await expect(page.locator('.proposal').getByText('capsOverride')).toBeVisible()
})

test('compare shows what differs from the default', async ({ page }) => {
  await open(page, 'settings')
  await page.getByRole('button', { name: 'Prompts' }).click()
  await page.getByLabel('rules text').fill('SAMPLE-ONLY shared text\nline changed')
  await page.getByRole('button', { name: 'Compare with default' }).click()
  await expect(page.locator('.diff-removed')).toHaveText('- line two\n')
  await expect(page.locator('.diff-added')).toHaveText('+ line changed\n')
})

/** The first changed line is inside the block's first view, with nothing scrolled. */
async function firstChangeInFirstView(block: Locator): Promise<void> {
  await expect(block.locator('.diff-removed, .diff-added').first()).toBeVisible()
  const view = await block.evaluate((element) => {
    const first = element.querySelector('.diff-removed, .diff-added')
    return {
      scrollTop: element.scrollTop,
      viewHeight: element.clientHeight,
      offset: (first?.getBoundingClientRect().top ?? 0) - element.getBoundingClientRect().top,
    }
  })
  expect(view.scrollTop).toBe(0)
  expect(view.offset).toBeLessThan(view.viewHeight)
}

test("a one-line change in a long table shows in the comparison's first view", async ({ page }) => {
  await open(page, 'settings', 'longproposals=1')
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  const block = page.locator('.proposal .diff')
  await firstChangeInFirstView(block)
  await expect(block.locator('.diff-removed')).toHaveText(/model_81: fast/)
  await expect(block.locator('.diff-added')).toHaveText(/model_81: balanced/)
})

test('a folded comparison opens and closes, and hides no changed line', async ({ page }) => {
  await open(page, 'settings', 'longproposals=1')
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  const block = page.locator('.proposal .diff')
  const fold = block.getByRole('button', { name: 'Show 78 unchanged lines' })
  await expect(block.getByText('model_0: fast')).toHaveCount(0)
  await fold.click()
  await expect(block.getByText('model_0: fast')).toBeVisible()
  await block.getByRole('button', { name: 'Hide 78 unchanged lines' }).click()
  await expect(block.getByText('model_0: fast')).toHaveCount(0)
})

test('a prompts comparison folds the same way', async ({ page }) => {
  await open(page, 'settings', 'longproposals=1')
  await page.getByRole('button', { name: 'Prompts' }).click()
  const text = page.getByLabel('rules text')
  await text.fill((await text.inputValue()).replace('model_81: fast', 'model_81: balanced'))
  await page.getByRole('button', { name: 'Compare with default' }).click()
  await firstChangeInFirstView(page.locator('.diff'))
})

test('a repository proposal that carried trust says it starts untrusted', async ({ page }) => {
  await open(page, 'settings', 'longproposals=1')
  await page.getByRole('button', { name: 'Repositories', exact: true }).click()
  const card = page.locator('.proposal').filter({ hasText: 'asks to be trusted' })
  await expect(card.getByText('It starts untrusted')).toBeVisible()
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

test('the walkthrough: setup answers before the engines do', async ({ page }) => {
  await open(page, 'setup', 'checking=2')
  const engines = page.locator('.stage').filter({ hasText: 'Engines' })
  await expect(engines.getByText('Checking', { exact: true })).toBeVisible()
  await expect(page.getByText(/usable connection|No connection yet/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Finish' })).toBeDisabled()
  await expect(page.getByText('Still checking which engines are installed.')).toBeVisible()
  await expect(engines.getByText('Done', { exact: true })).toBeVisible({ timeout: 5_000 })
})

test('the walkthrough: finished setup offers nothing more to do', async ({ page }) => {
  await open(page, 'setup', 'complete')
  await expect(page.getByText('Setup is finished. Nothing more is needed here.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Finish' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open Conversation' })).toBeVisible()
  await expect(page.getByLabel('Ask about setup')).toBeHidden()
  await page.locator('summary', { hasText: 'Ask about setup' }).click()
  await expect(page.getByLabel('Ask about setup')).toBeVisible()
})

test('the walkthrough: Finish stands clear of the Setup chat heading', async ({ page }) => {
  await open(page, 'setup')
  const finish = await page.getByRole('button', { name: 'Finish' }).boundingBox()
  const heading = await page.getByRole('heading', { name: 'Setup chat' }).boundingBox()
  expect(finish && heading && heading.y - (finish.y + finish.height)).toBeGreaterThanOrEqual(16)
})

test('the walkthrough: policy and models lead with plain words and fold the raw text', async ({ page }) => {
  await open(page, 'settings')
  await expect(page.getByText('MEC asks you before anything that needs a confirmation.')).toBeVisible()
  await expect(page.getByLabel('Policy file')).toBeHidden()
  await advanced(page)
  await expect(page.getByLabel('Policy file')).toBeVisible()

  await page.getByRole('button', { name: 'Models', exact: true }).click()
  await expect(page.getByText('Claude Code: sample-fast (fast).')).toBeVisible()
  await expect(page.getByLabel('Capability table')).toBeHidden()
})

test('the walkthrough: a draft keeps Advanced open when its section comes back', async ({ page }) => {
  await open(page, 'settings')
  await advanced(page)
  await page.getByLabel('Policy file').fill('{"preAuthorised":{"spend":[]}}')
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  await page.getByRole('button', { name: /^Policy/ }).click()
  await expect(page.getByLabel('Policy file')).toBeVisible()
})

test('the walkthrough: a connection date reads as words, never as digits and slashes', async ({ page }) => {
  await open(page, 'slots')
  const facts = connection(page, 'sample-key').locator('dd').first()
  await expect(facts).toBeVisible()
  await expect(connection(page, 'sample-key')).not.toContainText(/\d{2}\/\d{2}\/\d{4}/)
})

test('the walkthrough: pause is apart from navigation and says what it does', async ({ page }) => {
  await open(page, 'chat')
  const nav = page.getByRole('navigation', { name: 'Workspace' })
  await expect(nav.getByRole('button', { name: 'Pause processing' })).toHaveCount(0)
  const button = page.getByRole('button', { name: 'Pause processing' })
  await expect(button).toHaveAccessibleDescription('Stops new runs for all work. Runs in progress finish.')
  await expect(page.getByText('Stops new runs for all work.')).toBeVisible()
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
