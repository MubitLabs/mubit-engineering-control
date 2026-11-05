import { expect, type Page, test } from '@playwright/test'
import {
  cardEvidence,
  chatLines,
  needsPage,
  searchPage,
  taskDetails,
  workDetails,
  workPage,
} from './fixtures/inspection-fixtures'

/**
 * `?ui=next` on the live path: the real LiveApp, fetches and decoders, with `page.route` standing
 * in for the server. The payloads are the fixtures test/inspection-contract.test.ts holds to the
 * real server's shape. Everything a real server has to prove is the verifier's, on the built app.
 */

const REPOSITORIES = [
  { id: 'repo_a', url: '/sample/sample-console', bootstrap: [], checks: [], trust: true },
  { id: 'repo_b', url: '/sample/sample-billing', bootstrap: [], checks: [], trust: true },
]
const OBSERVED = '2026-11-05T10:00:00.000Z'

type Reply = { status: number; body: unknown }

interface Over {
  work?: () => Reply
  needs?: () => Reply
  resolve?: (answer: string) => Reply
  answer?: () => Reply
  evidence?: (id: string) => Reply
}

async function server(page: Page, over: Over = {}) {
  const reads: string[] = []
  const posts: { path: string; body: unknown }[] = []
  const streams: string[] = []
  const answers = new Map<string, string>()
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url
    const send = ({ status, body }: Reply) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const ok = (body: unknown) => send({ status: 200, body })
    const repoId = url.searchParams.get('repoId')

    if (request.method() === 'POST') {
      const body = request.postDataJSON() as { answer?: string } | null
      posts.push({ path: pathname, body })
      if (pathname.endsWith('/resolve')) {
        return send(over.resolve?.(body?.answer ?? '') ?? { status: 200, body: { status: 'denied' } })
      }
      if (pathname.endsWith('/answer')) {
        return send(over.answer?.() ?? { status: 200, body: { status: 'answered' } })
      }
      const command = /\/api\/work\/([^/]+)\/(hold|lift|stop)$/.exec(pathname)
      if (command) {
        const status = { hold: 'held', lift: 'lifted', stop: 'stopped' }[command[2] as 'hold']
        return ok({ id: command[1], status })
      }
      return send({ status: 404, body: { error: 'not found' } })
    }

    if (pathname === '/api/events') {
      streams.push(url.search)
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' })
    }
    reads.push(pathname)
    if (pathname === '/api/repositories') return ok(REPOSITORIES)
    if (pathname === '/api/work') {
      const scoped = workPage.items.filter((row) => row.repoId === repoId)
      return ok(scoped.map((row) => ({ ...row, title: row.title ?? undefined, stage: row.state })))
    }
    if (pathname === '/api/chat/messages') {
      return ok(repoId === 'repo_a' ? chatLines.map((line) => ({ ...line, repoId })) : [])
    }
    if (pathname === '/api/inspect/snapshot') {
      return ok({
        observedAt: OBSERVED,
        repositories: [
          { id: 'repo_a', label: 'sample-console', needsCount: 0 },
          { id: 'repo_b', label: 'sample-billing', needsCount: 0 },
        ],
        repositoriesTruncated: 0,
        needsCount: 0,
        cursors: { repositories: 1 },
      })
    }
    if (pathname === '/api/inspect/work') return send(over.work?.() ?? { status: 200, body: workPage })
    if (pathname === '/api/inspect/needs') return send(over.needs?.() ?? { status: 200, body: needsPage })
    if (pathname === '/api/inspect/search') return ok(searchPage)
    const work = /^\/api\/inspect\/work\/(.+)$/.exec(pathname)
    if (work) return ok(workDetails[decodeURIComponent(work[1] as string) as keyof typeof workDetails])
    const task = /^\/api\/inspect\/tasks\/(.+)$/.exec(pathname)
    if (task) return ok(taskDetails[decodeURIComponent(task[1] as string) as keyof typeof taskDetails])
    const detail = /^\/api\/inbox\/(.+)\/detail$/.exec(pathname)
    if (detail) {
      const id = decodeURIComponent(detail[1] as string)
      return send(over.evidence?.(id) ?? { status: 200, body: cardEvidence[id as keyof typeof cardEvidence] })
    }
    return send({ status: 404, body: { error: 'not found' } })
  })
  return { reads, posts, streams, answers }
}

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`/?ui=next#${hash}`)
  await expect(page.locator('.shell')).toBeVisible()
}

