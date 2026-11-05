# Verification: make the confirmation cards real

Base a102313. Node as installed on the build machine (macOS). Everything below was run unless marked **read**.

## Failing first

The tests were written and run before the implementation.

```
node_modules/.bin/vitest run apps/desktop/test/release.test.ts apps/desktop/test/release-cards.test.ts \
  apps/desktop/test/server.test.ts apps/web/test/release-cards.test.ts
Tests  72 failed | 35 passed (107)
```

The failures were the expected ones:

| Test | Red for |
| --- | --- |
| merge argv | `expected [ 'pr', 'merge', '-R', …(3) ] to deeply equal [ 'pr', 'merge', '-R', …(5) ]` |
| approving a merge through `api.resolve` | `expected { id: 'conf_…', …(1) } to match object { status: 'approved', …(2) }`, the bare settle |
| BEHIND | the same bare settle, so the card was spent |
| deny under red CI, merge route | `expected { merged: false, …(1) } to match object { merged: false, reason: 'denied' }` |
| push round trip | `expected 404 to be 200`, no route |

The same run after the implementation: 126 passed. The final count is below.

## Gate

| Command | Result |
| --- | --- |
| `pnpm check` | exit 1. `1 failed | 1674 passed | 15 skipped (1690)`. The one failure is the baseline `login-cards.test.ts` "drives a real interactive shell through the seam". Typecheck and lint clean; biome reports warnings only. |
| `pnpm test:screens` (under the shared lock) | 21 passed. No baseline changed. |

Not run on Linux or Node 22/24 here; CI covers those once the branch is pushed.

## Mutants

```
python3 tools/mutants/run.py --self-check tools/mutants/release-cards.json --only "restore --merge"
SURVIVED  self-check no-op (expected SURVIVED)
INVALID   self-check syntax error (expected INVALID)

python3 tools/mutants/run.py tools/mutants/release-cards.json
22 of 22 killed
```

The first full run was 21 of 22. "The CAS trusts the card read before the pre-flight" survived because the racing-approvals test never overlapped: the fake gh answers in microtasks. That test now has latency and asserts both answers passed the pre-flight. The final run above is on the final code.

## Real browser, real server

A one-off driver, not committed: the built server, a scratch `HOME` and `MEC_DATA_DIR`, a fake `gh` on `PATH`, real git to a local bare repository, and Playwright's chromium clicking the real page. `~/.mec/mec.db` mtime was unchanged afterwards.

| Step | Observed |
| --- | --- |
| Open a push card while the page is open | Card appeared without a reload. Text: "Push fix/cards to owner/repo", repository, branch, full head. |
| Click Approve, Confirm: push | Toast "Pushed." The bare repository's ref equals the local head. |
| Open a merge card, state BEHIND | "Squash-merge pull request #12 on owner/repo", with repository, PR, title, branch, head. |
| Click Approve, Confirm: squash-merge | Toast "The PR is behind its base branch. Update the branch, then approve again. The card stays open." Card still open with that note. 0 `gh pr merge` calls. |
| Set state CLEAN, click again on the same card, with a SKIPPED check present | Toast "Merged on GitHub." `pr merge -R owner/repo --squash --match-head-commit <head> 12`. |
| Open a PR card and approve | Card showed title and body. Toast "PR #12 opened." `pr create -R owner/repo --head fix/cards --title Cards --body-file -`. |
| Page errors | none |

## Read-only probes of real gh

Run against this repository with gh 2.103.3; these write nothing.

- `gh pr checks 23 --required --json name,state,bucket`: exit 0, 9 rows, uppercase `SUCCESS`.
- `gh pr view 23 --json state,headRefOid,headRefName,title,mergeStateStatus,baseRefName`: all fields present. `mergeStateStatus` is `UNKNOWN` on a merged PR.
- `gh repo view --json url,defaultBranchRef`: `{"defaultBranchRef":{"name":"main"},"url":"https://github.com/…"}`.
- `gh pr merge --help` lists `--match-head-commit` and `--squash`.
- `gh api repos/<repo>/git/ref/heads/main --jq .object.sha`: exit 0, a 40-character SHA.
- The same read on a missing branch: exit 1, with a JSON error on stdout. The code checks the exit first, so that error is never read as a head.

## Not verified

- No real push, PR or merge has gone through a card. The fake gh and the local bare repository stand in for GitHub. The owner hand-merges this PR (decision #17), so the first real use is the first card after it.
- GitHub's real answers are assumed from documentation or source reading for: `gh pr checks` exit 8 with `--json`, the "no required checks" message text, and a real `BEHIND`. The code holds on all of them either way: no unexpected answer can read as green.

## Bootstrap runbook

Per decision #17, the repaired cards can carry their own PR before they are on main. A scratch server for that needs real `gh`, so it is the owner's step, not an agent's.

1. Build in the worktree that holds the fix: `pnpm build:desktop && pnpm --dir apps/web build`.
2. `MEC_DATA_DIR="$(mktemp -d)" MEC_NO_OPEN=1 node apps/desktop/bin/mec.js`, and read the URL it prints. This keeps the real `HOME` so `gh` works. Stick to release routes, as the scout runbook says.
3. Register the clone: `POST /api/repositories {"urlOrPath":"<absolute path>","trusted":false,"bootstrapCmds":[],"checkCmds":[]}`, which returns `id`.
4. `POST /api/release/push {"repoId":"<id>","branch":"fix/release-cards"}`, then approve on the card at `$URL/#/needs`.
5. `POST /api/release/pr {"repo":"MubitLabs/mubit-engineering-control","branch":"fix/release-cards","title":"…","body":"…"}`, then approve.
6. Merge by hand on GitHub with squash. Later merges use the card.

Registering a repository is a change from the scout runbook's "no registration needed", because push needs a registered git directory.
