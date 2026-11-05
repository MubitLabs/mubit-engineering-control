import { expect, type Page, test } from '@playwright/test'

/**
 * The next shell behind its flag: `?ui=next` runs the live path against route mocks here (the
 * real server is the verifier's job), and fixtures/next-harness.html renders the same components
 * with synthetic props. The numbers in
 * the test names are the prototype defects this shell must not repeat (the design audit).
 * Axe and Lighthouse are not installed here: nothing below claims them.
 */

const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
] as const
const THEMES = ['light', 'dark'] as const
const HARNESS = '/test/fixtures/next-harness.html'

async function setTheme(page: Page, theme: string): Promise<void> {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('mec-next-theme', value)
    } catch {}
  }, theme)
}

interface MockRepo {
  id: string
  url: string
  bootstrap: string[]
  checks: never[]
  trust: boolean
}
interface MockRow {
  id: string
  repoId?: string
  [field: string]: unknown
}
interface MockPost {
  key: string
  body: { text: string; repoId: string; intent?: string; referencesWorkItem?: string }
}

const repository = (name: string): MockRepo => ({
  id: `repo_${name}`,
  url: `https://example.test/acme/${name}`,
  bootstrap: [],
  checks: [],
  trust: true,
})
const REPO_A = repository('alpha')
const REPO_B = repository('beta')

const workRow = (id: string, repoId: string | undefined, title: string): MockRow => ({
  id,
  ...(repoId !== undefined && { repoId }),
  title,
  state: 'executing',
  stage: 'executing',
  taskCounts: { total: 1, byStatus: { active: 1 } },
  updatedAt: '2026-11-05T12:00:00Z',
})

/** The server's real shapes, in memory: `repoId` filters reads and a key admits one message. */
async function mockServer(
  page: Page,
  seed: { repositories?: MockRepo[]; messages?: MockRow[]; work?: MockRow[] } = {},
) {
  const repositories = seed.repositories ?? []
  const messages = [...(seed.messages ?? [])]
  const work = [...(seed.work ?? [])]
  const posts: MockPost[] = []
  const seen = new Set<string>()
  const scoped = (rows: MockRow[], repoId: string | null) => {
    if (repoId === null) return rows
    return rows.filter((row) => (repoId === 'unassigned' ? row.repoId === undefined : row.repoId === repoId))
  }
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    const repoId = url.searchParams.get('repoId')
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname === '/api/repositories') return json(repositories)
    if (url.pathname === '/api/work') return json(scoped(work, repoId))
    if (url.pathname === '/api/chat/messages' && method === 'GET') return json(scoped(messages, repoId))
    if (url.pathname === '/api/chat/messages' && method === 'POST') {
      const body = route.request().postDataJSON() as MockPost['body']
      const key = route.request().headers()['x-idempotency-key'] ?? ''
      posts.push({ key, body })
      if (!seen.has(key)) {
        seen.add(key)
        const id = `msg_${seen.size}`
        messages.push({ id, repoId: body.repoId, text: body.text, createdAt: '', ackText: 'On it' })
        if (body.intent === 'new') work.push(workRow(`wi_${seen.size}`, body.repoId, body.text))
      }
      return json({ messageId: `msg_${seen.size}` })
    }
    if (url.pathname === '/api/events') {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' })
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' })
  })
  return { posts, messages, work }
}

async function live(page: Page, hash = 'chat'): Promise<void> {
  await mockServer(page)
  await page.goto(`/?ui=next#${hash}`)
  await expect(page.locator('.shell')).toBeVisible()
}

const composerBox = (page: Page) => page.getByRole('textbox', { name: 'Message the meta agent' })
const refetch = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
const switchTo = async (page: Page, name: string) => {
  await page
    .getByRole('button', { name: /Switch repository|Choose a repository/ })
    .first()
    .click()
  await page.getByRole('dialog').getByRole('button', { name }).click()
}

async function harness(page: Page, query = '', hash = 'chat'): Promise<void> {
  await page.goto(`${HARNESS}?${query}#${hash}`)
  await expect(page.locator('.shell')).toBeVisible()
}

async function focusIsOnBody(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement === document.body || document.activeElement === null)
}

async function expectBounded(page: Page): Promise<void> {
  const box = await page.evaluate(() => {
    const root = document.documentElement
    return {
      height: root.scrollHeight,
      width: root.scrollWidth,
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
    }
  })
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
      if (parent.closest('.sr-only, script, style')) continue
      if (Number.parseFloat(getComputedStyle(parent).fontSize) < 12) {
        found.push(`small text: ${walker.currentNode.textContent}`)
      }
    }
    for (const control of document.querySelectorAll(
      'button, a[href], select, [role="tab"], [role="option"]',
    )) {
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

const openDrawer = async (page: Page) => page.getByRole('button', { name: 'Open navigation' }).click()
const inertRoot = (page: Page) => page.evaluate(() => document.getElementById('root')?.inert)

test.describe('the flag', () => {
  test('classic is the default, with no param and no stored choice', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.rail-item').first()).toBeVisible()
    await expect(page.locator('.scroller')).toHaveCount(0)
  })

  test('?ui=next applies, strips the param, keeps the hash and survives a reload', async ({ page }) => {
    await page.goto('/?ui=next#work')
    await expect(page.locator('.shell h1')).toHaveText('Work')
    expect(new URL(page.url()).search).toBe('')
    expect(new URL(page.url()).hash).toBe('#work')
    await page.reload()
    await expect(page.locator('.shell h1')).toHaveText('Work')
  })

  test('the way back: Return to the classic workbench turns the flag off', async ({ page }) => {
    await live(page)
    await page.getByRole('link', { name: 'Return to the classic workbench' }).click()
    await expect(page.locator('.rail-item').first()).toBeVisible()
    await page.reload()
    await expect(page.locator('.rail-item').first()).toBeVisible()
  })

  test('throwing storage stays classic even when ?ui=next asks', async ({ page }) => {
    await page.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException('denied', 'SecurityError')
      }
    })
    await page.goto('/?ui=next')
    await expect(page.locator('.rail-item').first()).toBeVisible()
  })
})

