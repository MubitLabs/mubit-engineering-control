import { expect, type Page, test } from '@playwright/test'
import { journeyMode } from './journey-gate'
import { askTurn, planTurn, type Rig, startRig } from './journey-rig'

/**
 * The composed journey (CHANGE.md "Final assembled outcome"), on a server built from this tree,
 * with no mocked routes: scratch repository, `file://` bare behind a github.com `origin`, fake `gh`.
 *
 * Fake mode, the default, is `MEC_REAL_RUNNER=1` with a fake `claude` first on PATH. It is not
 * `MEC_FAKE_ENGINE=1`: with that flag there is no launcher, so there is no delivery and no card.
 *
 * `MEC_JOURNEY_REAL=1` runs the first test alone, on the real planner and a real specialist through
 * a linked slot. One bounded request: a line in engine-runs.md first. See docs/changes/2026-11-06-journey-tests.
 */
const mode = journeyMode(process.env)
const ONE_REAL_PASS = 'one real pass is the budget (decision #18)'

let rig: Rig
test.beforeEach(async () => {
  rig = await startRig(mode)
})
test.afterEach(async () => {
  await rig.dispose()
})

const REQUEST = 'Add a file named hello.txt that contains the word hello, and nothing else.'
/** A poll's bound: a fresh script's first exec has taken 25 s on this machine (M2.2's record). */
const SLOW = mode === 'real' ? 300_000 : 90_000
/** Longer than the server's two-second pass, so anything queued would have started. */
const SEVERAL_PASSES = 6_000
/** With holds off, work moved 6.9 s after a SIGKILL restart: this has to outlast that. */
const AFTER_A_CRASH = 15_000
const QUIET_TIME = { timeout: SLOW }

interface WorkDetail {
  delivery?: { stage?: string }
  stage?: { label?: string }
  tasks?: { items?: { status?: string }[] } | { status?: string }[]
}
const workId = async (): Promise<string> => {
  const rows = await rig.api<{ id: string }[]>('/api/work')
  const id = rows[0]?.id
  if (id === undefined) throw new Error('no work yet')
  return id
}
const detail = async (): Promise<WorkDetail> => rig.api<WorkDetail>(`/api/inspect/work/${await workId()}`)
const deliveryStage = async (): Promise<string | undefined> => {
  try {
    return (await detail()).delivery?.stage
  } catch {
    return undefined
  }
}
const pending = (): Promise<{ id: string; cls: string }[]> =>
  rig.api<{ id: string; cls: string }[]>('/api/inbox')
const pendingClasses = async (): Promise<string[]> => (await pending()).map((card) => card.cls)
const branchOf = async (): Promise<string> => `mec/${(await workId()).slice(3, 11)}/integration`

/** The pending cards, once a real planner's own question, if it asked one, has an answer. */
async function answerAnyThenCards(): Promise<string[]> {
  const questions = await rig.api<{ id: string; status: string }[]>('/api/questions')
  for (const { id, status } of questions) {
    if (status === 'open') await rig.api(`/api/questions/${id}/answer`, { answer: 'Your call: go ahead.' })
  }
  return pendingClasses()
}

async function ask(page: Page): Promise<void> {
  await page.goto(`${rig.url}/?ui=next#chat`)
  await page
    .locator('.choices')
    .getByRole('button', { name: /scratch/ })
    .click()
  await expect(page.getByText('New request in scratch')).toBeVisible()
  await page.getByRole('textbox', { name: 'Message the meta agent' }).fill(REQUEST)
  await page.getByRole('button', { name: 'Send' }).click()
}

const open = (page: Page, name: 'Conversation' | 'Work' | 'Needs you') =>
  page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name }).click()

/** Both steps of the two-step approve, on the one card whose heading matches. */
async function approve(page: Page, title: RegExp): Promise<void> {
  const card = page.locator('article.decision', { has: page.getByRole('heading', { name: title }) })
  await card.getByRole('button', { name: 'Approve' }).click({ timeout: SLOW })
  await card.getByRole('button', { name: /^Confirm: / }).click()
}

const PUSH = /^Push mec\//
const CHAIN = [
  { id: 'first', objective: 'Do the first part.' },
  { id: 'second', objective: 'Do the second part.', depends_on: ['first'] },
]

