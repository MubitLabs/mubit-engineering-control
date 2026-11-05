import { describe, expect, it } from 'vitest'
import { decodeNeedsPage, decodeTaskDetail, decodeWorkDetail, decodeWorkPage } from '../src/inspection-decode'
import type { NeedItem, Page, SearchHit, TaskDetail, TaskRow, WorkRow } from '../src/next/inspection-wire'
import {
  approvalProps,
  approvalScope,
  conversationView,
  deliveryDetail,
  needsCount,
  needsList,
  pendingScope,
  questionProps,
  type Read,
  readSurface,
  repoFilterOptions,
  searchRows,
  searchTarget,
  selectionInScope,
  stageGroup,
  staleScope,
  taskInspector,
  taskScope,
  workActions,
  workGroups,
  workRowView,
} from '../src/next/work-model'
import { describeApproval } from '../src/release-cards'
import {
  CARD_HEAD,
  cardEvidence,
  chatLines,
  needs,
  needsPage,
  OLD_HEAD,
  searchPage,
  storedLines,
  TASK_HEAD,
  taskDetails,
  workDetails,
  workPage,
  workRows,
} from './fixtures/inspection-fixtures'

const rows = decodeWorkPage(workPage).items
const items = decodeNeedsPage(needsPage).items
const ALL = { kind: 'all' } as const
const READ_AT = '2026-11-05T10:00:00.000Z'
const ready = <T>(data: T): Read<T> => ({ status: 'ready', data, readAt: READ_AT })
const page = (list: NeedItem[]): Page<NeedItem> => ({ items: list, nextCursor: null, observedAt: READ_AT })
const task = (id: keyof typeof taskDetails, change: Partial<TaskDetail> = {}) =>
  taskScope(decodeTaskDetail({ ...taskDetails[id], ...change }), 'Parent work')
const groupOf = (row: WorkRow) => stageGroup(row)
const fact = (facts: readonly { label: string; value: string }[], label: string) =>
  facts.find((entry) => entry.label === label)?.value

describe('stage groups', () => {
  it('held is not grouped as working', () => {
    expect(groupOf(workRows.held)).toBe('held')
    expect(groupOf({ ...workRows.working, state: 'held' })).toBe('held')
  })

  it('dropped is not grouped as working', () => {
    expect(groupOf(workRows.dropped)).toBe('ended')
    expect(groupOf({ ...workRows.working, state: 'dropped' })).toBe('ended')
  })

  it('a person stage outranks a hold, as the §10 table does', () => {
    expect(groupOf({ ...workRows.blocked, state: 'held' })).toBe('open')
  })

  it('queued and quota come from the stage, never from a state', () => {
    expect(groupOf(workRows.queued)).toBe('queued')
    expect(groupOf(workRows.quota)).toBe('waiting')
    expect(groupOf({ ...workRows.working, state: 'parked' })).toBe('working')
  })

  it('an unknown key goes by whom it waits on, and keeps its label', () => {
    const later = (waitingOn: 'person' | 'system' | 'none') => ({
      ...workRows.working,
      stage: { key: 'a-later-key', label: 'Later label', waitingOn },
    })
    expect(groupOf(later('person'))).toBe('open')
    expect(groupOf(later('system'))).toBe('waiting')
    expect(groupOf(later('none'))).toBe('working')
    expect(workRowView(later('none')).stageLabel).toBe('Later label')
  })

  it('count equals list length', () => {
    const groups = workGroups(rows, ALL)
    for (const group of groups) expect(group.count).toBe(group.rows.length)
    expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(rows.length)
    expect(groups.map((group) => group.key)).toEqual([
      'open',
      'queued',
      'working',
      'waiting',
      'held',
      'ended',
    ])
    const needed = needsList(ready(page(items)), rows, ALL)
    expect(needsCount(needed)).toBe(needed.waiting.length)
    expect(needed.settled.length).toBeGreaterThan(0)
  })

  it('an ended row shows its outcome', () => {
    expect(workRowView(workRows.completed).outcome).toBe('Merged')
    expect(workRowView(workRows.dropped).outcome).toBe('Dropped')
    expect(workRowView(workRows.working).outcome).toBeNull()
  })

  it('a blocked item says what it needs, never a blanket approval', () => {
    expect(workRowView(workRows.blocked).stageLabel).toBe('Needs your answer')
    expect(workRowView(workRows.failed).stageLabel).toBe('Failed')
  })

  it('amber is for a person stage only', () => {
    expect(workRowView(workRows.blocked).tone).toBe('attention')
    expect(workRowView(workRows.quota).tone).toBe('neutral')
    expect(workRowView(workRows.completed).tone).not.toBe('attention')
  })

  it('a missing title and repository are named, never invented', () => {
    const view = workRowView({ ...workRows.legacy, title: null })
    expect(view.title).toBe('Untitled request')
    expect(view.repository).toBe('Unassigned')
  })
})