test.describe('?ui=next is honest with no repository', () => {
  for (const hash of ['chat', 'work', 'needs', 'slots', 'setup', 'settings']) {
    test(`#${hash}: reads only, no sample, no false reassurance`, async ({ page }) => {
      const writes: string[] = []
      page.on('request', (request) => {
        if (request.method() !== 'GET') writes.push(new URL(request.url()).pathname)
      })
      await live(page, hash)
      await expect(page.getByRole('link', { name: 'Return to the classic workbench' })).toBeVisible()
      await expect(page.getByText('No repository', { exact: true }).first()).toBeVisible()
      const text = await page.locator('body').innerText()
      expect(text).not.toMatch(/sample|nothing is waiting|healthy|checks passed/i)
      await expect(page.locator('.count')).toHaveCount(0)
      await expect(page.locator('.decision')).toHaveCount(0)
      await expect(page.locator('.inspector')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Open details' })).toHaveCount(0)
      expect(writes).toEqual([])
    })
  }

  test('the composer cannot send, and says why', async ({ page }) => {
    await live(page)
    await expect(composerBox(page)).toHaveAttribute('readonly', '')
    await expect(page.getByText('Add a repository in Setup to send.')).toBeVisible()
    await expect(page.getByText('Enter to send')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Send' })).toHaveAttribute('aria-disabled', 'true')
  })

  test('the empty state points at Setup in classic', async ({ page }) => {
    await live(page)
    await expect(page.getByRole('link', { name: 'Open Setup' })).toHaveAttribute('href', '?ui=classic#setup')
  })

  test('a failed read ends in Retry, not endless loading', async ({ page }) => {
    let broken = true
    await page.route('**/api/**', (route) =>
      broken
        ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
        : route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    )
    await page.goto('/?ui=next#chat')
    await expect(page.getByText('Could not load your repositories')).toBeVisible()
    broken = false
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByText('Add a repository to begin')).toBeVisible()
  })
})

test.describe('the repo workspace', () => {
  const twoRepos = (page: Page, extra: { messages?: MockRow[]; work?: MockRow[] } = {}) =>
    mockServer(page, { repositories: [REPO_A, REPO_B], ...extra })
  const start = async (page: Page, hash = `repo/${REPO_A.id}/chat`) => {
    await page.goto(`/?ui=next#${hash}`)
    await expect(page.locator('.shell')).toBeVisible()
  }

  test('one repository needs no choice, and the composer names it', async ({ page }) => {
    await mockServer(page, { repositories: [REPO_A] })
    await page.goto('/?ui=next#chat')
    await expect(page.getByText('New request in alpha')).toBeVisible()
    expect(new URL(page.url()).hash).toBe('#chat')
  })

  test('several and none chosen: the choice is open and the composer says why', async ({ page }) => {
    await twoRepos(page)
    await page.goto('/?ui=next#chat')
    await expect(page.getByRole('heading', { name: 'Choose a repository' })).toBeVisible()
    await expect(composerBox(page)).toHaveAttribute('readonly', '')
    await expect(page.getByText('Choose a repository to send.')).toBeVisible()
    await page.locator('.choices').getByRole('button', { name: /beta/ }).click()
    await expect(page.getByText('New request in beta')).toBeVisible()
    expect(new URL(page.url()).hash).toBe(`#repo/${REPO_B.id}/chat`)
  })

  test('a repository that has gone falls back with a notice', async ({ page }) => {
    await mockServer(page, { repositories: [REPO_A] })
    await page.goto('/?ui=next#repo/repo_gone/chat')
    await expect(page.getByText('That repository is no longer registered. Showing alpha.')).toBeVisible()
    await expect(page.getByText('New request in alpha')).toBeVisible()
  })

  test('two repos keep their own draft and conversation', async ({ page }) => {
    await twoRepos(page, {
      messages: [
        { id: 'm_a', repoId: REPO_A.id, text: 'Only in alpha', createdAt: '' },
        { id: 'm_b', repoId: REPO_B.id, text: 'Only in beta', createdAt: '' },
      ],
    })
    await start(page)
    await expect(page.getByText('Only in alpha')).toBeVisible()
    await composerBox(page).fill('draft for alpha')

    await switchTo(page, 'beta')
    await expect(page.getByText('Only in beta')).toBeVisible()
    await expect(page.getByText('Only in alpha')).toHaveCount(0)
    await expect(composerBox(page)).toHaveValue('')
    await composerBox(page).fill('draft for beta')

    await page.reload()
    await expect(composerBox(page)).toHaveValue('draft for beta')
    await page.goBack()
    await expect(page.getByText('Only in alpha')).toBeVisible()
    await expect(composerBox(page)).toHaveValue('draft for alpha')
    await page.goForward()
    await expect(composerBox(page)).toHaveValue('draft for beta')
  })

  test("switching repo never shows the other repo's rows", async ({ page }) => {
    await twoRepos(page, {
      work: [workRow('wi_a', REPO_A.id, 'Alpha job'), workRow('wi_b', REPO_B.id, 'Beta job')],
    })
    let releaseAlpha: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      releaseAlpha = resolve
    })
    await page.route(`**/api/work?repoId=${REPO_A.id}`, async (route) => {
      await held
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([workRow('wi_a', REPO_A.id, 'Alpha job')]),
      })
    })
    await start(page, `repo/${REPO_A.id}/work`)
    await switchTo(page, 'beta')
    await expect(page.getByText('Beta job').first()).toBeVisible()
    releaseAlpha()
    await page.waitForTimeout(100)
    await expect(page.getByText('Alpha job')).toHaveCount(0)
    await expect(page.getByText('Beta job').first()).toBeVisible()
  })

  const followUp = async (page: Page) => {
    await page
      .locator('.task-list')
      .getByRole('button', { name: /Fix the login/ })
      .click()
    await page.keyboard.press('Escape')
    await expect(page.getByText('Following up')).toHaveCount(0)
    await page.getByRole('button', { name: 'Follow up on this work' }).click()
    await expect(page.getByText('Following up on Fix the login')).toBeVisible()
  }

  test('selecting work never changes the intent; following up is a choice', async ({ page }) => {
    await twoRepos(page, { work: [workRow('wi_a', REPO_A.id, 'Fix the login')] })
    await start(page)
    await expect(page.getByText('New request in alpha')).toBeVisible()
    await page.goto(`/?ui=next#repo/${REPO_A.id}/work`)
    await followUp(page)
  })

  test('Clear survives a refetch', async ({ page }) => {
    await twoRepos(page, { work: [workRow('wi_a', REPO_A.id, 'Fix the login')] })
    await start(page, `repo/${REPO_A.id}/work`)
    await followUp(page)
    await page.getByRole('button', { name: 'New request' }).click()
    await expect(page.getByText('New request in alpha')).toBeVisible()
    const read = page.waitForResponse((response) => response.url().includes('/api/work?repoId=repo_alpha'))
    await refetch(page)
    await read
    await expect(page.getByText('New request in alpha')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Follow up on Fix the login' })).toBeVisible()
  })

  test('reload restores address and intent', async ({ page }) => {
    await twoRepos(page, { work: [workRow('wi_a', REPO_A.id, 'Fix the login')] })
    await start(page, `repo/${REPO_A.id}/work/wi_a`)
    await expect(page.getByRole('button', { name: 'Follow up on this work' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('button', { name: 'Follow up on this work' })).toBeVisible()
    await page.getByRole('button', { name: 'Follow up on this work' }).click()
    await page.reload()
    await expect(page.getByText('Following up on Fix the login')).toBeVisible()
    await page.getByRole('button', { name: 'New request' }).click()
    await page.reload()
    await expect(page.getByText('New request in alpha')).toBeVisible()
    expect(new URL(page.url()).hash).toBe(`#repo/${REPO_A.id}/chat`)
  })

  test('read-only Unassigned', async ({ page }) => {
    await twoRepos(page, {
      messages: [{ id: 'm_old', text: 'An old message', createdAt: '' }],
    })
    await start(page)
    await page.getByRole('button', { name: 'Unassigned' }).click()
    await expect(page.getByText('An old message')).toBeVisible()
    await expect(composerBox(page)).toHaveAttribute('readonly', '')
    await expect(page.getByText('Unassigned history is read-only')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send' })).toHaveAttribute('aria-disabled', 'true')
  })

  test('reload on Unassigned keeps it, with no notice', async ({ page }) => {
    await twoRepos(page, {
      messages: [{ id: 'm_old', text: 'An old message', createdAt: '' }],
    })
    await start(page)
    await expect(page.getByText('New request in alpha')).toBeVisible()
    await page.getByRole('button', { name: 'Unassigned' }).click()
    await expect(page.getByText('An old message')).toBeVisible()
    await page.reload()
    await expect(page.getByText('An old message')).toBeVisible()
    await expect(page.getByText('Unassigned history, read-only')).toBeVisible()
    await expect(composerBox(page)).toHaveAttribute('readonly', '')
    await expect(page.getByText('Repository not found')).toHaveCount(0)
    expect(new URL(page.url()).hash).toBe('#repo/unassigned/chat')
    // Nothing was lost, so the stored repository is still the one a return lands on.
    await page.evaluate(() => {
      window.location.hash = 'chat'
    })
    await expect(page.getByText('New request in alpha')).toBeVisible()
    await expect(page.getByText('Repository not found')).toHaveCount(0)
  })

  test('reload on Unassigned with no repository, and slow reads, shows no notice', async ({ page }) => {
    await mockServer(page, { messages: [{ id: 'm_old', text: 'An old message', createdAt: '' }] })
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let scopedReads = 0
    await page.route('**/api/work?*', async (route) => {
      scopedReads += 1
      await held
      await route.fallback()
    })
    await start(page, 'repo/unassigned/chat')
    await expect.poll(() => scopedReads).toBeGreaterThan(0)
    await expect(page.locator('.shell')).toBeVisible()
    await expect(page.getByText('Repository not found')).toHaveCount(0)
    release()
    await expect(page.getByText('An old message')).toBeVisible()
    await expect(page.getByText('Repository not found')).toHaveCount(0)
    expect(new URL(page.url()).hash).toBe('#repo/unassigned/chat')
  })

  test('the retry banner says Retry ignores an edit', async ({ page }) => {
    await twoRepos(page)
    await start(page)
    await expect(page.getByText('New request in alpha')).toBeVisible()
    await page.route('**/api/chat/messages', (route) =>
      route.request().method() === 'POST' ? route.abort() : route.fallback(),
    )
    await composerBox(page).fill('Build it')
    await composerBox(page).press('Enter')
    await expect(page.getByRole('alert')).toContainText('Retry sends the original text')
  })

  test('no Unassigned entry without such rows', async ({ page }) => {
    await twoRepos(page)
    await start(page)
    await expect(page.getByText('New request in alpha')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Unassigned' })).toHaveCount(0)
  })

  test('a double Enter sends once', async ({ page }) => {
    const server = await twoRepos(page)
    await start(page)
    await expect(page.getByText('New request in alpha')).toBeVisible()
    await composerBox(page).fill('Build it')
    await composerBox(page).press('Enter')
    await composerBox(page).press('Enter')
    await expect(composerBox(page)).toHaveValue('')
    await expect(page.locator('.message-user')).toHaveCount(1)
    expect(server.posts).toHaveLength(1)
    expect(server.posts[0]?.body).toEqual({ text: 'Build it', repoId: REPO_A.id, intent: 'new' })
  })

  test('a failed send keeps the text, and Retry resends the same key', async ({ page }) => {
    const server = await twoRepos(page)
    await start(page)
    await expect(page.getByText('New request in alpha')).toBeVisible()
    let block = true
    await page.route('**/api/chat/messages', (route) => {
      if (route.request().method() === 'POST' && block) {
        block = false
        server.posts.push({
          key: route.request().headers()['x-idempotency-key'] ?? '',
          body: route.request().postDataJSON() as MockPost['body'],
        })
        return route.abort()
      }
      return route.fallback()
    })
    await composerBox(page).fill('Build it')
    await composerBox(page).press('Enter')
    await expect(page.getByRole('alert')).toContainText('may not have been sent')
    await expect(composerBox(page)).toHaveValue('Build it')
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(composerBox(page)).toHaveValue('')
    expect(server.posts).toHaveLength(2)
    expect(server.posts[1]?.key).toBe(server.posts[0]?.key)
    expect(server.messages).toHaveLength(1)
  })

  test('key-shaped text is never stored, and the composer says so', async ({ page }) => {
    await twoRepos(page)
    await start(page)
    await expect(page.getByText('New request in alpha')).toBeVisible()
    await composerBox(page).fill(`sk-ant-${'a'.repeat(40)}`)
    await expect(page.getByText('stays in this tab')).toBeVisible()
    const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))
    expect(stored).not.toContain('sk-ant')
  })

  test('a follow-up carries its reference and intent', async ({ page }) => {
    const server = await twoRepos(page, { work: [workRow('wi_a', REPO_A.id, 'Fix the login')] })
    await start(page, `repo/${REPO_A.id}/work`)
    await followUp(page)
    await composerBox(page).fill('And Safari')
    await composerBox(page).press('Enter')
    await expect(composerBox(page)).toHaveValue('')
    expect(server.posts[0]?.body).toEqual({
      text: 'And Safari',
      repoId: REPO_A.id,
      intent: 'follow_up',
      referencesWorkItem: 'wi_a',
    })
  })
})

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`${viewport.name} ${theme}`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } })
      test.beforeEach(({ page }) => setTheme(page, theme))

      const shot = (name: string) => `${name}-${viewport.name}-${theme}.png`

      test('live, no repository', async ({ page }) => {
        await live(page)
        await expectBounded(page)
        await expect(page).toHaveScreenshot(shot('live'))
      })

      test('conversation', async ({ page }) => {
        await harness(page, 'task=task_build&inspector=open')
        await page.keyboard.press('Escape')
        await expectBounded(page)
        const composer = await page.locator('.composer').boundingBox()
        expect(composer, 'composer on screen').not.toBeNull()
        expect((composer?.y ?? 0) + (composer?.height ?? 0)).toBeLessThanOrEqual(viewport.height)
        await expect(page).toHaveScreenshot(shot('conversation'))
      })

      test('inspector', async ({ page }) => {
        await harness(page, 'task=task_build&inspector=open')
        await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible()
        await expectBounded(page)
        expect(await sweep(page, viewport.width <= 760 ? 44 : 32)).toEqual([])
        await expect(page).toHaveScreenshot(shot('inspector'))
      })

      test('needs you', async ({ page }) => {
        await harness(page, '', 'needs')
        await expectBounded(page)
        await expect(page).toHaveScreenshot(shot('needs'))
      })

      test('states', async ({ page }) => {
        await harness(page, 'state=states')
        await expectBounded(page)
        await expect(page).toHaveScreenshot(shot('states'))
      })

      test('palette', async ({ page }) => {
        await harness(page)
        await page.getByRole('button', { name: 'Open commands' }).click()
        await expect(page.getByRole('combobox', { name: 'Search commands' })).toBeFocused()
        expect(await sweep(page, viewport.width <= 760 ? 44 : 32)).toEqual([])
        await expect(page).toHaveScreenshot(shot('palette'))
      })

      test('nothing under 12px, and every target meets its size', async ({ page }) => {
        await harness(page, 'state=blocked&task=task_build')
        const min = viewport.width <= 760 ? 44 : 32
        for (const hash of ['chat', 'needs']) {
          await page.evaluate((value) => {
            window.location.hash = value
          }, hash)
          await expect(page.locator('.page, .conversation').first()).toBeVisible()
          expect(await sweep(page, min)).toEqual([])
        }
      })
    })
  }
}