/** A worker that outlasts a click, then leaves a file. */
const slowWorker = (ms: number) => [
  { init: true },
  { sleep: ms },
  { sh: 'echo made > "$MEC_ATTEMPT_ID.txt"' },
  { result: 'completed' },
]

test('one request reaches a tested PR on the scratch lane', async ({ page }) => {
  rig.plannerTurns(
    askTurn('Should the file end with a newline?', ['Yes', 'No']),
    planTurn([{ id: 'hello', objective: REQUEST }]),
  )
  await ask(page)

  // A real planner asks only if it needs to, so only the scripted one must.
  if (mode === 'fake') {
    await expect(page.getByText('Should the file end with a newline?').first()).toBeVisible(QUIET_TIME)
    await open(page, 'Needs you')
    await page.getByRole('radio', { name: 'Yes' }).check()
    await page.getByRole('button', { name: 'Send answer' }).click()
    await open(page, 'Conversation')
  }

  await expect(page.locator('article.delivery .task-row').first()).toBeVisible(QUIET_TIME)
  await expect.poll(answerAnyThenCards, QUIET_TIME).toEqual(['push'])

  // The plan and the task, as the owner inspects them.
  await open(page, 'Work')
  await page.locator('.work-row').first().click()
  await page.locator('.task-row').first().click()
  await expect(page.getByText('Actual model')).toBeVisible()
  await expect(page.getByText('Integrated').first()).toBeVisible()
  await page.keyboard.press('Escape')

  await open(page, 'Needs you')
  const branch = await branchOf()
  expect(rig.remoteHead(branch)).toBeUndefined()
  await approve(page, PUSH)
  await expect.poll(() => rig.remoteHead(branch), QUIET_TIME).toBeDefined()
  await expect.poll(pendingClasses, QUIET_TIME).toEqual(['pr_create'])
  expect(rig.ghLog().filter((line) => line.startsWith('pr create'))).toEqual([])

  await approve(page, /pull request/i)
  await expect.poll(deliveryStage, QUIET_TIME).toBe('pr-ready')
  expect(rig.ghLog().filter((line) => line.startsWith('pr create'))).toHaveLength(1)
  // Merge is a separate card, and the default delivery never reaches it.
  expect(rig.ghLog().filter((line) => line.startsWith('pr merge'))).toEqual([])
  expect(await pendingClasses()).toEqual([])

  const files = rig.remoteFiles(branch)
  expect(files.filter((file) => file.startsWith('.mec'))).toEqual([])
  if (mode === 'fake') expect(files.some((file) => /^att_.*\.txt$/.test(file))).toBe(true)
  else expect(files).toContain('hello.txt')

  await open(page, 'Work')
  await page.locator('.work-row').first().click()
  await expect(page.getByText('Pull request ready for review')).toBeVisible()
})

test('a delivery ready for review says so on its Work row', async ({ page }) => {
  test.skip(mode === 'real', ONE_REAL_PASS)
  // Known gap, spec §10's stage table: the row reads Working, because `stageOf` only looks at a
  // worker's `ready` report and never at the delivery. Remove this line when that is fixed.
  test.fail()
  rig.plannerTurns(planTurn([{ id: 'hello', objective: REQUEST }]))
  await ask(page)
  await open(page, 'Needs you')
  await approve(page, PUSH)
  await approve(page, /pull request/i)
  await expect.poll(deliveryStage, QUIET_TIME).toBe('pr-ready')
  await open(page, 'Work')
  await expect(page.locator('.work-row').first()).toContainText('Ready for review')
})

test('declining keeps the local result', async ({ page }) => {
  test.skip(mode === 'real', ONE_REAL_PASS)
  rig.plannerTurns(planTurn([{ id: 'hello', objective: REQUEST }]))
  await ask(page)
  await expect.poll(pendingClasses, QUIET_TIME).toEqual(['push'])
  const branch = await branchOf()
  const local = rig.cacheHead(branch)
  expect(local).toBeDefined()

  await open(page, 'Needs you')
  await page.getByRole('button', { name: 'Deny' }).click({ timeout: SLOW })
  await expect(page.getByRole('heading', { name: 'Settled' })).toBeVisible(QUIET_TIME)
  await expect.poll(pendingClasses, QUIET_TIME).toEqual([])
  await page.waitForTimeout(SEVERAL_PASSES)

  expect(await pendingClasses()).toEqual([])
  expect(rig.remoteHead(branch)).toBeUndefined()
  expect(rig.ghLog().filter((line) => line.startsWith('pr create'))).toEqual([])
  expect(await deliveryStage()).toBe('local-complete')
  expect(rig.cacheHead(branch)).toBe(local)
})

