import { expect, type Page } from '@playwright/test'

/**
 * The matrix of the M3.4 handoff: six surfaces, the states and every sheet, at three widths in
 * two themes. a11y.screens.playwright.ts runs axe over it and limits.screens.playwright.ts the
 * measured limits, so a cell added here is covered by both.
 */

export const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
] as const
export const THEMES = ['light', 'dark'] as const

const NEXT = '/test/fixtures/next-harness.html'
const WORK = '/test/fixtures/work-harness.html'
const CONFIG = '/test/fixtures/config-harness.html'

export interface Cell {
  name: string
  url: string
  /** What must be on screen before anything reads the page, so a half-drawn page cannot pass. */
  ready: string
  /** Puts the page in the state under test, after `ready`. */
  open?: (page: Page) => Promise<void>
  /** Where axe looks. The shell, unless a modal holds the page. */
  surface?: string
}

const DIALOG = '[role="dialog"]'
const openDialog = (run: (page: Page) => Promise<void>) => async (page: Page) => {
  await run(page)
  await expect(page.getByRole('dialog').last()).toBeVisible()
}
const button = (page: Page, name: string | RegExp) =>
  page.getByRole('button', { name, exact: typeof name === 'string' })

export const SURFACES: readonly Cell[] = [
  { name: 'Conversation', url: `${NEXT}#chat`, ready: '.composer' },
  { name: 'Work', url: `${WORK}#work`, ready: '.page h1' },
  { name: 'Needs you', url: `${WORK}#needs`, ready: '.page h1' },
  { name: 'Connections', url: `${CONFIG}#slots`, ready: '.connection' },
  { name: 'Setup', url: `${CONFIG}#setup`, ready: '.page h1' },
  { name: 'Settings', url: `${CONFIG}#settings`, ready: '.page h1' },
]

export const STATES: readonly Cell[] = [
  { name: 'inspector', url: `${NEXT}?task=task_build&inspector=open#chat`, ready: '[role="tab"]' },
  { name: 'empty', url: `${NEXT}?state=empty#chat`, ready: '.empty' },
  { name: 'working', url: `${NEXT}?state=working#chat`, ready: '.delivery' },
  { name: 'blocked', url: `${NEXT}?state=blocked&task=task_build#chat`, ready: '.conversation' },
  { name: 'error', url: `${NEXT}?state=error#chat`, ready: '.conversation' },
  { name: 'completed', url: `${NEXT}?state=completed#chat`, ready: '.conversation' },
  { name: 'state notices', url: `${NEXT}?state=states#chat`, ready: '.shell' },
  { name: 'resolved and expired', url: `${NEXT}#needs`, ready: '.decision[data-state="expired"]' },
  { name: 'work empty', url: `${WORK}?state=empty#work`, ready: '.page h1' },
  { name: 'work failed', url: `${WORK}?state=failed#work`, ready: '.page h1' },
  { name: 'work stale', url: `${WORK}?state=error#work`, ready: '.page h1' },
  { name: 'work delivery', url: `${WORK}?work=work_working#work`, ready: '.work-detail' },
  { name: 'needs empty', url: `${WORK}?state=empty#needs`, ready: '.page h1' },
  { name: 'needs settled', url: `${WORK}#needs`, ready: '.decision' },
  {
    name: 'approval armed',
    url: `${NEXT}#needs`,
    ready: '.decision',
    open: async (page) => {
      await button(page, 'Approve push').first().click()
      await expect(button(page, 'Confirm: push sample branch')).toBeVisible()
    },
  },
  { name: 'setup empty', url: `${CONFIG}?empty=1#setup`, ready: '.page h1' },
  {
    name: 'connection adding',
    url: `${CONFIG}#slots`,
    ready: '.connection',
    open: async (page) => {
      await button(page, 'Add connection').click()
      await expect(page.getByLabel('Engine')).toBeVisible()
    },
  },
  {
    name: 'connection retiring',
    url: `${CONFIG}#slots`,
    ready: '.connection',
    open: async (page) => {
      const row = page.locator('.connection').filter({ hasText: 'sample-key' })
      await row.getByRole('button', { name: 'Retire', exact: true }).click()
      await expect(page.getByLabel('Type sample-key to confirm')).toBeVisible()
    },
  },
]

export const SHEETS: readonly Cell[] = [
  {
    name: 'palette',
    url: `${NEXT}#chat`,
    ready: '.composer',
    surface: DIALOG,
    open: openDialog((page) => page.keyboard.press('Control+k')),
  },
  {
    name: 'repository sheet',
    url: `${NEXT}#chat`,
    ready: '.composer',
    surface: DIALOG,
    open: openDialog(async (page) => {
      // The repository button lives in the rail, which is the drawer at phone width.
      const menu = button(page, 'Open navigation')
      if (await menu.isVisible()) await menu.click()
      await button(page, /Repository: Sample console/).click()
    }),
  },
  {
    name: 'glossary sheet',
    url: `${WORK}#work`,
    ready: '.page h1',
    surface: DIALOG,
    open: openDialog((page) => button(page, 'Open glossary').click()),
  },
  {
    name: 'search sheet',
    url: `${WORK}#chat`,
    ready: '.page-header',
    surface: DIALOG,
    open: openDialog(async (page) => {
      await page.keyboard.press('Control+k')
      await page.getByRole('option', { name: 'Search', exact: true }).click()
      await page.getByRole('searchbox').fill('build the index')
      await expect(page.locator('.search-results button').first()).toBeVisible()
    }),
  },
]

/** At the widths where the inspector is a modal; the wide one is the `inspector` state above. */
const INSPECTOR_SHEET: Cell = {
  name: 'inspector sheet',
  url: `${NEXT}#chat`,
  ready: '.delivery',
  surface: DIALOG,
  open: openDialog((page) => button(page, /Build the sample search/).click()),
}

const DRAWER: Cell = {
  name: 'drawer',
  url: `${NEXT}#chat`,
  ready: '.composer',
  surface: DIALOG,
  open: openDialog((page) => button(page, 'Open navigation').click()),
}

/** Every cell for one width. */
export function cellsAt(width: number): readonly Cell[] {
  return [
    ...SURFACES,
    ...STATES,
    ...SHEETS,
    ...(width < 1150 ? [INSPECTOR_SHEET] : []),
    ...(width <= 760 ? [DRAWER] : []),
  ]
}

export async function openCell(page: Page, theme: string, cell: Cell): Promise<void> {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('mec-next-theme', value)
    } catch {}
  }, theme)
  await page.goto(cell.url)
  await expect(page.locator('.shell')).toBeVisible()
  await expect(page.locator(cell.ready).first()).toBeVisible()
  await cell.open?.(page)
  // Read from the settled page, not from the middle of a colour transition.
  await page.evaluate(() =>
    // A transition cut short by a focus move rejects, and that is settled too.
    Promise.allSettled(document.getAnimations().map((animation) => animation.finished)),
  )
}
