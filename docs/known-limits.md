# Known limits

Designed limits — what MEC deliberately does not do. This file does not carry the moving record:
what is verified, what runs on fakes and what is absent lives in [`docs/STATUS.md`](STATUS.md).

- **No auto-update.** `mec update` prints the reinstall path; a new release is installed
  deliberately (release tarball or `npx`), never fetched and swapped in the background
  (DECISIONS #4).
- **No compile-on-install for strangers (§21.7).** `mec` needs `better-sqlite3` and `node-pty`
  as working native modules for the platform (macOS/Linux, arm64/x64). When the launcher cannot
  load them it exits 3 with the message pointing at the reinstall paths: from the repository
  (`pnpm install` — the root `package.json` carries the `pnpm.onlyBuiltDependencies` allowlist —
  then `pnpm build:desktop`), or `npm install --omit=dev` inside an extracted
  `mec-<version>.tgz` release artifact.
- **Single user, single writer.** One data dir (`~/.mec`), one operator, one server: a second
  process on the same data dir refuses to start (O_EXCL lock). There is no multi-user mode and
  no concurrent-server mode, by design.
- **Probes are local and zero-token (§5.8).** The never-list holds: no periodic network probes
  against quota-metered plans, no probe that burns subscription usage. Claude login slots use
  the vendor's own `auth status`; API-key slots (`anthropic-api`, `zai-coding-plan`,
  `google-gemini`) use one zero-token GET against the provider's own models endpoint; each
  engine adapter reports capabilities and auth health from its own local interface. The
  `mec slot probe` CLI subcommand still probes `claude-sub` slots only — other slot kinds probe
  through the workbench/server.
- **`mec slot` operates on local state only.** The subcommands open the store in the data dir
  directly; they never talk to a running server, and the CLI never sees a credential — keys are
  pasted only in the workbench Slots form (§5.4).
- **Inspection reads cost time at scale, and there is no index (DECISIONS #38).** M3.1 stage 1
  adds no inspection index and no SQL migration. At 50,000 docs, reads take 109-182 ms in every
  kind. The handoff's scenario (50,000 tasks, 1,000 work items) takes 30-54 ms. `needs?recent=1`
  reads both whole kinds, so it crosses 100 ms at about 8,000 of each kind (in-memory measure):
  132 ms at 10,000 + 10,000, and 667 ms at 50,000 + 50,000.
- **One oversized record fails its inspection route.** The route answers 500 `response_too_large`
  until that record is removed.

- **The attempt runner is flag-gated and for scratch repositories (DECISIONS #25).** With
  `MEC_REAL_RUNNER=1`:
  - Repo checks run agent-written code on the host, unsandboxed, with a scrubbed environment and
    no tools token.
  - The sandbox's network allowlist is the engine's own domains. Repo docs have no registry-domains
    field (§14), so a bootstrap that needs the network fails.
  - The sandbox covers the engine's Bash. The Read tool is outside it: a read outside the worktree
    is answered by the permission rules, not the sandbox.
  - A linked slot runs under the user's own Claude settings. Allow rules there can answer a Bash ask
    before `mcp__mec__confirm` hears it, so `git push` and `gh` are also refused by engine deny
    rules, and the sandbox stays the boundary.
  - One data dir holds every attempt's worktree, so a sibling attempt's shell can read
    `.mec/mcp.json` while that attempt runs. The sandbox does not separate attempts from each other.
  - A specialist's shell cannot write to the shared clone. Claude's own sandbox adds a linked
    worktree's common git dir to the write list, and a real worker overwrote a sibling's ref there,
    which stopped the next launch on that repository at `git fetch`. MEC now puts the whole
    `<dataDir>/repos/*.git` in `sandbox.filesystem.denyWrite`. The cost is deliberate: a worker's
    `git add`, `git commit`, `git restore`, `git stash` and branch commands all fail, while
    `git status`, `diff` and `log` work. The brief tells it so. MEC commits the leftover tree from
    outside the sandbox.
  - That commit happens only on a completed exit. A run that is stopped, crashes or runs out of
    turns gets no commit: its files stay uncommitted in `<dataDir>/work/<attempt>`, and no head
    records them.
  - The denial covers Claude's Bash on macOS. A real run has not yet proved it, and on Linux it is
    untested. Repo checks and MEC's own git run outside the sandbox.
  - `confirm` judges a Write or Edit by the on-disk path: it reads a name in any case, follows a
    dangling link to its target, and denies a link chain it cannot finish. It judges the path at
    the moment of the ask. A worker's shell can still swap a file for a link after the answer, and
    Claude's own behaviour past an `allow` on a link has not been observed.

- **`mec backup` and restore do not exist, though the spec promises them (spec line 722).** A backup
  would also carry `work/` and the repo clones, so it can be large. Dedicated-slot workers write
  engine transcripts under `engines/claude/<slot>/`, which a backup includes. Whether a transcript
  can hold `MEC_TOOLS_TOKEN` (spec line 558, §5.7) has not been checked with a real run; it is a
  planned check in handoff 33 B.
- **Card resolve gaps on `main` (open, assigned to handoff 21).**
  - A direct `POST /api/inbox/:id/resolve` still settles a no-evidence non-release card.
  - `#persistExtras` stores a planner card's operation and evidence unredacted (spec §13
    invariant 3), and `cardDetail` does not redact field names or class.
  - A `{class}`-only `request_confirmation` is deny-only.
  - The toast says "agent was told to continue" on a planner card that runs nothing.
- **An open tab goes stale if the server restarts on a new port.** An owner ruling is needed.
  A repository edit stops admitted work at its next launch (`repo_profile_changed`); that
  behaviour is kept and the Settings text now says so.
- **`bundle.test.ts` waits 6 seconds for health and can flake under load.**
