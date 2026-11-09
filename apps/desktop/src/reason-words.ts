/**
 * A stored reason opens with a code (`repo_profile_changed: …`) that the writers keep for tests,
 * events and the queue. Work and Needs you say it in words instead: the code is replaced, and the
 * detail after it stays where it adds something. An unknown code still loses its underscores, so
 * no `snake_case:` reaches a person.
 */

/** `true`: the code's words say it all, and the writer's detail only repeats them. */
const WORDS: Readonly<Record<string, readonly [string, boolean?]>> = {
  // §14 and decision #41: work runs only under the commands pinned when it was admitted.
  repo_profile_changed: [
    'The repository’s setup or check commands changed since this work was planned, so MEC will not deliver it under the old ones',
    true,
  ],
  bootstrap_failed: ['The repository’s setup command failed'],
  policy_changed: ['The policy changed since this work was admitted'],
  mandate_expired: ['This work’s mandate expired'],
  mandate_withdrawn: ['This work was stopped'],
  repo_mismatch: ['This work and its task name different repositories'],
  no_runner: ['Nothing on this machine can run attempts'],
  engine_missing: ['An engine is not installed'],
  engine_unsupported: ['An engine’s version is not one MEC supports'],
  engine_not_launchable: ['This engine cannot run tasks yet'],
  auth_required: ['A connection needs signing in again'],
  model_refused: ['No model could be chosen for this task'],
  // The runner's: the engine refused the model it was given (detail: `<model> on <slot>: <its words>`).
  model_unsupported: ['The connection cannot run the model chosen for this task'],
  worktree_gone: ['The task’s worktree is gone'],
  slot_home_missing: ['A connection has no home directory'],
  slot_kind_unsupported: ['This engine cannot use that kind of connection'],
  unknown_role: ['The plan names a role MEC does not know'],
  launch_mismatch: ['MEC’s records for this launch disagree'],
  no_commit_identity: ['The repository sets no commit name or email', true],
  host_run_unagreed: ['You have not agreed to run this repository’s commands on this machine', true],
  // The release step's refusals (`release.ts` REFUSALS), stored on a delivery record.
  unknown_repo: ['The repository is not registered'],
  repo_not_local: ['The repository has no clone on this machine'],
  remote_unreadable: ['The repository’s remote could not be read'],
  default_branch: ['The default branch could not be read'],
  head_unreadable: ['The branch’s head could not be read'],
  stale_head: ['The branch moved since it was checked'],
  invalid_ref: ['A branch name is not valid'],
  pr_unreadable: ['The pull request could not be read'],
  pr_not_open: ['The pull request is not open'],
  unknown_work: ['The work item is not known'],
  delivery_mismatch: ['The delivery record does not match this work'],
  delivery_not_ready: ['The delivery is not ready'],
}

const CODED = /^([a-z]+(?:_[a-z]+)+)(?::\s*(.*))?$/s

/** The reason in words. One that does not open with a code is returned as it is. */
export function reasonWords(reason: string): string {
  const match = CODED.exec(reason)
  if (match === null) return reason
  const [, code = '', detail = ''] = match
  const known = WORDS[code]
  const words = known?.[0] ?? code.replaceAll('_', ' ')
  return known?.[1] === true || detail.trim() === '' ? words : `${words}: ${detail}`
}
