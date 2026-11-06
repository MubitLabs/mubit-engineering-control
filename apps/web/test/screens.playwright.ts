import { expect, type Page, type Route, test } from '@playwright/test'
import {
  demoChatMessages,
  demoDecisionDetails,
  demoEngines,
  demoInbox,
  demoLogins,
  demoRepositories,
  demoSlots,
  demoStatus,
  demoTaskDetails,
  demoWork,
  demoWorkItemDetails,
  serverModels,
  serverPrompts,
  serverQuestions,
} from './mocks'

/**
 * Screenshot + behaviour suite against the §23 worked example, served through
 * page.route so the app speaks its real API shapes (04_UI_DESIGN_SPEC.md §10).
 * The app holds no demo data: every payload below is supplied HERE, explicitly, in the shape the
 * real server serves (questions, prompts and models in their wire shapes, which the app's decoders
 * map). Anything not listed answers a JSON 404 — exactly what the real server does.
 */

const ROUTES = ['chat', 'needs', 'work', 'slots', 'setup', 'settings'] as const
const THEMES = ['light', 'dark'] as const

async function stubApi(
  page: Page,
  broken: { detail: boolean },
  overrides: Record<string, { status: number; body: unknown }> = {},
): Promise<void> {
  const extraMessages: Array<Record<string, unknown>> = []
  const handler = async (route: Route): Promise<void> => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const method = route.request().method()
    const json = async (body: unknown, status = 200): Promise<void> =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const override = overrides[`${method} ${path}`]
    if (override !== undefined) return json(override.body, override.status)

    if (path === '/api/status') return json(demoStatus)
    if (path === '/api/chat/messages' && method === 'GET')
      return json([...demoChatMessages, ...extraMessages])
    if (path === '/api/chat/messages' && method === 'POST') {
      const body = (await route.request().postDataJSON()) as { text: string }
      extraMessages.push({
        id: `msg_new_${extraMessages.length}`,
        text: body.text,
        createdAt: new Date().toISOString(),
        kind: 'user',
        meta: 'You',
        workItemId: 'wi_a1',
      })
      return json({ messageId: `msg_new_${extraMessages.length}`, workItemId: 'wi_a1' })
    }
    if (path === '/api/inbox') return json(demoInbox)
    if (broken.detail && /^\/api\/inbox\/[^/]+\/detail$/.test(path)) return json({ error: 'boom' }, 500)
    if (/^\/api\/inbox\/[^/]+\/resolve$/.test(path) && method === 'POST')
      return json({ id: 'conf_71', status: 'approved', continues: true })
    if (path === '/api/questions' && method === 'GET') return json(serverQuestions)
    if (path === '/api/prompts' && method === 'GET') return json(serverPrompts)
    if (path === '/api/models' && method === 'GET') return json(serverModels)
    // Detail reads: the worked example, supplied by the test.
    const inboxDetail = /^\/api\/inbox\/([^/]+)\/detail$/.exec(path)
    if (inboxDetail !== null) {
      const detail = demoDecisionDetails[decodeURIComponent(inboxDetail[1] ?? '')]
      return detail === undefined ? json({ error: 'not found' }, 404) : json(detail)
    }
    const workDetail = /^\/api\/work\/([^/]+)$/.exec(path)
    if (workDetail !== null && method === 'GET') {
      const detail = demoWorkItemDetails[decodeURIComponent(workDetail[1] ?? '')]
      return detail === undefined ? json({ error: 'not found' }, 404) : json(detail)
    }
    const taskDetail = /^\/api\/tasks\/([^/]+)$/.exec(path)
    if (taskDetail !== null) {
      const detail = demoTaskDetails[decodeURIComponent(taskDetail[1] ?? '')]
      return detail === undefined ? json({ error: 'not found' }, 404) : json(detail)
    }
    if (path === '/api/backups' && method === 'GET')
      return json({ lastAt: '03:00 today', note: 'Credentials excluded by rule.', excluded: 'credentials' })
    if (/^\/api\/questions\/[^/]+\/answer$/.test(path) && method === 'POST')
      return json({ status: 'answered' })
    if (path === '/api/work') return json(demoWork)
    if (path === '/api/slots') return json(demoSlots)
    if (path === '/api/repositories') return json(demoRepositories)
    if (path === '/api/wizard/engines') return json(demoEngines)
    if (path === '/api/wizard/existing-logins') return json(demoLogins)
    if (path === '/api/wizard/meta-slot') return json({ slotId: 'slot_max2' })
    if (path === '/api/slots/login' && method === 'POST') return json({ id: 'lc_1', busy: false })
    if (path === '/api/events')
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' })
    if (path === '/api/slots/login/current') return json({ error: 'no login card running' }, 404)
    // Everything the server does not serve yet answers a JSON 404, as the real server does.
    return json({ error: 'not found' }, 404)
  }
  await page.route('**/api/**', handler)
}