const refetch = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
const needsLink = (page: Page) => page.locator('.rail').getByRole('button', { name: /Needs you/ })

test.use({ timezoneId: 'UTC', locale: 'en-GB' })

test.describe('Work', () => {
  test('groups by stage and reads no detail for a row nobody opened', async ({ page }) => {
    const { reads } = await server(page)
    await open(page, 'repo/repo_a/work')
    await expect(page.getByRole('region', { name: 'Held' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Ended' })).toContainText('Merged')
    expect(reads.filter((path) => path.startsWith('/api/inspect/work/'))).toEqual([])
  })

  test('8 each row opens its own task and stays selected', async ({ page }) => {
    const { reads } = await server(page)
    await open(page, 'repo/repo_a/work')
    await page.locator('.work-row', { hasText: 'search for the console' }).click()
    await page.getByRole('button', { name: /build the index/ }).click()
    await expect(page.locator('.inspector h2, .inspector h1').first()).toContainText('build the index')
    await expect(page.locator('.delivery .task-row[aria-current="true"]')).toContainText('build the index')
    await expect(page.locator('.work-row[aria-current="true"]')).toHaveCount(1)
    expect(reads.filter((path) => path.startsWith('/api/inspect/work/'))).toEqual([
      '/api/inspect/work/work_working',
    ])
    await page.getByRole('button', { name: /read the code/ }).click()
    await expect(page.locator('.inspector h2, .inspector h1').first()).toContainText('read the code')
  })

  test('a reload keeps the task open, from its address', async ({ page }) => {
    await server(page)
    await open(page, 'repo/repo_a/work/work_working/task/task_active')
    await expect(page.locator('.inspector')).toContainText('build the index')
  })

  test('switching repository drops the inspector', async ({ page }) => {
    await server(page)
    await open(page, 'repo/repo_a/work/work_working/task/task_active')
    await expect(page.locator('.inspector')).toBeVisible()
    await page
      .getByRole('button', { name: /Switch repository|Choose a repository/ })
      .first()
      .click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /sample-billing/ })
      .click()
    await expect(page.locator('.inspector')).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Repository' })).toHaveValue('repo_b')
  })

  test('a filter that hides the row drops its inspector and selection', async ({ page }) => {
    await server(page)
    await open(page, 'repo/repo_a/work/work_working/task/task_active')
    await expect(page.locator('.inspector')).toBeVisible()
    await page.getByRole('combobox', { name: 'Repository' }).selectOption('repo_b')
    await expect(page.locator('.inspector')).toHaveCount(0)
    await expect(page.locator('.work-row[aria-current="true"]')).toHaveCount(0)
  })

  test('stop takes two steps and posts the row’s own id under All repositories', async ({ page }) => {
    const { posts } = await server(page)
    await open(page, 'repo/repo_b/work/work_quota')
    await expect(page.getByRole('combobox', { name: 'Repository' })).toHaveValue('all')
    await page.getByRole('button', { name: 'Stop in sample-billing' }).click()
    expect(posts).toEqual([])
    await page.getByRole('button', { name: 'Stop in sample-billing' }).click()
    await page.getByRole('button', { name: 'Confirm: stop this delivery in sample-billing' }).click()
    await expect(page.getByText('Stopped.')).toBeVisible()
    expect(posts.map((post) => post.path)).toEqual(['/api/work/work_quota/stop'])
  })

  test('hold and lift go to the routes, and pause is not offered', async ({ page }) => {
    const { posts } = await server(page)
    await open(page, 'repo/repo_a/work/work_held')
    await page.getByRole('button', { name: /Lift hold/ }).click()
    await expect(page.getByText('Hold lifted.')).toBeVisible()
    expect(posts.map((post) => post.path)).toEqual(['/api/work/work_held/lift'])
    await expect(page.getByRole('button', { name: /Pause/ })).toHaveCount(0)
  })

  test('discussing moves to the item’s own repository and names it', async ({ page }) => {
    await server(page)
    await open(page, 'repo/repo_b/work/work_working')
    await page.getByRole('button', { name: 'Discuss this work in sample-console' }).click()
    await expect(page.getByText(/Following up on/)).toBeVisible()
    await expect(page).toHaveURL(/#repo\/repo_a\/chat$/)
  })

  test('error keeps content and offers retry', async ({ page }) => {
    let down = false
    await server(page, {
      work: () => (down ? { status: 503, body: { error: 'down' } } : { status: 200, body: workPage }),
    })
    await open(page, 'repo/repo_a/work')
    await expect(page.getByRole('region', { name: 'Ended' })).toBeVisible()
    down = true
    await refetch(page)
    await expect(page.getByRole('alert')).toContainText('Could not read work')
    await expect(page.getByRole('region', { name: 'Ended' })).toBeVisible()
    await expect(page.locator('.freshness[data-stale="true"]')).toContainText('Stale. Last read')
    down = false
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('.freshness[data-stale="false"]')).toBeVisible()
  })

  test('an over-large record is a recoverable error', async ({ page }) => {
    await server(page, {
      work: () => ({ status: 500, body: { error: 'response_too_large', detail: 'too large' } }),
    })
    await open(page, 'repo/repo_a/work')
    await expect(page.getByRole('alert')).toContainText('too large to show here')
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
  })
})

test.describe('Needs you', () => {
  test('the sidebar count is the waiting list', async ({ page }) => {
    await server(page)
    await open(page, 'repo/repo_a/needs')
    const waiting = page.locator('.decision[data-state="open"]')
    await expect(waiting.first()).toBeVisible()
    const shown = await waiting.count()
    const blocked = await page.locator('.page > .notice-blocked').count()
    await expect(needsLink(page)).toContainText(String(shown + blocked))
  })

  test('a failed read is no count and not nothing waiting', async ({ page }) => {
    await server(page, { needs: () => ({ status: 503, body: { error: 'down' } }) })
    await open(page, 'repo/repo_a/needs')
    await expect(page.getByRole('alert')).toContainText('Could not read what needs you')
    await expect(needsLink(page).locator('.count')).toHaveCount(0)
  })

  test('approve arms, confirms and shows the server’s hold', async ({ page }) => {
    const { posts } = await server(page, {
      resolve: () => ({ status: 200, body: { status: 'pending', reason: 'ci_pending' } }),
    })
    await open(page, 'repo/repo_a/needs')
    const card = page.locator('article.decision', { hasText: 'push search to sample-console' })
    await card.getByRole('button', { name: 'Approve' }).click()
    expect(posts).toEqual([])
    await card.getByRole('button', { name: 'Confirm: push in sample-console' }).click()
    await expect(page.getByText('Required checks are still running.')).toBeVisible()
    await expect(card).toHaveAttribute('data-state', 'open')
    expect(posts).toEqual([{ path: '/api/inbox/card_pending/resolve', body: { answer: 'approve' } }])
  })

  test('deny says denied, not approved', async ({ page }) => {
    await server(page)
    await open(page, 'repo/repo_a/needs')
    const card = page.locator('article.decision', { hasText: 'push search to sample-console' })
    await card.getByRole('button', { name: 'Deny' }).click()
    await expect(card.locator('.settled-label')).toHaveText('Denied')
    await expect(card).toContainText('Nothing ran.')
  })

  test('a card whose evidence is 404 cannot be approved, and can be denied', async ({ page }) => {
    const { posts } = await server(page, {
      evidence: () => ({ status: 404, body: { error: 'no detail for this confirmation' } }),
    })
    await open(page, 'repo/repo_a/needs')
    const missing = page.locator('.decision-missing').first()
    await expect(missing).toContainText('cannot be approved yet')
    await expect(missing.getByRole('button', { name: 'Approve' })).toHaveCount(0)
    await missing.getByRole('button', { name: 'Deny' }).click()
    await expect.poll(() => posts.length).toBe(1)
    expect(posts[0]?.body).toEqual({ answer: 'deny' })
  })

  test('a second answer gets the already-answered state', async ({ page }) => {
    await server(page, { answer: () => ({ status: 409, body: { error: 'already_answered' } }) })
    await open(page, 'repo/repo_a/needs')
    const card = page.locator('article.decision', { hasText: 'include archived rows' })
    await card.getByRole('radio').first().check()
    await card.getByRole('button', { name: 'Send answer' }).click()
    await expect(card.locator('.settled-label')).toHaveText('Already answered')
  })

  test('11 a settled card stays with its own repository', async ({ page }) => {
    await server(page)
    await open(page, 'repo/repo_a/needs')
    await expect(page.locator('article.decision', { hasText: 'merge pull request 9' })).toBeVisible()
    await page.getByRole('combobox', { name: 'Repository' }).selectOption('repo_a')
    await expect(page.locator('article.decision', { hasText: 'merge pull request 9' })).toHaveCount(0)
  })

  test('inspecting a card opens the card’s own evidence', async ({ page }) => {
    await server(page)
    await open(page, 'repo/repo_a/needs')
    const card = page.locator('article.decision', { hasText: 'push search to sample-console' })
    await card.getByRole('button', { name: 'Inspect checks and diff' }).click()
    await expect(page.locator('.inspector')).toContainText('card check')
  })
})

test.describe('Conversation and search', () => {
  const oneDelivery = () => ({
    status: 200,
    body: { ...workPage, items: workPage.items.filter((row) => row.id === 'work_working') },
  })

  test('the request title leads, the plan shows and tool activity stays out', async ({ page }) => {
    await server(page, { work: oneDelivery })
    await open(page, 'repo/repo_a/chat')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('search for the console')
    await expect(page.locator('.delivery')).toBeVisible()
    await expect(page.getByText('tool call that stays out of chat')).toHaveCount(0)
  })

  test('a task opens from the plan, and Inspect is evidence, never a chat', async ({ page }) => {
    await server(page, { work: oneDelivery })
    await open(page, 'repo/repo_a/chat')
    await page
      .locator('.delivery')
      .getByRole('button', { name: /build the index/ })
      .click()
    await expect(page.locator('.inspector')).toContainText('build the index')
    await expect(page.getByRole('textbox', { name: 'Message the meta agent' })).toBeVisible()
  })

  test('search keeps composer intent and the active repository', async ({ page }) => {
    await server(page)
    await open(page, 'repo/repo_b/chat')
    await expect(page.getByText('New request in sample-billing')).toBeVisible()
    await page.getByRole('button', { name: 'Search' }).click()
    await page.getByRole('searchbox').fill('build')
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /build the index/ })
      .click()
    await expect(page).toHaveURL(/#repo\/repo_b\/work\/work_working\/task\/task_active$/)
    await expect(page.locator('.inspector')).toContainText('build the index')
    await page.locator('.rail').getByRole('button', { name: 'Conversation' }).click()
    await expect(page.getByText('New request in sample-billing')).toBeVisible()
  })

  test('the palette opens search', async ({ page }) => {
    await server(page)
    await open(page, 'repo/repo_a/chat')
    await page.keyboard.press('Control+k')
    await page.getByRole('option', { name: 'Search' }).click()
    await expect(page.getByRole('searchbox')).toBeFocused()
  })
})