test.describe('drawer width', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  for (const theme of THEMES) {
    test(`drawer screenshot, ${theme}`, async ({ page }) => {
      await setTheme(page, theme)
      await harness(page)
      await openDrawer(page)
      await expect(page.getByRole('button', { name: 'Close navigation' })).toBeVisible()
      expect(await sweep(page, 44)).toEqual([])
      await expect(page).toHaveScreenshot(`drawer-390-${theme}.png`)
    })
  }

  test('2: the drawer opens as a real modal and closes every way', async ({ page }) => {
    await harness(page)
    const menu = page.getByRole('button', { name: 'Open navigation' })
    await expect(menu).toHaveAttribute('aria-expanded', 'false')

    await menu.click()
    await expect(menu).toHaveAttribute('aria-expanded', 'true')
    expect(await inertRoot(page)).toBe(true)
    await expect(page.locator('[role="dialog"]')).toHaveAttribute('aria-modal', 'true')
    await page.getByRole('button', { name: 'Close navigation' }).click()
    await expect(menu).toBeFocused()
    expect(await inertRoot(page)).toBe(false)

    await menu.click()
    await page.mouse.click(370, 400)
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    await expect(menu).toBeFocused()

    await menu.click()
    await page.keyboard.press('Escape')
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    await expect(menu).toBeFocused()
  })

  test('2: browser back closes the drawer', async ({ page }) => {
    await harness(page)
    await page.evaluate(() => {
      window.location.hash = 'work'
    })
    await expect(page.locator('.page h1')).toBeVisible()
    await openDrawer(page)
    await page.goBack()
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    expect(await inertRoot(page)).toBe(false)
  })

  test('2: navigation and a repository switch both close the drawer', async ({ page }) => {
    await harness(page)
    await openDrawer(page)
    await page.getByRole('button', { name: 'Work', exact: true }).click()
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused()

    await openDrawer(page)
    await page.getByRole('button', { name: /Switch repository/ }).click()
    await page.getByRole('button', { name: /very long name/ }).click()
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    expect(await focusIsOnBody(page)).toBe(false)
    expect(await inertRoot(page)).toBe(false)
  })

  test('3: the toolbar stays on one line with a long name, and commands have a touch route', async ({
    page,
  }) => {
    await harness(page)
    await openDrawer(page)
    await page.getByRole('button', { name: /Switch repository/ }).click()
    await page.getByRole('button', { name: /very long name/ }).click()
    const toolbar = await page.locator('.toolbar').boundingBox()
    expect(toolbar?.height).toBeLessThanOrEqual(56)
    const crumb = await page.locator('.breadcrumb').boundingBox()
    expect(crumb?.height).toBeLessThanOrEqual(24)
    const menu = await page.getByRole('button', { name: 'Open navigation' }).boundingBox()
    expect(menu?.width).toBe(44)
    await page.getByRole('button', { name: 'Open commands' }).click()
    await expect(page.getByRole('combobox', { name: 'Search commands' })).toBeVisible()
  })

  test('5: Ask about this work closes the sheet and lands on the composer', async ({ page }) => {
    await harness(page)
    await page.getByRole('button', { name: /Build the sample search/ }).click()
    await page.getByRole('button', { name: 'Ask about this work' }).click()
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Message the meta agent' })).toBeFocused()
  })

  test('6: resizing into the sheet keeps modal semantics', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await harness(page)
    await page.getByRole('button', { name: /Build the sample search/ }).click()
    await expect(page.locator('aside.inspector')).toBeVisible()
    expect(await inertRoot(page)).toBe(false)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toBeVisible()
    await expect(page.locator('aside.inspector')).toHaveCount(0)
    expect(await inertRoot(page)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    expect(await focusIsOnBody(page)).toBe(false)
  })

  test('8: the originating row stays selected behind the sheet', async ({ page }) => {
    await harness(page)
    const row = page.getByRole('button', { name: /Build the sample search/ })
    await row.click()
    await expect(page.locator('.task-row[aria-current="true"]')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(row).toBeFocused()
    await expect(row).toHaveAttribute('aria-current', 'true')
  })
})