async function openWorkbench(
  page: Page,
  route: (typeof ROUTES)[number],
  theme: (typeof THEMES)[number] = 'light',
  broken: { detail: boolean } = { detail: false },
  overrides: Record<string, { status: number; body: unknown }> = {},
): Promise<void> {
  await page.addInitScript((choice) => {
    localStorage.setItem('mec-theme', choice)
    // This suite is the classic shell, which is no longer the default (decision #35).
    localStorage.setItem('mec-ui-shell', 'classic')
  }, theme)
  await stubApi(page, broken, overrides)
  await page.goto(`#${route}`)
  // Gate on the data having landed: the runtime line comes from /api/status and
  // the slot dots from /api/slots — capturing mid-fetch produces two recurring
  // but different screens (the flake this wait removes).
  await expect(page.locator('.rail-status')).toContainText('Runtime ready')
  await expect(page.locator('.slot-dots .dot').first()).toBeVisible()
  if (route === 'chat') {
    await Promise.race([
      page.locator('.conversation .msg').first().waitFor(),
      page.locator('.empty-hint').waitFor(),
    ])
    // The chat title arrives via a chained fetch (/api/work → the item's detail);
    // capturing before it lands produces a second recurring screen.
    await page.locator('.pane-title').filter({ hasText: 'Audit-log viewing' }).waitFor()
  }
  if (route === 'work')
    await Promise.race([page.locator('.row').first().waitFor(), page.locator('.empty').waitFor()])
  if (route === 'slots')
    await Promise.race([page.locator('.slot').first().waitFor(), page.locator('.empty').waitFor()])
  if (route === 'needs')
    await Promise.race([page.locator('.decision').first().waitFor(), page.locator('.empty').waitFor()])
  if (route === 'setup') await page.locator('.step').first().waitFor()
  if (route === 'settings') await page.locator('.settings-link').first().waitFor()
  // Then force every face the design uses to load — a font-swap between captures
  // would pixel-shift the whole screen.
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('400 16px "Instrument Sans"'),
      document.fonts.load('500 16px "Instrument Sans"'),
      document.fonts.load('600 16px "Instrument Sans"'),
      document.fonts.load('400 12px "Spline Sans Mono"'),
      document.fonts.load('500 12px "Spline Sans Mono"'),
    ])
    await document.fonts.ready
  })
  await expect(page.locator('.pane.is-active')).toBeVisible()
}

/** The countdown counts real seconds by design — mask it so pixel comparisons stay deterministic. */
const countdownMask = (page: Page) => [page.locator('.expires')]

// ── Screens: six routes × two themes ──────────────────────────────────────────────────────

for (const theme of THEMES) {
  for (const route of ROUTES) {
    test(`screen ${route} ${theme}`, async ({ page }) => {
      await openWorkbench(page, route, theme)
      await expect(page.locator('.pane.is-active')).toBeVisible()
      await expect(page).toHaveScreenshot(`${route}-${theme}.png`, { mask: countdownMask(page) })
    })
  }

  test(`context pane ${theme}`, async ({ page }) => {
    await openWorkbench(page, 'chat', theme)
    await page.getByRole('button', { name: 'See the diff and checks' }).click()
    const pane = page.locator('.context')
    await expect(pane).toBeVisible()
    await expect(pane.getByText('If you approve')).toBeVisible()
    await expect(pane).toHaveScreenshot(`context-${theme}.png`, { mask: countdownMask(page) })
  })

  test(`login sheet ${theme}`, async ({ page }) => {
    await openWorkbench(page, 'slots', theme)
    await page.getByRole('button', { name: 'Sign in again' }).click()
    const sheet = page.locator('.sheet')
    await expect(sheet).toBeVisible()
    await expect(sheet.getByText('never reads the token')).toBeVisible()
    await expect(sheet).toHaveScreenshot(`login-sheet-${theme}.png`, { mask: countdownMask(page) })
  })
}

// ── The §23 worked example renders with real shapes ───────────────────────────────────────

