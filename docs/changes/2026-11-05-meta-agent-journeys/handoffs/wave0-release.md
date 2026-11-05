<!-- Wave 0 scout report, 5 November 2026, base a102313. Leads, not facts: check against source. -->

# Release-path scout, base a102313

**Verdict: Decision #16 cannot be followed today. In the UI, clicking Approve on a pr_create or pr_merge card runs nothing and burns the card. Push has no card at all. The bootstrap PR must carry more than the squash fix.**

Evidence labels:
- **[RAN]** I ran it.
- **[SRC]** source reading only.

The throwaway server ran a fresh esbuild bundle of current source, from the scratchpad. It used `HOME` and `MEC_DATA_DIR` in scratch and fake `gh`/`git` on PATH, so GitHub was never touched.
- `lsof` showed `<scratch>/state/mec.db`.
- The fake HOME got no `.mec`, so startup writes nothing under `~/.mec`.
- Real `~/.mec/mec.db` mtime stayed at Nov 4 16:40:58.
- The server stopped (exit 0, port closed).
- Baseline: `node_modules/.bin/vitest run apps/desktop/test/release.test.ts` gave 23 passed.

## Runbook (after the bootstrap repairs in Gaps 1-3)

1. **Build in a dedicated worktree.** `pnpm install --frozen-lockfile && pnpm build:desktop && pnpm --dir apps/web build`.
   - This is required: without `dist`, `bin/mec.js:20` falls back to `src/serve.ts`, and that import fails with `ERR_MODULE_NOT_FOUND` for `./composition` [RAN, Node 25.8.2].
   - The main checkout's `apps/desktop/dist` is stale (4 Nov 14:31, before fda9b4d).
2. **Start the scratch server.** `export MEC_DATA_DIR="$(mktemp -d)"; MEC_NO_OPEN=1 node apps/desktop/bin/mec.js`, then read the URL from the "mec server listening on" line.
   - State dir: env only, `bin/mec.js:71`.
   - Port: no flag. It is always ephemeral on 127.0.0.1 (`composition.ts:225`), so it cannot collide [RAN: 50558, mec-tools on 50557].
   - A second server on the same dir refuses to start (`store/lock.ts:30`).
   - Keep the real HOME so `gh` auth works.
3. **No setup is needed.** No slots, wizard or repo registration [RAN: `/healthz`, `/api/inbox` and card opening all worked on an empty store]. Routes don't validate `repo` against registrations (`server.ts:1222-1232`).
4. **Keep the scratch server to release routes.**
   - Don't use Settings, Prompts, Models or Slots on it. `keystoreRoot` is not passed by composition and defaults to the real `~/.mec` (`server.ts:168,397,1729,1751,1767`).
   - Don't run `mec slot|status|stop`. They hardcode `~/.mec` (`mec.ts:176`).
5. **Push.** Gap 2; there is no route today.
6. **Open the PR card:** `curl --noproxy '*' -XPOST $URL/api/release/pr -H 'content-type: application/json' -d '{"repo":"MubitLabs/mubit-engineering-control","branch":"<b>","title":"<t>","body":"<b>"}'`, which returns `{confirmationId}`.
7. **Open the merge card:** `-XPOST $URL/api/release/merge -d '{"repo":"...","prNumber":N}'`.
8. **Owner clicks at `$URL/#/needs`.** Reload after the card opens: `release:*` streams aren't subscribed (`workbench.tsx:219-224`) and the 10s timer only reads status (`:242-249`). [SRC]
9. **Stop.** `kill -TERM <pid>`, then `rm -rf "$MEC_DATA_DIR"`.