describe('repository scope and actions', () => {
  it('unassigned work offers no action', () => {
    expect(workActions(workRows.legacy, ALL, null)).toEqual([])
    expect(workActions({ ...workRows.working, repoId: null }, ALL, null)).toEqual([])
    expect(workActions({ ...workRows.working, readOnly: true }, ALL, null)).toEqual([])
  })

  it('ended work offers no action', () => {
    expect(workActions(workRows.completed, ALL, null)).toEqual([])
  })

  it("all-repositories action uses the item's repo", () => {
    const actions = workActions(workRows.quota, { kind: 'repo', repoId: 'repo_a' }, null)
    expect(actions.map((action) => action.repoId)).toEqual(['repo_b', 'repo_b'])
    expect(actions.map((action) => action.workItemId)).toEqual(['work_quota', 'work_quota'])
    const labelled = workActions(workRows.quota, ALL, null)
    expect(labelled.map((action) => action.label)).toEqual([
      'Hold in sample-billing',
      'Stop in sample-billing',
    ])
  })

  it('a held item offers an explicit lift and no hold, and pause is never offered', () => {
    const hold = { since: 'x', reason: null }
    expect(workActions(workRows.held, ALL, hold).map((action) => action.kind)).toEqual(['lift', 'stop'])
    expect(workActions(workRows.blocked, ALL, hold).map((action) => action.kind)).toEqual(['lift', 'stop'])
    expect(workActions(workRows.working, ALL, null).map((action) => action.kind)).toEqual(['hold', 'stop'])
  })

  it('a filter hides other repositories, and Unassigned appears under All or by name', () => {
    const inA = workGroups(rows, { kind: 'repo', repoId: 'repo_a' }).flatMap((group) => group.rows)
    expect(inA.every((row) => row.repository === 'sample-console')).toBe(true)
    const everything = workGroups(rows, ALL).flatMap((group) => group.rows)
    expect(everything.some((row) => row.repository === 'Unassigned')).toBe(true)
    const unassigned = workGroups(rows, { kind: 'unassigned' }).flatMap((group) => group.rows)
    expect(unassigned.map((row) => row.id)).toEqual(['work_legacy'])
  })

  it('offers each repository once, All first and Unassigned last', () => {
    expect(repoFilterOptions(rows, items).map((option) => option.label)).toEqual([
      'All repositories',
      'sample-billing',
      'sample-console',
      'Unassigned',
    ])
  })

  it('a selection outside the filter does not survive it', () => {
    expect(selectionInScope('a', ['a', 'b'])).toBe('a')
    expect(selectionInScope('c', ['a', 'b'])).toBeNull()
    expect(selectionInScope(null, ['a'])).toBeNull()
  })
})

