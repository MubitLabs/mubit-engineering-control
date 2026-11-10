/**
 * What a slot's worker can do inside an attempt (§8.4, §9): run commands, edit files, and reach the
 * network from those commands. The desktop reads it off each engine row's launch config; here it is
 * data, so the planner's context, plan admission and placement all read the same record.
 *
 * Owner's horse tinder test, 9 November 2026: a task whose objective said "load index.html in a real
 * browser" was placed on an OpenCode slot, where MEC refuses every shell command, and its attempt
 * could only report blocked.
 */
export type WorkerReach = {
  /** Whether a shell command the worker asks for can run at all. */
  commands: boolean
  /** Whether the worker can change files in its worktree. */
  edits: boolean
  /** Whether its commands reach the network beyond the engine's own domains. */
  network: boolean
}

/** One short plain line for the planner, e.g. "edits files; cannot run commands". */
export function reachWords(reach: WorkerReach): string {
  const edits = reach.edits ? 'edits files' : 'cannot edit files'
  if (!reach.commands) return `${edits}; cannot run commands`
  return `${edits}; runs commands${reach.network ? ' with network' : ', no network'}`
}

/**
 * Words that say the worker itself has to run something, read conservatively: whole words only,
 * and nothing guessed from meaning. A task's acceptance checks are not here: MEC runs those itself.
 */
const COMMAND_WORDS =
  /\b(test command|run|rerun|execute|npm|npx|pnpm|yarn|node|browser|playwright|puppeteer|headless)\b/i

/** The word in a task's objective that needs a worker that runs commands; undefined when none does. */
export function commandNeed(objective: string): string | undefined {
  return COMMAND_WORDS.exec(objective)?.[1]?.toLowerCase()
}

/** Whether a slot may take work that needs commands. A slot with no reach recorded is not ruled out. */
export function runsCommands(slot: { reach?: WorkerReach }): boolean {
  return slot.reach?.commands !== false
}
