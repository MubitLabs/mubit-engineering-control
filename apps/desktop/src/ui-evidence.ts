/**
 * The capture service (spec §15): where a repository requires UI evidence, every task the
 * scheduler's acceptance holds back for screenshots gets them, taken by MEC and stored under its
 * data dir, `ui-evidence/<work>/<attempt>/<side>-<n>.png`, never in a worktree, so no capture can
 * reach a task commit (the `.mec/` exclusion in `commitAll` stays as it is). The record is
 * `ui-evidence/<attempt>`: `before` at the task's base, `after` at the reported head, the same paths
 * and viewport for both. A pass after the record is written lets acceptance decide.
 *
 * The routes read the record: the list for the work view, and a PNG only by a file name the record
 * holds, so a request can never name a path of its own.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Json, Store, StoreDoc } from '@mec/contracts'
import { UI_VIEWPORT, uiEvidenceSetting } from '@mec/domain'
import {
  capturesOf,
  evidenceDocId,
  hostRunAgreed,
  isHeld,
  isTerminal,
  mandateOf,
  processingOf,
  screenshotsDue,
} from '@mec/meta'
import { buildAgentEnv } from '@mec/runtime'
import { redact } from '@mec/slots'
import type { FastifyInstance } from 'fastify'
import { repoInherited } from './attempt-launch'
import { type BrowserLike, captureRevision } from './ui-capture'

export type UiEvidenceDeps = {
  store: Store
  dataDir: string
  now?: () => Date
  launch?: () => Promise<BrowserLike>
  startWaitMs?: number
}

/** Where a work item's captures live. */
export const capturesDir = (dataDir: string, workItemId: string, attemptId: string): string =>
  join(dataDir, 'ui-evidence', workItemId, attemptId)

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/
const SAFE_FILE = /^(before|after)-\d{1,2}\.png$/

export class UiEvidence {
  readonly #deps: UiEvidenceDeps
  readonly #closing = new AbortController()
  /** Attempts this process is capturing now; a `taking` record of none of these was cut short. */
  readonly #inFlight = new Set<string>()
  #running: Promise<void> = Promise.resolve()
  #queued = false

  constructor(deps: UiEvidenceDeps) {
    this.#deps = deps
  }

  get #now(): string {
    return (this.#deps.now ?? (() => new Date()))().toISOString()
  }