describe('delivery detail', () => {
  it('dependencies and delegation stay separate', () => {
    const detail = deliveryDetail(decodeWorkDetail(workDetails.work_working), null)
    expect(detail.dependencies).toEqual([
      { task: 'SAMPLE-ONLY build the index', on: ['SAMPLE-ONLY read the code'] },
      { task: 'SAMPLE-ONLY run the combined checks', on: ['SAMPLE-ONLY build the index'] },
    ])
    expect(detail.delegation).toEqual([{ parent: 'attempt_lead', child: 'attempt_child' }])

    const noDelegation = deliveryDetail(
      decodeWorkDetail({ ...workDetails.work_working, delegation: [] }),
      null,
    )
    expect(noDelegation.dependencies).toHaveLength(2)
    expect(noDelegation.delegation).toEqual([])

    const noDependencies = deliveryDetail(
      decodeWorkDetail({
        ...workDetails.work_working,
        tasks: workDetails.work_working.tasks.map((row) => ({ ...row, dependsOn: [] })),
      }),
      null,
    )
    expect(noDependencies.dependencies).toEqual([])
    expect(noDependencies.delegation).toHaveLength(1)
  })

  it('task rows carry their own id and real progress', () => {
    const detail = deliveryDetail(decodeWorkDetail(workDetails.work_working), null)
    expect(detail.plan.tasks.map((row) => [row.id, row.progress])).toEqual([
      ['task_done', 'done'],
      ['task_active', 'running'],
      ['task_partial', 'waiting'],
    ])
  })

  it('delivery is named separately from tested work', () => {
    const merged = deliveryDetail(decodeWorkDetail(workDetails.work_done), null)
    expect(merged.plan.footnote).toContain('12')
    const unrecorded = deliveryDetail(decodeWorkDetail(workDetails.work_held), null)
    expect(unrecorded.plan.footnote).toBe('Delivery is not recorded yet')
  })
})

describe('inspector scope', () => {
  it('coverage false maps to not recorded', () => {
    const scope = task('task_partial')
    expect(scope.checks.state).toBe('unavailable')
    expect(scope.checks.heading).toBe('Not recorded yet')
    expect(scope.diff.summary).toBe('Not recorded yet')
    expect(scope.activity.note).toBe('Not recorded yet')
    expect(fact(task('task_active').overview.facts, 'Usage')).toBe('Not recorded yet')
  })

  it('checks never cross scope', () => {
    const scope = task('task_done')
    expect(scope.checks.state).toBe('passed')
    expect(scope.checks.results?.map((result) => result.label)).toEqual(['SAMPLE-ONLY typecheck'])

    // Results for a commit that is not this task's head are not this task's checks.
    const moved = task('task_done', {
      checks: {
        headSha: OLD_HEAD,
        results: [{ name: 'Old', state: 'passed', headSha: OLD_HEAD, detail: null, artifactRef: null }],
        truncated: 0,
      },
    })
    expect(moved.checks.state).toBe('not-run')
    expect(moved.checks.results).toBeUndefined()
  })

  it('a failed result on the exact head makes the scope failed', () => {
    const scope = task('task_done', {
      checks: {
        headSha: TASK_HEAD,
        results: [
          { name: 'A', state: 'passed', headSha: TASK_HEAD, detail: null, artifactRef: null },
          { name: 'B', state: 'failed', headSha: TASK_HEAD, detail: null, artifactRef: null },
        ],
        truncated: 0,
      },
    })
    expect(scope.checks.state).toBe('failed')
  })

  it('an in-progress task shows not run', () => {
    // Even with a head and results to hand: a card's commit is not this running task's evidence.
    const [running] = taskDetails.task_active.attempts
    const scope = task('task_active', {
      attempts: [{ ...running, headSha: CARD_HEAD } as never],
      checks: {
        headSha: CARD_HEAD,
        results: [{ name: 'Card', state: 'passed', headSha: CARD_HEAD, detail: null, artifactRef: null }],
        truncated: 0,
      },
    })
    expect(scope.checks.state).toBe('not-run')
    expect(scope.checks.heading).toBe('Not run yet')
    expect(scope.checks.results).toBeUndefined()
  })

  it('requested tier and actual model stay apart', () => {
    const facts = task('task_active').overview.facts
    expect(fact(facts, 'Requested')).toBe('strong, sample-model-2')
    expect(fact(facts, 'Actual model')).toBe('sample-model-1')
  })

  it('an attempt with no actual model says so and never borrows the requested one', () => {
    const [attempt] = taskDetails.task_active.attempts
    const facts = task('task_active', { attempts: [{ ...attempt, actual: null } as never] }).overview.facts
    expect(fact(facts, 'Actual model')).toBe('Not recorded yet')
  })

  it('internal ids stay in the folded details', () => {
    const scope = task('task_done')
    const open = JSON.stringify([scope.overview, scope.title, scope.context])
    expect(open).not.toContain('task_done')
    expect(open).not.toContain('attempt_done')
    expect(open).not.toContain(TASK_HEAD)
    expect(scope.technical?.map((entry) => entry.value)).toEqual(
      expect.arrayContaining(['task_done', 'attempt_done', TASK_HEAD]),
    )
  })

  it('each scope has its own id, so tabs reset between subjects', () => {
    expect(task('task_done').id).not.toBe(task('task_active').id)
    const approval = approvalScope(needs.pending, cardEvidence.card_pending)
    expect(approval.kind).toBe('approval')
    expect(approval.id).not.toBe(task('task_done').id)
  })

  it('approval evidence is the card’s own', () => {
    const scope = approvalScope(needs.pending, cardEvidence.card_pending)
    expect(scope.checks.state).toBe('passed')
    expect(scope.checks.results?.map((result) => result.label)).toEqual(['SAMPLE-ONLY card check'])
    expect(scope.title).toBe(cardEvidence.card_pending.what)
  })

  it('a card that serves no checks is not recorded, never passed', () => {
    const scope = approvalScope(needs.pending, { ...cardEvidence.card_pending, checks: [] })
    expect(scope.checks.state).toBe('unavailable')
    expect(scope.checks.heading).toBe('Not recorded yet')
  })

  it('a card check that is still running does not pass the card', () => {
    const scope = approvalScope(needs.pending, {
      ...cardEvidence.card_pending,
      checks: [
        { name: 'CI', state: 'running', note: null },
        { name: 'Lint', state: 'passed', note: null },
      ],
    })
    expect(scope.checks.state).toBe('not-run')
  })
})