test.describe('320 wide', () => {
  test.use({ viewport: { width: 320, height: 568 } })

  test('3: no page overflow, and a short screen keeps the composer reachable', async ({ page }) => {
    await harness(page, 'state=long')
    await expectBounded(page)
    const composer = await page.locator('.composer').boundingBox()
    expect((composer?.y ?? 0) + (composer?.height ?? 0)).toBeLessThanOrEqual(568)
    await page.getByRole('button', { name: 'Open commands' }).click()
    await page.keyboard.press('Escape')
    await live(page)
    await expectBounded(page)
  })
})

test.describe('1024 wide', () => {
  test.use({ viewport: { width: 1024, height: 768 } })

  test('5: Ask about this work closes the overlay here too', async ({ page }) => {
    await harness(page)
    await page.getByRole('button', { name: /Build the sample search/ }).click()
    await page.getByRole('button', { name: 'Ask about this work' }).click()
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Message the meta agent' })).toBeFocused()
  })

  test('6: the overlay inspector is a real modal with a working scrim', async ({ page }) => {
    await harness(page)
    await page.getByRole('button', { name: /Build the sample search/ }).click()
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(await inertRoot(page)).toBe(true)
    await page.mouse.click(100, 400)
    await expect(dialog).toHaveCount(0)
    expect(await inertRoot(page)).toBe(false)
    await expect(page.getByRole('button', { name: /Build the sample search/ })).toBeFocused()
  })

  test('6: script and layout agree at the boundary', async ({ page }) => {
    await harness(page)
    await page.getByRole('button', { name: /Build the sample search/ }).click()
    await page.setViewportSize({ width: 1150, height: 768 })
    await expect(page.locator('aside.inspector')).toBeVisible()
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    await page.setViewportSize({ width: 1149, height: 768 })
    await expect(page.locator('[role="dialog"]')).toBeVisible()
    await expect(page.locator('aside.inspector')).toHaveCount(0)
  })
})