test('hold survives restart', async ({ page }) => {
  test.skip(mode === 'real', ONE_REAL_PASS)
  rig.plannerTurns(planTurn(CHAIN))
  rig.workerSteps(slowWorker(5_000))
  await ask(page)
  await expect.poll(() => rig.launched().length, QUIET_TIME).toBe(1)

  await open(page, 'Work')
  await page.locator('.work-row').first().click()
  await page.getByRole('button', { name: /^Hold/ }).click()
  await expect(page.getByRole('button', { name: /^Lift hold/ })).toBeVisible(QUIET_TIME)

  // The first task runs out and is accepted; the hold keeps its integration and the second back.
  await expect.poll(taskStatuses, QUIET_TIME).toEqual(['accepted', 'ready'])
  await page.waitForTimeout(SEVERAL_PASSES)
  expect(await taskStatuses()).toEqual(['accepted', 'ready'])
  expect(rig.launched()).toHaveLength(1)

  await rig.restart('SIGKILL')
  await page.goto(`${rig.url}/?ui=next#repo/${rig.repoId}/work`)
  await page.locator('.work-row').first().click()
  await expect(page.getByRole('button', { name: /^Lift hold/ })).toBeVisible(QUIET_TIME)
  await page.waitForTimeout(AFTER_A_CRASH)
  expect(rig.launched()).toHaveLength(1)
  expect(await pendingClasses()).toEqual([])

  await page.getByRole('button', { name: /^Lift hold/ }).click()
  await expect.poll(() => rig.launched().length, QUIET_TIME).toBe(2)
  await expect.poll(pendingClasses, QUIET_TIME).toEqual(['push'])
})

test('stop launches nothing later', async ({ page }) => {
  test.skip(mode === 'real', ONE_REAL_PASS)
  rig.plannerTurns(planTurn(CHAIN))
  rig.workerSteps(slowWorker(60_000))
  await ask(page)
  await expect.poll(() => rig.launched().length, QUIET_TIME).toBe(1)

  await open(page, 'Work')
  await page.locator('.work-row').first().click()
  // Opens the confirm, arms it, confirms.
  await page.getByRole('button', { name: /^Stop/ }).click()
  await page.getByRole('button', { name: /^Stop/ }).click()
  await page.getByRole('button', { name: /^Confirm: stop/ }).click()
  await expect(page.locator('.work-row').first()).toContainText(/stopped/i, QUIET_TIME)

  await page.waitForTimeout(SEVERAL_PASSES)
  expect(rig.launched()).toHaveLength(1)
  expect(await pendingClasses()).toEqual([])
  expect(rig.ghLog().filter((line) => line.includes('push'))).toEqual([])
})

test('an approve made offline is not spent', async ({ page, context }) => {
  test.skip(mode === 'real', ONE_REAL_PASS)
  rig.plannerTurns(planTurn([{ id: 'hello', objective: REQUEST }]))
  await ask(page)
  await expect.poll(pendingClasses, QUIET_TIME).toEqual(['push'])
  const branch = await branchOf()
  await open(page, 'Needs you')
  await page.getByRole('button', { name: 'Approve' }).waitFor(QUIET_TIME)

  await context.setOffline(true)
  await approve(page, PUSH)
  await expect(page.getByText(/may not have reached the workbench/).first()).toBeVisible(QUIET_TIME)
  expect(await pendingClasses()).toEqual(['push'])
  expect(rig.remoteHead(branch)).toBeUndefined()

  await context.setOffline(false)
  await page.reload()
  await approve(page, PUSH)
  await expect.poll(() => rig.remoteHead(branch), QUIET_TIME).toBeDefined()
})

async function taskStatuses(): Promise<(string | undefined)[]> {
  const { tasks } = await detail()
  const rows = Array.isArray(tasks) ? tasks : (tasks?.items ?? [])
  return rows.map((task) => task.status).sort()
}