describe('needs you', () => {
  it('a read failure gives null needs count', () => {
    expect(needsCount(needsList({ status: 'loading' }, rows, ALL))).toBeNull()
    const failed = { status: 'failed', message: 'x', data: null, readAt: null } as const
    expect(needsCount(needsList(failed, rows, ALL))).toBeNull()
    // Kept content is stale: its old count is not a claim about now.
    const stale = { status: 'failed', message: 'x', data: page(items), readAt: READ_AT } as const
    expect(needsCount(needsList(stale, rows, ALL))).toBeNull()
    expect(needsCount(needsList(ready(page([])), rows, ALL))).toBe(0)
  })

  it('keeps settled and expired items, and only open ones wait', () => {
    const { waiting, settled } = needsList(ready(page(items)), rows, ALL)
    expect(waiting.map((item) => item.id)).not.toContain('card_resolved')
    expect(settled.map((item) => item.id).sort()).toEqual([
      'card_expired',
      'card_resolved',
      'question_answered',
    ])
  })

  it('orders by tasks waiting downstream, then oldest first', () => {
    const { waiting } = needsList(ready(page(items)), rows, ALL)
    // question_open's delivery has 5 open tasks, card_pending's and the legacy item's have 3.
    expect(waiting.map((item) => item.id)).toEqual([
      'question_open',
      'question_legacy',
      'card_pending',
      'card_other',
    ])
  })

  it('a filter narrows the list and its count together', () => {
    const scoped = needsList(ready(page(items)), rows, { kind: 'repo', repoId: 'repo_b' })
    expect(scoped.waiting.map((item) => item.id)).toEqual(['card_other'])
    expect(scoped.settled).toEqual([])
    expect(needsCount(scoped)).toBe(1)
  })

  it('a hold keeps the card open and names why, through describeApproval', () => {
    const outcome = describeApproval({ status: 'pending', reason: 'ci_pending' })
    const props = approvalProps(needs.pending, cardEvidence.card_pending, outcome)
    expect(props.status.state).toBe('open')
    expect(props.hold).toContain('Required checks are still running.')
  })

  it('approved is not executed: the outcome is the server’s words', () => {
    const shown = (result: Parameters<typeof describeApproval>[0]) =>
      approvalProps(needs.pending, cardEvidence.card_pending, describeApproval(result)).status
    expect(shown({ status: 'approved', pushed: true })).toMatchObject({ state: 'resolved', label: 'Pushed' })
    expect(shown({ status: 'approved', error: 'no remote' })).toMatchObject({
      state: 'resolved',
      label: 'Failed',
    })
    const stored = approvalProps(needs.resolved, cardEvidence.card_resolved, null).status
    expect(stored).toMatchObject({ state: 'resolved', label: 'Approved' })
    expect(JSON.stringify(stored)).not.toMatch(/\b(pushed|merged)\b/i)
  })

  it('expired and stale are not resolved', () => {
    expect(approvalProps(needs.expired, cardEvidence.card_expired, null).status.state).toBe('expired')
    const stale = { ...needs.pending, status: 'stale' } as const
    expect(approvalProps(stale, cardEvidence.card_pending, null).status.state).toBe('expired')
  })

  it('the confirm step names the effect and the item’s own repository', () => {
    expect(approvalProps(needs.pending, cardEvidence.card_pending, null).confirmLabel).toBe(
      'Confirm: push in sample-console',
    )
  })

  it('a card missing its evidence has nothing to approve', () => {
    expect(approvalProps(needs.pending, null, null).canApprove).toBe(false)
    expect(approvalProps(needs.pending, cardEvidence.card_pending, null).canApprove).toBe(true)
  })

  it('a 409 on an answer says it was already answered', () => {
    expect(questionProps(needs.question, { kind: 'already-answered' }).status).toMatchObject({
      state: 'resolved',
      label: 'Already answered',
    })
    expect(questionProps(needs.answered, null).status).toMatchObject({
      state: 'resolved',
      label: 'Answered',
      detail: 'SAMPLE-ONLY keep it for now',
    })
    expect(questionProps(needs.question, null).choices).toEqual(needs.question.options)
  })

  it('unassigned needs carry no action', () => {
    expect(questionProps(needs.legacy, null).actionable).toBe(false)
    expect(questionProps(needs.question, null).actionable).toBe(true)
    const card = { ...needs.pending, repoId: null, repoLabel: null }
    expect(approvalProps(card, cardEvidence.card_pending, null).actionable).toBe(false)
  })
})