test('§23 worked example: the chat screen tells the whole story', async ({ page }) => {
  await openWorkbench(page, 'chat')

  // The request and the acknowledgement (§23.1).
  await expect(
    page.getByText('Add audit-log viewing to the console and expose it through the API'),
  ).toBeVisible()
  await expect(
    page.getByText('On it: adding audit-log viewing to the console and the API, with tests.'),
  ).toBeVisible()

  // The plan card with tiers and slots (§23.2).
  const plan = page.locator('.plan')
  await expect(plan).toBeVisible()
  const apiRow = plan.getByRole('row', { name: 'Storage and API for audit events' })
  await expect(apiRow).toBeVisible()
  await expect(apiRow.getByRole('cell', { name: 'balanced', exact: true })).toBeVisible()
  await expect(apiRow.getByRole('cell', { name: 'max-2', exact: true })).toBeVisible()

  // The parked-slot notice (§23.5).
  await expect(page.getByText('max-1 hit its five-hour window. It resets at 18:40.')).toBeVisible()

  // A question card and a decision card in the tray (§23.3, §23.8).
  await expect(page.getByText('Should deleted users stay identifiable in the audit log?')).toBeVisible()
  await expect(page.getByText('Push the branch and open a pull request')).toBeVisible()
  await expect(page.getByText(/Expires in \d+ min/)).toBeVisible()

  // The two-step approve names the effect.
  const approve = page.getByRole('button', { name: 'Approve' })
  await approve.click()
  await expect(page.getByRole('button', { name: 'Confirm: push and open PR' })).toBeVisible()

  // The evidence pane carries checks and findings (§23.6).
  await page.getByRole('button', { name: 'See the diff and checks' }).click()
  const pane = page.locator('.context')
  await expect(pane.getByText('Checks on 4f2c9e1')).toBeVisible()
  await expect(pane.getByText('lint', { exact: true })).toBeVisible()
  await expect(pane.getByText('Fixed, medium: console/AuditTable.tsx')).toBeVisible()
  await expect(pane.getByText('Declined, low: api/audit.ts')).toBeVisible()
})

// ── Keyboard only: no mouse from load to theme change ─────────────────────────────────────

test('a card the server has no evidence for cannot be approved, and can be denied', async ({ page }) => {
  await openWorkbench(page, 'chat', 'light', undefined, {
    'GET /api/inbox/conf_71/detail': { status: 404, body: { error: 'no detail for this confirmation' } },
  })
  const card = page.locator('[data-decision="conf_71"]')

  await expect(card).toContainText('it cannot be approved')
  await expect(card.getByRole('button', { name: 'Read the evidence again' })).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Approve' })).toBeDisabled()

  await card.focus()
  await page.keyboard.press('a')
  await expect(card.getByRole('button', { name: /^Confirm/ })).toHaveCount(0)

  await card.getByRole('button', { name: 'Deny' }).click()
  await expect(card).toHaveClass(/is-resolved/)
})

test('a card whose evidence did not load cannot be approved, by click or by key', async ({ page }) => {
  const broken = { detail: true }
  await openWorkbench(page, 'chat', 'light', broken)
  const card = page.locator('[data-decision="conf_71"]')

  const retry = card.getByRole('button', { name: 'Read the evidence again' })
  await expect(retry).toBeVisible()
  await expect(card.getByRole('button', { name: 'Approve' })).toBeDisabled()
  await expect(card.getByRole('button', { name: 'Deny' })).toBeEnabled()
  await expect(card).toContainText('could not be read')

  await card.focus()
  await page.keyboard.press('a')
  await expect(card.getByRole('button', { name: /^Confirm/ })).toHaveCount(0)

  broken.detail = false
  await retry.click()
  await expect(card.getByText('Push the branch and open a pull request')).toBeVisible()
  await expect(card.getByRole('button', { name: 'Approve' })).toBeEnabled()
  await expect(card).toBeFocused()
})

