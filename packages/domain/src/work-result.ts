/**
 * The local result of a work item, spec §15's definition of done: every required task integrated
 * or excluded with a reason, combined checks passed on the current integration head, and findings
 * dispositioned. An accepted subset is not success, and neither is nothing at all: the integration
 * queue's `done` covers "nothing was accepted", so it can never stand in for this. Pure, so what
 * the meta agent says comes from here and it cannot invent it.
 */

export type ResultTask = {
  id: string
  status: string
  /** The commit it integrated at. */
  sha?: string
  /** Why a cancelled task does not count. Cancelled with none is unexplained, so it is missing. */
  excludedReason?: string
}

export type CombinedChecks = {
  sha: string
  passed: boolean
  checks: { name: string; status: string }[]
}

export type WorkResultInput = {
  tasks: readonly ResultTask[]
  head?: string
  combined?: CombinedChecks
  findings: readonly { text: string; disposition?: string }[]
}

export type WorkResult = {
  complete: boolean
  head?: string
  integrated: { id: string; sha?: string }[]
  excluded: { id: string; reason: string }[]
  checks: { name: string; status: string }[]
  /** What stands between this and complete, in words a person can act on. */
  remaining: string[]
}

export function workResult(input: WorkResultInput): WorkResult {
  const { combined, head } = input
  const integrated = input.tasks
    .filter((task) => task.status === 'integrated')
    .map((task) => ({ id: task.id, ...(task.sha !== undefined && { sha: task.sha }) }))
  const excluded = input.tasks.flatMap((task) =>
    task.status === 'cancelled' && task.excludedReason !== undefined
      ? [{ id: task.id, reason: task.excludedReason }]
      : [],
  )
  const remaining = input.tasks.flatMap((task) => {
    if (task.status === 'integrated') return []
    if (task.status === 'cancelled') {
      return task.excludedReason === undefined ? [`${task.id} was cancelled with no reason`] : []
    }
    return [`${task.id} is ${task.status}, not integrated`]
  })
  if (integrated.length === 0) remaining.push('no task is integrated')
  const onHead = head !== undefined && combined?.sha === head
  if (!onHead) remaining.push('combined checks have not run on the integration head')
  else if (!combined.passed) remaining.push(`combined checks failed on ${head}`)
  for (const finding of input.findings) {
    if (finding.disposition === undefined) remaining.push(`finding not dispositioned: ${finding.text}`)
  }
  return {
    complete: remaining.length === 0,
    ...(head !== undefined && { head }),
    integrated,
    excluded,
    checks: onHead ? combined.checks : [],
    remaining,
  }
}