describe('conversation', () => {
  const view = conversationView({
    row: workRows.working,
    detail: decodeWorkDetail(workDetails.work_working),
    messages: chatLines,
  })

  it('the request title leads', () => {
    expect(view.title).toBe('SAMPLE-ONLY search for the console')
  })

  it('routine tool activity stays out', () => {
    expect(view.entries.map((entry) => entry.kind)).toEqual(['user', 'agent', 'note'])
    expect(JSON.stringify(view.entries)).not.toContain('tool call')
  })

  it('an empty repository has no invented title or plan', () => {
    const empty = conversationView({ row: null, detail: null, messages: [] })
    expect(empty.title).toBe('Conversation')
    expect(empty.plan).toBeNull()
    expect(empty.entries).toEqual([])
  })
})

describe('search', () => {
  const [work, taskHit, message] = searchPage.items as SearchHit[]

  it('labels each result by kind and repository', () => {
    expect(searchRows(searchPage.items).map((row) => row.detail)).toEqual([
      'Delivery in sample-console',
      'Task in sample-console',
      'Message in sample-console',
      'Reference in sample-console',
    ])
  })

  it('navigates and selects, and carries nothing for the composer', () => {
    expect(searchTarget(work as SearchHit)).toEqual({
      route: 'work',
      workItemId: 'work_working',
      taskId: null,
    })
    expect(searchTarget(taskHit as SearchHit)).toEqual({
      route: 'work',
      workItemId: 'work_working',
      taskId: 'task_active',
    })
    expect(searchTarget(message as SearchHit)).toEqual({
      route: 'chat',
      workItemId: 'work_working',
      taskId: null,
    })
  })
})