  /** Runs a pass after any in flight, and at most one more. */
  kick(): void {
    if (this.#queued) return
    this.#queued = true
    this.#running = this.#running.then(async () => {
      this.#queued = false
      await this.#pass().catch((error) => console.error(`[ui-evidence] pass failed: ${String(error)}`))
    })
  }

  async pass(): Promise<void> {
    this.#running = this.#running.then(() => this.#pass())
    await this.#running
  }

  async close(): Promise<void> {
    this.#closing.abort()
    await this.#running
  }

  async #pass(): Promise<void> {
    const { store } = this.#deps
    if (processingOf(store).paused) return
    for (const work of store.workItems.list()) {
      if (this.#closing.signal.aborted) return
      if (isTerminal(work) || isHeld(work) || mandateOf(work).status === 'withdrawn') continue
      if (typeof work.repoId !== 'string' || typeof work.git_dir !== 'string') continue
      const repo = store.engines.get(work.repoId)
      if (!uiEvidenceSetting(repo?.uiEvidence).required) continue
      for (const due of screenshotsDue(store, String(work.id))) {
        if (due.state !== 'waiting') continue
        const id = String(due.attempt.id)
        const doc = store.engines.get(evidenceDocId(id))
        const cutShort = doc?.state === 'taking' && !this.#inFlight.has(id)
        if (doc !== undefined && doc.state !== 'requested' && !cutShort) continue
        await this.#capture(work, repo as StoreDoc, due.task, due.attempt)
      }
    }
  }

  async #capture(work: StoreDoc, repo: StoreDoc, task: StoreDoc, attempt: StoreDoc): Promise<void> {
    const { store, dataDir } = this.#deps
    const workItemId = String(work.id)
    const attemptId = String(attempt.id)
    const setting = uiEvidenceSetting(repo.uiEvidence)
    const base = { id: evidenceDocId(attemptId), attemptId, taskId: String(task.id), workItemId }
    const outDir = capturesDir(dataDir, workItemId, attemptId)
    const tmpDir = join(dataDir, 'tmp', `ui-evidence-${attemptId}`)
    const fields = {
      ...base,
      repoId: String(work.repoId),
      viewport: { ...UI_VIEWPORT },
      paths: [...setting.paths],
      ...(setting.start !== undefined && { start: setting.start as unknown as Json }),
    }
    this.#inFlight.add(attemptId)
    try {
      store.atomic(() =>
        store.engines.save({ ...fields, state: 'taking', startedAt: this.#now, updatedAt: this.#now }),
      )
      rmSync(outDir, { recursive: true, force: true })
      const common = {
        gitDir: String(work.git_dir),
        setting,
        outDir,
        tmpDir,
        bootstrap: Array.isArray(repo.bootstrap) ? repo.bootstrap.map(String) : [],
        env: buildAgentEnv({
          inherited: repoInherited(),
          home: tmpDir,
          attempt: { TMPDIR: tmpDir, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
        }),
        hostRunAgreed: hostRunAgreed(store, String(work.repoId)),
        signal: this.#closing.signal,
        now: () => this.#now,
        ...(this.#deps.launch !== undefined && { launch: this.#deps.launch }),
        ...(this.#deps.startWaitMs !== undefined && { startWaitMs: this.#deps.startWaitMs }),
      }
      const before = await captureRevision({ ...common, side: 'before', sha: String(attempt.base_sha) })
      const after = await captureRevision({ ...common, side: 'after', sha: String(attempt.head_sha) })
      // A close voids the pass: the next start finds the record cut short and takes them again.
      if (this.#closing.signal.aborted) return
      const clean = (side: typeof before) =>
        side.status === 'could_not'
          ? { ...side, reason: redact(side.reason, this.#fingerprints(), []) }
          : side
      const taken = before.status === 'captured' && after.status === 'captured'
      store.atomic(() =>
        store.engines.save({
          ...fields,
          state: taken ? 'taken' : 'could_not',
          before: clean(before) as unknown as Json,
          after: clean(after) as unknown as Json,
          takenAt: this.#now,
          updatedAt: this.#now,
        }),
      )
    } finally {
      this.#inFlight.delete(attemptId)
    }
  }

  #fingerprints(): Parameters<typeof redact>[1] {
    return this.#deps.store.slots
      .list()
      .flatMap((slot) => (slot.fingerprint === undefined ? [] : [slot.fingerprint])) as never
  }
}

/** One side as the work view shows it: the commit, and each image by its route. */
export type ScreenshotSideView = {
  sha: string
  short: string
  status: 'captured' | 'could_not'
  reason: string | null
  shots: { path: string; url: string; at: string; status: number | null }[]
}
export type ScreenshotsView = {
  taskId: string
  attemptId: string
  state: string
  viewport: { width: number; height: number } | null
  before: ScreenshotSideView | null
  after: ScreenshotSideView | null
}

/** The captures of a work item, newest attempt last, each image by a route that reads the record. */
export function screenshotsOf(store: Store, workItemId: string): ScreenshotsView[] {
  const docs = store.engines
    .list({ workItemId })
    .filter((doc) => String(doc.id).startsWith('ui-evidence/'))
    .sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')))
  return docs.map((doc) => {
    const attemptId = String(doc.attemptId)
    const { before, after } = capturesOf(doc)
    const side = (raw: typeof before): ScreenshotSideView | null =>
      raw === undefined
        ? null
        : {
            sha: raw.sha,
            short: raw.sha.slice(0, 7),
            status: raw.status,
            reason: raw.status === 'could_not' ? raw.reason : null,
            shots:
              raw.status === 'captured'
                ? raw.shots.map((shot) => ({
                    path: shot.path,
                    url: `/api/work/${encodeURIComponent(workItemId)}/screenshots/${encodeURIComponent(attemptId)}/${encodeURIComponent(shot.file)}`,
                    at: shot.at,
                    status: shot.status,
                  }))
                : [],
          }
    const viewport = doc.viewport as { width?: unknown; height?: unknown } | undefined
    return {
      taskId: String(doc.taskId),
      attemptId,
      state: String(doc.state),
      viewport:
        typeof viewport?.width === 'number' && typeof viewport.height === 'number'
          ? { width: viewport.width, height: viewport.height }
          : null,
      before: side(before),
      after: side(after),
    }
  })
}

/**
 * The PR body's lines (§14, §15): each accepted task's screenshots by revision, in words. The images
 * stay on this machine; nothing is uploaded to GitHub.
 */
export function prEvidenceLines(store: Store, workItemId: string): string[] {
  const tasks = new Map(store.tasks.list({ workItemId }).map((task) => [String(task.id), task]))
  return screenshotsOf(store, workItemId).flatMap((item) => {
    const task = tasks.get(item.taskId)
    const { before, after } = item
    if (item.state !== 'taken' || before === null || after === null) return []
    if (task === undefined || task.acceptedHead !== after.sha) return []
    const paths = after.shots.map((shot) => shot.path).join(', ')
    const size = item.viewport === null ? '' : ` at ${item.viewport.width}x${item.viewport.height}`
    const name = String(task.localKey ?? task.id)
    return [
      `${name}: before \`${before.short}\` and after \`${after.short}\` of ${paths}${size}, taken by MEC in Chromium from the real application. The images are kept on the machine that ran the work.`,
    ]
  })
}

/** `GET /api/work/:id/screenshots` and one PNG by the name its record gives it. */
export function registerScreenshotRoutes(app: FastifyInstance, store: Store, dataDir: string): void {
  app.get('/api/work/:id/screenshots', async (request, reply) => {
    const id = String((request.params as { id?: string }).id ?? '')
    if (store.workItems.get(id) === undefined) return reply.code(404).send({ error: 'work item not found' })
    return { items: screenshotsOf(store, id) }
  })

  app.get('/api/work/:id/screenshots/:attemptId/:file', async (request, reply) => {
    const { id = '', attemptId = '', file = '' } = request.params as Record<string, string | undefined>
    const doc = SAFE_ID.test(attemptId) ? store.engines.get(evidenceDocId(attemptId)) : undefined
    const { before, after } = capturesOf(doc)
    const known = [before, after].some(
      (side) => side?.status === 'captured' && side.shots.some((shot) => shot.file === file),
    )
    if (doc === undefined || doc.workItemId !== id || !SAFE_FILE.test(file) || !known) {
      return reply.code(404).send({ error: 'screenshot not found' })
    }
    const path = join(capturesDir(dataDir, id, attemptId), file)
    if (!existsSync(path)) return reply.code(404).send({ error: 'screenshot not found' })
    return reply
      .header('content-type', 'image/png')
      .header('cache-control', 'no-store')
      .send(readFileSync(path))
  })
}