test('the events connection starts from the snapshot’s cursors', async ({ page }) => {
  const { streams } = await server(page)
  await open(page, 'repo/repo_a/work')
  await expect(page.getByRole('region', { name: 'Ended' })).toBeVisible()
  await expect.poll(() => streams.length).toBeGreaterThan(0)
  expect(streams.at(-1)).toContain('repositories')
  expect(streams.at(-1)).toMatch(/after=(?:[\d,]*,)?1$/)
})

for (const [width, height] of [
  [1440, 900],
  [1024, 768],
  [390, 844],
] as const) {
  for (const theme of ['light', 'dark']) {
    test.describe(`${width} ${theme}`, () => {
      test.use({ viewport: { width, height } })

      for (const hash of ['repo/repo_a/chat', 'repo/repo_a/work/work_working', 'repo/repo_a/needs']) {
        test(`no horizontal scroll on ${hash}`, async ({ page }) => {
          await page.addInitScript((value) => localStorage.setItem('mec-next-theme', value), theme)
          await server(page)
          await open(page, hash)
          await expect(page.locator('h1')).toBeVisible()
          await expect(page.locator('.freshness').first()).toBeVisible()
          const scroll = await page.evaluate(() => document.documentElement.scrollWidth)
          expect(scroll).toBeLessThanOrEqual(width)
        })
      }
    })
  }
}