describe('live data', () => {
  const held = decodeWorkDetail(workDetails.work_held)
  const working = decodeWorkDetail(workDetails.work_working)

  it('an absent card detail cannot be approved and names nothing false', () => {
    const absent = { ...cardEvidence.card_pending, absent: true as const, what: 'Evidence not served' }
    const view = approvalProps(needs.pending, absent, null)
    expect(view.canApprove).toBe(false)
    expect(view.title).toBe('Push approval')
    expect(view.consequences).toEqual([])
    expect(view.evidence.map((fact) => fact.label)).toEqual(['Repository'])
  })

  it('a stored message with no kind is the person’s, and its acknowledgement follows', () => {
    const view = conversationView({ row: null, detail: null, messages: storedLines })
    expect(view.entries.map((entry) => entry.kind)).toEqual(['user', 'agent', 'user', 'note'])
  })

  it('an acknowledgement names work by title, never by id', () => {
    const view = conversationView({ row: null, detail: null, messages: storedLines, work: rows })
    const ack = view.entries.find((entry) => entry.kind === 'agent')
    expect(ack?.text).toContain('search for the console')
    expect(ack?.text).not.toContain('work_working')
  })

  it('left-out tasks are said, never silently complete', () => {
    expect(deliveryDetail({ ...working, tasksTruncated: 3 }, ALL).plan.subtitle).toContain('3 more not shown')
    expect(deliveryDetail(working, ALL).plan.subtitle).not.toContain('not shown')
  })

  it('left-out dependencies are said', () => {
    const [first, second, third] = working.tasks as [TaskRow, TaskRow, TaskRow]
    const cut = { ...second, dependsOnTruncated: 2 }
    const detail = deliveryDetail({ ...working, tasks: [first, cut, third] }, ALL)
    expect(detail.dependencies.find((link) => link.task === cut.title)?.more).toBe(2)
  })

  it('left-out attempts, checks and files are said', () => {
    const scope = task('task_done', {
      attemptsTruncated: 4,
      checks: { ...taskDetails.task_done.checks, truncated: 5 },
      diff: { ...taskDetails.task_done.diff, truncated: 6 },
    })
    expect(scope.activity.note).toContain('4 older attempts not shown')
    expect(scope.checks.detail).toContain('5 more results not shown')
    expect(scope.diff.summary).toContain('6 more files not shown')
  })

  it('a list with more to read has no count, because the count must equal it', () => {
    const list = needsList(ready({ ...page(items), nextCursor: 'more' }), rows, ALL)
    expect(list.count).toBeNull()
    expect(list.partial).toBe(true)
    expect(needsList(ready(page(items)), rows, ALL).partial).toBe(false)
  })

  it('a card that settled elsewhere drops an earlier hold', () => {
    const hold = describeApproval({ status: 'pending', reason: 'ci_pending' })
    expect(approvalProps(needs.pending, cardEvidence.card_pending, hold).hold).toContain('still running')
    const settled = { ...needs.pending, status: 'approved' as const }
    expect(approvalProps(settled, cardEvidence.card_pending, hold).hold).toBeNull()
  })

  it('an answer that did not land keeps the question open and says so', () => {
    const view = questionProps(needs.question, { kind: 'failed', message: 'Not sent' })
    expect(view.status.state).toBe('open')
    expect(view.failure).toBe('Not sent')
    expect(questionProps(needs.question, null).failure).toBeNull()
    expect(questionProps(needs.answered, { kind: 'failed', message: 'Not sent' }).failure).toBeNull()
  })

  it('newest work leads its group, whatever order the server pages in', () => {
    const older = { ...rows[0], id: 'older', updatedAt: '2026-11-01T00:00:00.000Z' } as WorkRow
    const newer = { ...rows[0], id: 'newer', updatedAt: '2026-11-02T00:00:00.000Z' } as WorkRow
    const [group] = workGroups([older, newer], ALL).filter((entry) => entry.count > 0)
    expect(group?.rows.map((row) => row.id)).toEqual(['newer', 'older'])
  })

  it('a registered repository with no work is still a filter', () => {
    const options = repoFilterOptions([], [], [{ id: 'repo_new', label: 'fresh' }])
    expect(options.map((option) => option.label)).toEqual(['All repositories', 'fresh'])
  })

  it('discussing is offered only on work a person can still follow up', () => {
    expect(deliveryDetail(working, ALL).discuss).toEqual({
      label: 'Discuss this work in sample-console',
      workItemId: 'work_working',
      repoId: 'repo_a',
    })
    expect(deliveryDetail(working, { kind: 'repo', repoId: 'repo_a' }).discuss?.label).toBe(
      'Discuss this work',
    )
    expect(deliveryDetail({ ...held, repoId: null, repoLabel: null }, ALL).discuss).toBeNull()
    const ended = decodeWorkDetail({ ...workDetails.work_working, ...workRows.completed })
    expect(deliveryDetail(ended, ALL).discuss).toBeNull()
  })

  it('a message in another repository opens its work, because the thread here is not its own', () => {
    const hit: SearchHit = {
      kind: 'message',
      id: 'm',
      title: 't',
      repoLabel: 'other',
      workItemId: 'work_x',
    }
    expect(searchTarget(hit, 'sample-console').route).toBe('work')
    expect(searchTarget(hit, 'other').route).toBe('chat')
  })

  it('a detail that could not be read says so in its inspector, and keeps its own id', () => {
    const scope = pendingScope('task_x', 'Parent work', 'Reading this task')
    expect(scope.id).toBe('task:task_x')
    expect(scope.checks.state).toBe('unavailable')
    expect(scope.title).toBe('Reading this task')
  })

  it('a selection shows its own task, from its own delivery, or nothing', () => {
    const read = ready(decodeTaskDetail(taskDetails.task_done))
    expect(taskInspector('task_done', read, 'work_working', 'Parent')?.title).toBe(
      taskDetails.task_done.title,
    )
    expect(taskInspector('task_other', read, 'work_working', 'Parent')).toBeNull()
    expect(taskInspector('task_done', read, 'work_held', 'Parent')).toBeNull()
  })

  it('a task that cannot be read says why, and a kept one is labelled stale', () => {
    const failed: Read<TaskDetail> = { status: 'failed', message: 'Down', data: null, readAt: null }
    expect(taskInspector('task_done', failed, 'work_working', 'Parent')?.title).toBe('Down')
    const kept: Read<TaskDetail> = {
      status: 'failed',
      message: 'Down',
      data: decodeTaskDetail(taskDetails.task_done),
      readAt: READ_AT,
    }
    expect(taskInspector('task_done', kept, 'work_working', 'Parent')?.context).toContain('Stale')
  })

  it('kept evidence is labelled stale', () => {
    const scope = staleScope(task('task_done'), 'Stale. Last read 10:00')
    expect(scope.context).toContain('Stale. Last read 10:00')
    expect(scope.id).toBe(task('task_done').id)
  })
})

describe('surface state', () => {
  const empty = (value: readonly unknown[]) => value.length === 0

  it('every read ends in ready, empty or failed', () => {
    expect(readSurface({ status: 'loading' }, empty).state).toBe('loading')
    expect(readSurface(ready([]), empty).state).toBe('empty')
    expect(readSurface(ready([1]), empty).state).toBe('ready')
    const failed = { status: 'failed', message: 'down', data: null, readAt: null } as const
    expect(readSurface(failed, empty).state).toBe('failed')
  })

  it('a failure keeps content, says when it was read and is labelled stale', () => {
    const surface = readSurface({ status: 'failed', message: 'down', data: [1], readAt: READ_AT }, empty)
    expect(surface.state).toBe('failed')
    expect(surface.hasContent).toBe(true)
    expect(surface.freshness).toMatch(/^Stale\. Last read /)
  })

  it('a failure with nothing kept never reads as empty', () => {
    const surface = readSurface({ status: 'failed', message: 'down', data: null, readAt: null }, empty)
    expect(surface.hasContent).toBe(false)
    expect(surface.freshness).toBeNull()
  })
})
