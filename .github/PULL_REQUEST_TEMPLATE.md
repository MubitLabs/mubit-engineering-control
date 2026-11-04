## Summary

What this changes and why, in a sentence or two. If a change record exists in
`docs/changes/<change-id>/`, link it.

## Checklists

From [`CONTRIBUTING.md`](../CONTRIBUTING.md) — check what is true, fix what is not before asking
for review:

- [ ] **Cross-review (§7.2).** Reviewed by an instance that did not write this change; the review
      (who reviewed, what it checked) is recorded in this PR.
- [ ] **No test mocks its own unit.** Evidence uses the shared fixture library, `MemoryRepositories`,
      contract schemas or recorded streams — a test that mocks the unit under test is not evidence.
- [ ] **Fixtures are honest.** `recorded_by` reflects reality: `real` only for a real binary that
      actually ran; synthetic stays synthetic with the reason in `meta.json`.
- [ ] **§26 row updated.** If a fault-suite row is touched, `docs/fault-suite.md` names the test
      file and the provenance for it.
- [ ] **The contracts seam.** `packages/contracts` is either untouched, or the change is additive
      with the matching fixture update and a line in `docs/handoff/CONTRACTS.md` §10.
- [ ] **Commit hygiene.** Subject ≤ 72 characters; the narrative lives in the body or in `docs/log/`.
- [ ] **No secrets.** No credential, token, key or unredacted path to one anywhere in the diff.
