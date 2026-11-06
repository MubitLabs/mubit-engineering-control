# Verification

Touched suites only; the landing runs `pnpm check` once.

Failing first, each seen red for the intended reason and then green:

| Item | Test | Red |
| --- | --- | --- |
| 1 | `specialist-cards.test.ts` "each use of a pre-authorisation", "a pre-authorised request leaves" | `expected [] to have a length of 2` / `1` |
| 2 | `specialist-cards.test.ts` "two commands that differ only in a redacted token" | the second ask reused the settled card and timed out waiting for a new one |
| 3 | `authority.test.ts` "drains on an expired mandate", `composition.test.ts` "a launch whose mandate expired" | the attempt stayed `queued` |
| 4 | `status.test.ts` "a moved port", `server-port.test.ts` "mec status shows a moved port" | no line in the output |
| 5 | `slot-switch.test.ts` "the startup probe slot is no target" | `expected 202 to be 409` |

Item 6 is README text, with no test. `node apps/desktop/bin/mec.js help` lists the commands.

Mutants: `python3 tools/mutants/run.py tools/mutants/ship-hardening.json`, 16 of 16 killed.

Seen once: `recovery.test.ts` "a crash mid-check does the same" failed in the run that also held a first draft of item 3, which failed the attempt on `policy_changed`. With that draft narrowed it passed four times (one full file, three alone). The cause is unproven: load average was about 7, and the draft may have contributed.

Not run: `pnpm check`, a built tarball, any real engine.