test.describe('the shell', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('1: one scroller, with the toolbar and composer held in place', async ({ page }) => {
    await harness(page, 'state=long')
    await expectBounded(page)
    const scroller = page.locator('.scroller')
    expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
    expect((await page.locator('.toolbar').boundingBox())?.y).toBe(0)
    const composer = await page.locator('.composer').boundingBox()
    expect((composer?.y ?? 0) + (composer?.height ?? 0)).toBeLessThanOrEqual(900)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  })

  test('header, message text, plan and composer share a left edge', async ({ page }) => {
    await harness(page)
    const lefts = await page.evaluate(() =>
      ['.page-header', '.message-agent', '.delivery', '.composer'].map(
        (selector) => document.querySelector(selector)?.getBoundingClientRect().left,
      ),
    )
    expect(new Set(lefts).size).toBe(1)
  })

  test('216 rail, 336 inspector', async ({ page }) => {
    await harness(page, 'task=task_build&inspector=open')
    expect((await page.locator('.rail').boundingBox())?.width).toBe(216)
    expect((await page.locator('.inspector').boundingBox())?.width).toBe(336)
  })

  test('4: slash inside a modal neither moves focus nor navigates', async ({ page }) => {
    await harness(page)
    await page.getByRole('button', { name: /Repository: Sample console/ }).click()
    const url = page.url()
    await page.keyboard.press('/')
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Message the meta agent' })).not.toBeFocused()
    expect(page.url()).toBe(url)
    await expect(page.getByRole('dialog').locator(':focus')).toHaveCount(1)
  })

  test('slash focuses the composer when nothing is in the way', async ({ page }) => {
    await harness(page)
    await page.keyboard.press('/')
    await expect(page.getByRole('textbox', { name: 'Message the meta agent' })).toBeFocused()
  })

  test('every overlay has a scrim, an inert page, a trapped Tab and focus return', async ({ page }) => {
    await harness(page)
    const repository = page.getByRole('button', { name: /Repository: Sample console/ })
    const commands = page.getByRole('button', { name: 'Open commands' })
    for (const opener of [repository, commands]) {
      await opener.click()
      await expect(page.locator('[data-scrim]')).toBeVisible()
      expect(await inertRoot(page)).toBe(true)
      for (let press = 0; press < 12; press += 1) {
        await page.keyboard.press('Tab')
        const inside = await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)
        expect(inside, `Tab ${press}`).toBe(true)
      }
      await page.mouse.click(1400, 880)
      await expect(page.locator('[role="dialog"]')).toHaveCount(0)
      await expect(opener).toBeFocused()
      expect(await inertRoot(page)).toBe(false)
    }
  })

  test('Escape closes the top surface only', async ({ page }) => {
    await harness(page, 'task=task_build&inspector=open')
    await expect(page.locator('aside.inspector')).toBeVisible()
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('combobox')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('combobox')).toHaveCount(0)
    await expect(page.locator('aside.inspector')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('aside.inspector')).toHaveCount(0)
  })

  test('14: with nothing focused, closing the palette does not strand focus on the body', async ({
    page,
  }) => {
    await harness(page)
    expect(await focusIsOnBody(page)).toBe(true)
    await page.keyboard.press('Control+k')
    await page.keyboard.press('Escape')
    await expect(page.locator('.scroller')).toBeFocused()
  })

  test('an inspector already open on load does not take focus', async ({ page }) => {
    await harness(page, 'task=task_build&inspector=open')
    await expect(page.locator('aside.inspector')).toBeVisible()
    expect(await focusIsOnBody(page)).toBe(true)
  })

  test('14: Cmd+K twice then Escape leaves focus on the opener', async ({ page }) => {
    await harness(page)
    const row = page.getByRole('button', { name: /Run the sample checks/ })
    await row.focus()
    await page.keyboard.press('Control+k')
    await page.keyboard.press('Control+k')
    await expect(row).toBeFocused()
    await page.keyboard.press('Control+k')
    await page.keyboard.press('Escape')
    await expect(row).toBeFocused()
  })

  test('6: the wide inspector is not a dialog and leaves the page live', async ({ page }) => {
    await harness(page, 'task=task_build&inspector=open')
    await expect(page.locator('aside.inspector')).toBeVisible()
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    expect(await inertRoot(page)).toBe(false)
  })

  test('7, 8: each row opens its own task, and an unrun task does not claim checks', async ({ page }) => {
    await harness(page)
    const details = page.locator('aside.inspector')
    await page.getByRole('button', { name: /Run the sample checks/ }).click()
    await expect(details.getByRole('heading', { level: 2 })).toHaveText('Run the sample checks')
    await details.getByRole('tab', { name: 'Checks' }).click()
    await expect(details.getByText('Checks have not run yet')).toBeVisible()

    await page.getByRole('button', { name: /Understand the sample code/ }).click()
    await expect(details.getByRole('heading', { level: 2 })).toHaveText('Understand the sample code')
    await expect(details.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.task-row[aria-current="true"]')).toContainText('Understand the sample code')
  })

  test('7: the empty state has no inspector to open', async ({ page }) => {
    await harness(page, 'state=empty')
    await expect(page.getByRole('button', { name: 'Open details' })).toHaveCount(0)
  })

  test('12: a count of zero shows no amber chip', async ({ page }) => {
    await harness(page, 'state=empty')
    await expect(page.locator('.count')).toHaveCount(0)
  })

  test('inspector leaves Settings alone and comes back for its route', async ({ page }) => {
    await harness(page, 'task=task_build&inspector=open')
    await expect(page.locator('aside.inspector')).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.locator('aside.inspector')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /details/i })).toHaveCount(0)
    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect(page.locator('aside.inspector')).toBeVisible()
  })

  test('7, 9: Needs you opens approval evidence, never the running task', async ({ page }) => {
    await harness(page, 'task=task_build&inspector=open', 'needs')
    await expect(page.locator('aside.inspector')).toHaveCount(0)
    await page.getByRole('button', { name: 'Inspect checks and changes' }).click()
    const details = page.locator('aside.inspector')
    await expect(details.getByRole('heading', { level: 2 })).toHaveText('Push the tested sample branch')
    await expect(details.getByRole('tab', { name: 'Checks' })).toHaveAttribute('aria-selected', 'true')
    await expect(details.getByText('Checks have not run yet')).toHaveCount(0)
  })

  test('15: the composer shows a 2px ring while its field has focus', async ({ page }) => {
    await harness(page)
    await page.getByRole('textbox', { name: 'Message the meta agent' }).focus()
    const ring = await page.locator('.composer').evaluate((el) => {
      const style = getComputedStyle(el)
      return { width: style.outlineWidth, style: style.outlineStyle }
    })
    expect(ring).toEqual({ width: '2px', style: 'solid' })
  })

  test('20: the palette filters, and a theme command closes it and updates the label', async ({ page }) => {
    await harness(page)
    await page.getByRole('button', { name: 'Open commands' }).click()
    await page.keyboard.type('dark')
    await expect(page.getByRole('option')).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByRole('button', { name: /^Theme: Dark/ })).toBeVisible()
    expect(await focusIsOnBody(page)).toBe(false)

    await page.getByRole('button', { name: 'Open commands' }).click()
    await page.keyboard.type('zzz')
    await expect(page.getByText('No matching commands')).toBeVisible()
  })

  test('21: navigation exposes aria-current and moves focus to the heading', async ({ page }) => {
    await harness(page)
    const work = page.getByRole('button', { name: 'Work', exact: true })
    await expect(work).not.toHaveAttribute('aria-current', 'page')
    await work.click()
    await expect(work).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
  })

  test('21: the tabpanel is labelled by its tab, and arrows move between tabs', async ({ page }) => {
    await harness(page, 'task=task_build&inspector=open')
    const overview = page.getByRole('tab', { name: 'Overview' })
    await overview.focus()
    await page.keyboard.press('ArrowRight')
    const checks = page.getByRole('tab', { name: 'Checks' })
    await expect(checks).toBeFocused()
    await expect(page.getByRole('tabpanel', { name: 'Checks' })).toBeVisible()
    await expect(checks).toHaveAttribute('aria-selected', 'true')
  })

  test('21: Auto follows the system, an explicit choice does not', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await harness(page)
    const canvas = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(await canvas()).toBe('rgb(23, 26, 32)')
    await page.emulateMedia({ colorScheme: 'light' })
    expect(await canvas()).toBe('rgb(247, 248, 250)')
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.getByRole('button', { name: /^Theme: Auto/ }).click()
    expect(await canvas()).toBe('rgb(247, 248, 250)')
  })

  test('21: Enter that commits an IME candidate does not send', async ({ page }) => {
    await harness(page)
    const box = page.getByRole('textbox', { name: 'Message the meta agent' })
    await box.fill('sample words')
    await box.evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
    })
    await expect(page.getByTestId('sent')).toHaveText('Sent: 0')
    await expect(box).toHaveValue('sample words')
    await box.press('Enter')
    await expect(page.getByTestId('sent')).toHaveText('Sent: 1')
    await expect(box).toHaveValue('')
    await box.press('Enter')
    await expect(page.getByTestId('sent')).toHaveText('Sent: 1')
  })

  test('drafts stay with their repository', async ({ page }) => {
    await harness(page)
    const box = page.getByRole('textbox', { name: 'Message the meta agent' })
    await box.fill('kept in the first one')
    await page.getByRole('button', { name: /Repository: Sample console/ }).click()
    await page.getByRole('button', { name: /very long name/ }).click()
    await expect(box).toHaveValue('')
    await page.getByRole('button', { name: /Repository: A sample/ }).click()
    await page
      .getByRole('button', { name: /Sample console/ })
      .last()
      .click()
    await expect(box).toHaveValue('kept in the first one')
  })

  test('reduced motion removes transitions', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await harness(page)
    const duration = await page
      .getByRole('button', { name: 'Follow up' })
      .evaluate((el) => getComputedStyle(el).transitionDuration)
    expect(duration).toBe('0s')
  })

  test('the skip link reaches the scroller', async ({ page }) => {
    await harness(page)
    await page.keyboard.press('Tab')
    const skip = page.getByRole('button', { name: 'Skip to content' })
    await expect(skip).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('.scroller')).toBeFocused()
  })
})

