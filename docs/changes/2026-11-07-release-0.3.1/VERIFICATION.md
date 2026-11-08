# Verification: version 0.3.1

Run by the builder on 7 November 2026. Docs and versions only.

- `apps/desktop/test/version-sync.test.ts`: run once on the bumped tree; result in the builder's report.
- No `pnpm check`, build, pack or tarball smoke. Those are the runbook's, for the coordinator on a quiet machine. `pnpm check` has not passed clean on the combined tree under load (`docs/changes/2026-11-06-core-ship/VERIFICATION.md`).
- Nothing in the records was checked against a running server. The real-run claims in the changelog and checkpoint come from the coordinator's pending records and brief, not from this change.
