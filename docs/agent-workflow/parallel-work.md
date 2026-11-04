# Parallel work and durable handoffs

Use this guide only when running multiple agent sessions. A small task can
remain in a single session. The kit is repository scaffolding, not an agent
scheduler, account manager, or automatic conflict resolver.

- Give each implementation task its own branch and Git worktree, based on a
  recorded base commit. Keep worktrees in a sibling work directory.
- Split work by cohesive implementation areas. Define shared contracts
  before dependent tasks start. Assign an integrator for cross-area changes.
- Record task dependencies, acceptance criteria, implementation areas, and
  verification commands. Implementation areas coordinate ownership; they
  are not sandbox permissions or enforced locks.
- Treat schema files, generated clients, migrations, and dependency lockfiles
  as shared integration points. Coordinate their edits and regenerate once
  from the authoritative source when appropriate.
- Allocate unique ports, database/schema names, temporary directories, and
  queue names where the project requires them. A worktree does not isolate
  running services, caches, databases, or provider credentials by itself.
- Store task progress per change/task. Choose one authoritative place for
  live task state: issue tracker, orchestrator, or task file. Avoid competing
  copies and a single progress file every session edits.
- Each handoff includes revision, changed areas, public-contract changes,
  actual commands and outcomes, remaining failures, and dependent work.
- Re-run appropriate verification on the integrated revision. Two branches
  passing separately does not prove their combined behavior.

The optional templates/TASK.json in the extracted kit is a starting record.
No subagent or model provider dependency is needed to use these conventions.

## Improvement loop

Collect task outcome, setup failures, time locating code, unrelated edits,
test failures, and reviewer rework. Promote a repeated, verified lesson into
the smallest relevant guide or automated check. Remove obsolete guidance.
Evaluate changes on representative tasks before broadening the scaffold.

## This repository

- The store is single-writer: exactly one server per `~/.mec` (O_EXCL lock; a second process refuses). The CLI never talks to a running server.
- Parallel agent sessions should split along package lanes (e.g. `packages/engines` vs `packages/slots` vs `apps/desktop` vs `apps/web`) and never edit another session's in-flight files. The owner caps concurrent subagents at 5.
- Remote effects (push / PR / merge) go through `apps/desktop/src/release.ts`'s confirmation cards — never raw `gh` calls from a session. Owner decision #8 grants the operator standing authority to resolve cards during the build; the cards still open, settle and journal.
- `packages/contracts` is a shared integration point in the kit's sense: coordinate any change, update fixtures, add the CONTRACTS §10 line, regenerate once.
