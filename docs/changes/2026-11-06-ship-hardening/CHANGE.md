# Ship hardening

Six open items from the M2 ship, on `fix/ship-hardening` from `4cba2e6`.

1. **Pre-authorisation, recorded per use (§13).** `decideOperation` and `requestConfirmation` now append a redacted `preauthorised_use` event to the work stream before they answer. It is an event, not a confirmation row: no card exists to settle, and the inbox stays a list of questions.
2. **A redacted token no longer merges two operations (§13).** When redaction changed an operation, `openCard` hashes the cleaned text plus `rawDigest`, an HMAC-SHA-256 of the raw text. The key is random per process and is never written. A plain hash of the raw text was rejected: anyone with the store or a backup could test guesses at a low-entropy secret. A restart loses the key, so a secret-bearing command gets a new card rather than the old answer. Operations with nothing redacted hash as before, so their answers survive a restart.
3. **A queued attempt whose launch row drains (§10).** `refuseLaunch` fails a still-queued attempt on `mandate_expired`, `mandate_withdrawn` or `repo_mismatch`, and blocks the work, as `failLaunch` does for any launch that cannot run. `failed` is what §10 names for an attempt that could not run.
4. **`mec status` shows a moved port.** `health.json` carries `portMoved`, and status adds the line at codes 0, 2 and 3 without changing the code.
5. **`slot_claude_probe`.** Placement, dispatch, marks, readiness and the launcher all keep it out. A slot switch did not: it checked health only, and this doc reads healthy, so it queued an attempt the launcher would refuse. The switch now refuses with `target_cannot_launch`.
6. **The tarball README** no longer says commands need a checkout.

## Left as it was

- **`policy_changed` drops do not fail the attempt.** §13 says a policy change never cancels live work, and `composition.test.ts` pins that no attempt event is written. The work blocks, and the attempt stays queued and counts against capacity. Whether it should give that back is an owner question.
- **`work_terminal` and `work_missing` drops do not fail the attempt.** `composition.test.ts` and `attempt-launch.test.ts` pin `queued` for a launch row on stopped work. A real stop already interrupts queued attempts (`interruptAttempts`).
- **`setup.has_slot` counts the probe doc.** Health only: it never places or launches. Nothing in the repository sets `MEC_PROBE_SLOT`.

## Risks

- Two cards for a secret-bearing command read the same to a person, because the difference is redacted. Each still gets its own answer.
- Work whose mandate expires with a queued attempt now blocks with `mandate_expired`, where it used to sit in `executing`.
