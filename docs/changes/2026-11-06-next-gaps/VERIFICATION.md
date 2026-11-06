# Verification

No engine ran. No server ran against `~/.mec`.

## Red, then green

| Gap | Test | Red | Green |
| --- | --- | --- | --- |
| 1 | `a11y.screens.playwright.ts` `the conversation shell has no violations` | `label-content-name-mismatch (serious): .repo-switch`, then `.btn-quiet` | Pass |
| 2 | `config-api.test.ts` `the setup chat`, `config-contract.test.ts` against the real route, `config.screens.playwright.ts` two new tests | `setupMessage` missing, 5 failed | Pass |
| 3 | `meta-slot.test.ts` `a slot with no home of its own`, `readiness.test.ts` two new tests | 5 failed: 200 for 400, `done` for `missing` | Pass |
| 4 | `mec.test.ts` `cliMain finds the server…` | `read from HOME` where `read from MEC_DATA_DIR` was expected | Pass |
| 5 | `config-contract.test.ts` `a slot carries its scheduling fields…`, `config.screens.playwright.ts` row words | fields missing from the row | Pass |

The `cliMain` tests use `status` only, with a scratch `HOME`, so a red run cannot write anywhere near a real install.

## Intended test changes

- `a11y.screens.playwright.ts`: `expectNoViolations` prints every node, not the first. Stricter only in what it reports.
- `config-slots-{light,dark}` baselines regenerated for the two new facts. I looked at the light one. No other baseline moved.

## Commands

| Command | Result |
| --- | --- |
| `python3 tools/mutants/run.py tools/mutants/next-gaps.json` | 14 of 14 killed |
| `pnpm check` | Typecheck and lint pass. 2553 passed, 17 skipped, 1 failed: `login-cards.test.ts` "drives a real interactive shell through the seam", `posix_spawnp failed`, the baseline failure in the handoff README |
| `pnpm --dir apps/web test:screens` (under the lock) | 309 passed, 1 failed: `work-live` `the reset notice does not outlast a failure it would contradict` |
| The same test alone, `--repeat-each=8` | 8 of 8 passed, and it passed in the two earlier partial runs |

That screens failure is unexplained: it failed once under the full suite's load, in a file this change does not touch, and its error was not captured before the rerun. Treat it as a suspected flake, not a proven one.

Gap 1 has no mutant, because `run.py` drives vitest and axe runs under Playwright. Its red run on the unfixed code is the proof.