**Bootstrap (#17).** The scratch server can run the fix from its unmerged worktree, so repaired push and PR cards can carry their own PR. The owner then squash-merges by hand on GitHub.

**Headers [RAN].** Origin rules are at `server.ts:428-450`.
- A browser Origin without `x-mec-client: 1` gets 403 `missing client header`.
- A non-loopback Origin gets 403 `origin not local`.
- Curl with no Origin needs no header.
- The web client always sends the header (`api.ts:323-328`).

## Answers

**Q2: push.** No card exists. `pushIntegrationBranch` (`release.ts:192`) has no production caller, only tests. No HTTP route exposes it. `openConfirmation` is never called with class `push`, and `cardFor` accepts only pr_create and pr_merge (`:300`). The `push` class exists only in policy (`policy.ts:12,31`). This is a plain gap against the owner's "ask before each push".

**Q3: PR and merge behaviour.**
- `POST /api/release/pr` opens a card and doesn't push. Resolving it runs exactly `pr create -R <repo> --head <b> --title <t> --body-file -`, body on stdin [RAN with fake gh]. The branch must already be on origin.
- `docs/reference.md:79` is false: it claims push and yield-check. `yieldCheck` has no production caller.
- `POST /api/release/merge` opens a card and makes no gh call. Resolve is `POST /api/release/merge/:id/resolve {"answer":"approve"|"deny"}`.
- **The UI cannot do this.** `api.resolve` posts to `/api/inbox/:id/resolve` (`api.ts:400-401`), which only settles the record (`server.ts:629-655`). [RAN] On both card classes: 200 `approved`, 0 gh calls, then the release resolve returns 409 `already_handled`.
- The UI still toasts "Approved — the agent was told to continue" (`workbench.tsx:318`). [SRC]
- The inbox serves only id, cls, hash and expiry. `/detail` returned 404 [RAN]. So the card shows "PR Create" plus a hash and "Evidence: not served" (`Tray.tsx:23-29,61-68`). The owner can't see the repo, branch or PR number.
- **Interim, if Gap 1 isn't fixed first:** the owner runs `curl -XPOST $URL/api/release/{pr|merge}/<id>/resolve -H 'content-type: application/json' -d '{"answer":"approve"}'` in their own terminal, never touches Approve in the UI, and sees the payload only via our chat. That is not a click on a card, so the owner must accept it explicitly.

**Q4: merge gate.**
- It reads all checks (`release.ts:494-508`) with no `--required`, despite `gh pr checks --required` existing.
- Any non-SUCCESS blocks. A SKIPPED row gave `ci_failed` [RAN].
- It doesn't read `mergeStateStatus`. So a behind-base PR with green checks would pass the gate and spend the card, then gh would fail (`:563-575`) and a new card is needed. [SRC; the GitHub refusal is not observed]
- Protection is live: 9 strict contexts, linear history, no rulesets [RAN]. Each squash therefore makes other open PRs behind, and `allow_update_branch` is false.
- Copilot: PR #23 has 9 check rows, all SUCCESS, and no Copilot row. Its review is COMMENTED only, so no Copilot stall was observed [RAN].
- Deny is ignored while the gate is red: it returned `ci_failed`, the card stayed pending, and a later approve merged [RAN with fake gh].

**Q5: squash test.**
- `apps/desktop/test/release.test.ts:304-329`; `:325` asserts `toContain('--merge')`. Only `release.ts:482` and `:563` and that test line carry `--merge` in committed files. Docs mention it only in uncommitted planning records.
- Failing-first change at `:325`: `expect(merges[0]?.args).toEqual(['pr','merge','-R',REPO,'--squash','12'])`. Today's argv is `pr merge -R <repo> --merge <n>` [RAN]. Mutants: restore `--merge`, or pass both flags.
- The fake routing and `includes('merge')` filters at `:270,323` survive the change.
- Head SHA is **not** bound. The merge hash is `pr_merge:repo:N` (`:456`), the PR hash is title+body+branch (`:332`), and `inputSha` is never set. Spec §13 (`spec.md:552`) requires it. Use `--match-head-commit`, which exists in gh 2.103.3.
- MERGED works with squash: #23 is single-parent and reports `state: MERGED`, merge oid a102313 ≠ head 41bbedf [RAN]. prflow has no merge-commit state (`prflow.ts`).
- One assumption would matter later: `yieldCheck` compares `main...branch` (`:133`). Stale squashed branches would still show files, and `delete_branch_on_merge` is false. It is unwired today.

**Q6: other breakage.**
- `-R` takes `owner/name` verbatim and is not validated.
- No `--base` is passed, so the base is the default branch; that is `main` here, but `yieldCheck` also hardcodes it. Fine for this repo. [SRC]
- Title is trimmed and body may be empty. `buildPrBody` is unwired, so the caller writes the body.
- A failed `gh pr create` spends the card (`:406-417`).
- Help says `gh pr checks` exits 8 on pending. If that also applies with `--json`, the reason is `ci_unreadable`, not `ci_pending`. The same goes for an unreported-checks exit. Not observed; the fake tests assume exit 0.
- `git push` and `gh` have a 30s timeout (`:31`).

## Gaps, in bootstrap order

1. **BLOCKER:** UI approve is a no-op that burns the card (Q3). Fix: `/api/inbox/:id/resolve` dispatches release classes to the release functions, or refuses them. `approveDecision` must show the real result, including `ci_pending` and `gh_merge_failed`.
2. **BLOCKER:** no push card or route. It needs a design choice for `gitDir`: bind it to a registered repo, never a caller path. That means the "no registration" answer changes for push.
3. **BLOCKER:** the card hides what is being approved. Serve the payload, and `/api/inbox/:id/detail` fits the existing client.
4. **BLOCKER for later card merges:** `--merge` → `--squash`. The bootstrap PR itself is hand-merged (#17).
5. Bind the head SHA: `inputSha` plus `--match-head-commit`.
6. Pre-flight `mergeStateStatus` so a BEHIND PR doesn't spend the card.
7. Decide all-checks versus `--required`, and treat SKIPPED and NEUTRAL honestly.
8. Honour deny before the CI gate.
9. Fix `docs/reference.md:79,81` and the `release.ts:482` comment.
10. `bin/mec.js:20` source fallback fails; `MEC_DATA_DIR` is ignored by the CLI and `keystoreRoot`.
11. Inbox has no live refresh for `release:*`.

**Operator question for the coordinator:** Gaps 1-3 change the confirmation gate. Does that count as a "permissions" change needing one blockers-only review under the standing rule? I think yes.

**Untested:** no real gh write, real push, UI rendering of a card, or GitHub's actual refusal of `--merge`. `/` returned 404 on my scratch bundle because it has no web dist there.

**Repo:** no repo file was changed. The `.claude/worktrees` directory is untracked, dated 13:05, and is not mine. `/private/tmp/claude-501/-Users-shankhadutta-code-mubit-engineering-control/2df31a5d-d987-49c0-b14f-93aa17eec939/scratchpad/scout` holds the bundle and driver; the state and home dirs are removed.
