# Verification: version 0.3.0

Run by the builder on 6 November 2026. Focused only: no `pnpm check`, no build, no pack, no tarball smoke. Those are the runbook's, for the coordinator.

- `apps/desktop/test/version-sync.test.ts`: with only the desktop version bumped it failed; with all three at `0.3.0` it passed (1 of 1). That is the mutant: one version left behind is killed.
- The tag guard step was not run in Actions. It is the same comparison the runbook's step 2 and 4 describe.
- `pnpm install --frozen-lockfile --offline` was run in the worktree to get the test runner. The lockfile did not change.