test('keyboard-only walkthrough', async ({ page }) => {
  await openWorkbench(page, 'chat')

  // J lands on the first open card; A arms (the card keeps focus), A confirms.
  await page.keyboard.press('j')
  await expect(page.locator('.decision:focus')).toHaveAttribute('data-decision', 'conf_71')
  await page.keyboard.press('a')
  await expect(page.getByRole('button', { name: 'Confirm: push and open PR' })).toBeVisible()
  await expect(page.locator('.decision:focus')).toHaveAttribute('data-decision', 'conf_71')
  await page.keyboard.press('a')
  await expect(page.getByText('Approved — the agent was told to continue.')).toBeVisible()
  await expect(page.locator('[data-decision="conf_71"]')).toHaveClass(/is-resolved/)
  await expect(page.locator('.rail-item', { hasText: 'Needs you' }).locator('.count')).toHaveText('1')

  // J again reaches the question; Tab picks a choice; Enter answers it.
  await page.keyboard.press('j')
  await expect(page.locator('.decision:focus')).toHaveAttribute('data-decision', 'q_12')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Keep the user id' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-decision="q_12"]')).toHaveClass(/is-resolved/)
  await expect(page.getByRole('button', { name: 'Keep the user id' })).toHaveClass(/is-selected/)
  await expect(page.locator('.rail-item', { hasText: 'Needs you' }).locator('.count')).toHaveText('0')

  // G W jumps to Work; Tab focuses a row; Enter opens the pane; Esc closes it.
  await page.keyboard.press('g')
  await page.keyboard.press('w')
  await expect(page.locator('#pane-work')).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(page.locator('.row:focus')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.locator('.context')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.context')).toBeHidden()

  // '/' focuses the composer; Enter sends.
  await page.keyboard.press('/')
  await expect(page.locator('#composer-input')).toBeFocused()
  await page.keyboard.type('also hide the export button for viewers')
  await page.keyboard.press('Enter')
  await expect(page.getByText('also hide the export button for viewers')).toBeVisible()

  // ⌘K opens the palette; the theme command switches the theme — no mouse anywhere.
  await page.keyboard.press('Meta+k')
  await expect(page.locator('.palette')).toBeVisible()
  const themeCommand = page.locator('.palette-list button', { hasText: 'Switch to the dark theme' })
  await themeCommand.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

// ── Old deep links keep landing where they always did ──────────────────────────────────────

test('old #/wizard deep link opens Setup', async ({ page }) => {
  await openWorkbench(page, 'chat')
  await page.goto('#/wizard')
  await expect(page.locator('#pane-setup')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Set up MEC' })).toBeVisible()
})

test('old #/inbox deep link opens Needs you', async ({ page }) => {
  await openWorkbench(page, 'chat')
  await page.goto('#/inbox')
  await expect(page.locator('#pane-needs')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible()
})

// ── The Esc chain, one link at a time ─────────────────────────────────────────────────────

test('Esc walks the chain: palette → armed approval → pane', async ({ page }) => {
  await openWorkbench(page, 'chat')

  await page.keyboard.press('j')
  await page.keyboard.press('a')
  await expect(page.getByRole('button', { name: 'Confirm: push and open PR' })).toBeVisible()

  // Opening the palette and pressing Esc closes only the palette.
  await page.keyboard.press('Meta+k')
  await expect(page.locator('.palette')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette')).toBeHidden()

  // The next Esc disarms the approval — the card is untouched.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible()

  // A card's evidence opens on Enter and yields to Esc.
  await page.keyboard.press('Enter')
  await expect(page.locator('.context')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.context')).toBeHidden()
})

// ── Recovery: a failing view leaves the shell usable ──────────────────────────────────────

test('Settings: a failing prompts read ends in an error with Retry; the shell stays usable', async ({
  page,
}) => {
  await openWorkbench(
    page,
    'settings',
    'light',
    { detail: false },
    {
      'GET /api/prompts': { status: 500, body: { error: 'boom' } },
      'GET /api/models': { status: 404, body: { error: 'not found' } },
    },
  )
  const alert = page.locator('#settings-prompts [data-load-failed]')
  await expect(alert).toContainText('Could not load the prompt parts')
  await expect(page.getByText('Loading the parts…')).toBeHidden()

  // Models: the JSON 404 is "not served", also a finite state, never demo data.
  await page.getByRole('button', { name: 'Models' }).click()
  await expect(page.locator('#settings-models [data-load-failed]')).toContainText('HTTP 404')
  await expect(page.locator('table.tiers')).toHaveCount(0)

  // The rest of the shell still works.
  await page.getByRole('link', { name: /Work/ }).first().click()
  await expect(page.locator('#pane-work')).toBeVisible()
})

test('a view that throws while drawing is contained to its pane', async ({ page }) => {
  await openWorkbench(
    page,
    'settings',
    'light',
    { detail: false },
    {
      'GET /api/chat/messages': {
        status: 200,
        body: [
          {
            id: 'm1',
            text: 'x',
            createdAt: '2026-11-04T14:02:00Z',
            kind: 'agent',
            plan: { tasks: 'broken' },
          },
        ],
      },
    },
  )
  await page.goto('#chat')
  await expect(page.getByRole('heading', { name: 'This view could not be shown' })).toBeVisible()
  await expect(page.locator('.rail')).toBeVisible()
  await page.getByRole('link', { name: /Slots/ }).first().click()
  await expect(page.locator('#pane-slots')).toBeVisible()
})