test.describe('the two-step approval', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  const approve = (page: Page) => page.getByRole('button', { name: 'Approve push' })
  const confirm = (page: Page) => page.getByRole('button', { name: 'Confirm: push sample branch' })
  const announced = (page: Page) => page.locator('.decision').first().getByRole('status')

  test('first click arms and announces, second confirms, focus stays on the card', async ({ page }) => {
    await harness(page, '', 'needs')
    await approve(page).first().click()
    await expect(confirm(page)).toBeFocused()
    await expect(announced(page)).toContainText('Confirm: push sample branch')
    await confirm(page).click()
    await expect(page.locator('.decision').first()).toHaveAttribute('data-state', 'resolved')
    await expect(page.locator('.decision').first().getByRole('heading', { level: 2 })).toBeFocused()
  })

  test('12: amber leaves a settled decision', async ({ page }) => {
    await harness(page, '', 'needs')
    await expect(page.locator('.decision[data-state="resolved"] .attention-label')).toHaveCount(0)
    await expect(page.locator('.decision[data-state="expired"] .attention-label')).toHaveCount(0)
  })

  test('13: an expired decision is shown and offers no action', async ({ page }) => {
    await harness(page, '', 'needs')
    const expired = page.locator('.decision[data-state="expired"]')
    await expect(expired).toContainText('Expired')
    await expect(expired.getByRole('button')).toHaveCount(0)
  })

  test('14: Escape disarms and focus stays', async ({ page }) => {
    await harness(page, '', 'needs')
    await approve(page).first().click()
    await page.keyboard.press('Escape')
    await expect(approve(page).first()).toBeFocused()
    await expect(announced(page)).toHaveText('')
  })

  test('14: eight seconds disarm and focus stays', async ({ page }) => {
    await page.clock.install()
    await harness(page, '', 'needs')
    await approve(page).first().click()
    await expect(confirm(page)).toBeVisible()
    await page.clock.runFor(7900)
    await expect(confirm(page)).toBeVisible()
    await page.clock.runFor(200)
    await expect(approve(page).first()).toBeFocused()
  })

  test('an unrelated click disarms', async ({ page }) => {
    await harness(page, '', 'needs')
    await approve(page).first().click()
    await page.getByRole('heading', { name: 'Needs you' }).click()
    await expect(approve(page).first()).toBeVisible()
    await expect(confirm(page)).toHaveCount(0)
  })

  test('moving focus away disarms', async ({ page }) => {
    await harness(page, '', 'needs')
    await approve(page).first().click()
    await page.keyboard.press('Tab')
    await expect(confirm(page)).toHaveCount(0)
  })

  test('navigating away disarms', async ({ page }) => {
    await harness(page, '', 'needs')
    await approve(page).first().click()
    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    await page.getByRole('button', { name: /^Needs you/ }).click()
    await expect(confirm(page)).toHaveCount(0)
  })

  test('a question has real choices and a free-text target', async ({ page }) => {
    await harness(page, '', 'needs')
    const question = page.locator('.decision').nth(1)
    const send = question.getByRole('button', { name: 'Send answer' })
    await expect(send).toHaveAttribute('aria-disabled', 'true')
    await question.getByRole('radio', { name: 'Leave sample archives out' }).check()
    await send.click()
    await expect(question).toHaveAttribute('data-state', 'resolved')
    await expect(question.getByRole('heading', { level: 2 })).toBeFocused()
  })
})
