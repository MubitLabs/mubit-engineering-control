import type { InspectorScope } from '../../src/next/Inspector'
import type { TaskProgress } from '../../src/next/Conversation'
import type { RecentItem, RepositoryOption } from '../../src/next/Sidebar'

/**
 * Synthetic examples for the screenshot harness and nothing else. These never reach a build:
 * the only production entry is index.html, and test/next-boundary.test.ts keeps every
 * sentence below out of src/next.
 */

export const sampleRepositories: readonly RepositoryOption[] = [
  { id: 'repo_a', name: 'Sample console', detail: 'Local workspace' },
  { id: 'repo_b', name: 'A sample repository with a very long name', detail: 'Local workspace' },
]

export const sampleRecent: readonly RecentItem[] = [
  { id: 'wk_1', title: 'Add sample search', current: true },
  { id: 'wk_2', title: 'Improve sample empties', current: false },
]

export interface SampleTask {
  id: string
  title: string
  detail: string
  stateLabel: string
  progress: TaskProgress
}

export const sampleTasks: readonly SampleTask[] = [
  {
    id: 'task_review',
    title: 'Understand the sample code',
    detail: 'Planner has checked the sample patterns',
    stateLabel: 'Complete',
    progress: 'done',
  },
  {
    id: 'task_build',
    title: 'Build the sample search',
    detail: 'Implementer is adding sample search',
    stateLabel: 'In progress',
    progress: 'running',
  },
  {
    id: 'task_checks',
    title: 'Run the sample checks',
    detail: 'Checks run on the integrated sample commit',
    stateLabel: 'Waiting',
    progress: 'waiting',
  },
]

function taskScope(task: SampleTask, checksRan: boolean): InspectorScope {
  return {
    id: task.id,
    kind: 'task',
    context: 'Add sample search',
    title: task.title,
    overview: {
      sections: [{ heading: 'Current step', body: task.detail }],
      facts: [
        { label: 'Role', value: 'Sample implementer' },
        { label: 'Requested tier', value: 'Balanced sample tier' },
        { label: 'Actual model', value: 'Sample model name' },
        { label: 'Engine', value: 'Sample engine name' },
        { label: 'Connection', value: 'Sample coding slot' },
        { label: 'Last activity', value: 'Sample report received' },
      ],
    },
    checks: checksRan
      ? {
          state: 'passed',
          heading: 'Checks on the sample commit',
          detail: 'Synthetic results for the sample commit.',
          results: [{ label: 'Sample type check', detail: 'Passed on the sample commit', passed: true }],
        }
      : {
          state: 'not-run',
          heading: 'Checks have not run yet',
          detail: 'This sample task is still in progress. No earlier approval result applies here.',
          facts: [{ label: 'Current evidence', value: 'No tested sample commit' }],
        },
    activity: {
      note: 'Redacted sample actions and reports.',
      entries: [
        { when: 'Just now', text: 'Sample report received here.' },
        { when: 'Earlier', text: 'Sample worktree created here.' },
      ],
    },
    diff: {
      summary: 'Synthetic sample diff, one file changed.',
      files: [{ path: 'src/sample/Search.tsx', lines: ['+ sample search input added'] }],
    },
  }
}

export const sampleTaskScopes: Readonly<Record<string, InspectorScope>> = Object.fromEntries(
  sampleTasks.map((task) => [task.id, taskScope(task, task.progress === 'done')]),
)

export const sampleApprovalScope: InspectorScope = {
  id: 'approval_push',
  kind: 'approval',
  context: 'Approval evidence on sample commit 7b34c91',
  title: 'Push the tested sample branch',
  overview: {
    sections: [
      { heading: 'Exact effect', body: 'Push the sample branch only. A pull request is a separate decision.' },
    ],
    facts: [
      { label: 'Tested commit', value: '7b34c91', mono: true },
      { label: 'Checks', value: 'Passed on this sample commit' },
    ],
  },
  checks: {
    state: 'passed',
    heading: 'Validation on the sample commit',
    detail: 'Synthetic example on the exact approved sample commit.',
    results: [{ label: 'Sample behaviour check', detail: 'Passed on the sample commit', passed: true }],
  },
  activity: { note: 'Redacted sample actions and reports.', entries: [] },
  diff: {
    summary: 'Synthetic sample diff at the tested commit.',
    files: [{ path: 'src/sample/Search.tsx', lines: ['+ sample search input added'] }],
  },
}

export const sampleEvidence = [
  { label: 'Repository', value: 'Sample console' },
  { label: 'Branch', value: 'feature/sample-search', mono: true },
  { label: 'Tested commit', value: '7b34c91', mono: true },
  { label: 'Validation', value: 'Checks passed on this sample commit' },
]

export const sampleConsequences = [
  { heading: 'If you approve', body: 'MEC pushes this sample branch and commit. It does not merge.' },
  { heading: 'If you deny', body: 'The tested sample changes stay local. Nothing is pushed.' },
]

export const longMessages: readonly string[] = Array.from(
  { length: 24 },
  (_, index) => `Sample message number ${index + 1} in a long sample conversation.`,
)
