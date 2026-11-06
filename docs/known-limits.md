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

- **The attempt runner is on by default since 0.3.1, on any repository.** DECISIONS #25 kept it to
  scratch repositories behind a flag because of the first point below, and that point still holds.
  `MEC_REAL_RUNNER=0` turns it off, but that choice is not saved: `mec restart` passes on the
  environment of the shell that runs it, so from a shell without the variable an off server comes
  back on. With it on:
  - Repo checks run agent-written code on the host, unsandboxed, with a scrubbed environment and
    no tools token.
  - The sandbox's network allowlist is the engine's own domains. Repo docs have no registry-domains
    field (§14), so a bootstrap that needs the network fails.
  - The sandbox covers the engine's Bash. The Read tool is outside it: a read outside the worktree
    is answered by the permission rules, not the sandbox.
  - A linked slot runs under the user's own Claude settings. Allow rules there can answer a Bash ask
    before `mcp__mec__confirm` hears it, so `git push` and `gh` are also refused by engine deny
    rules, and the sandbox stays the boundary.
  - A confirm-by-default shell class is recognised from the command text, so a spelling the list
    does not know runs as ordinary shell. Under the sandbox it reaches no network.
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

- **`mec backup` and `mec restore` keep less than the whole state dir, and have no schedule.**
  - Spec §20 says "on schedule", but gives no interval, so only on-demand backups exist. Cron can
    run `mec backup`.
  - `repos/` is left out whole and any binary or non-UTF-8 file is left out by name, because
    redaction cannot read them. So a local `mec/*` commit that was never pushed is not in a
    backup, a restored worktree's `.git` file dangles until its clone returns, and how recovery
    treats such a worktree has not been exercised.
  - Dedicated-slot workers write engine transcripts under `engines/claude/<slot>/`. Text
    transcripts are redacted by shape. Whether a real transcript holds `MEC_TOOLS_TOKEN` (spec line
    558, §5.7) has not been checked with a real run; it is a planned check in handoff 33 B.
  - A token encoded inside text, such as base64, does not match a shape and stays.
  - A token joined to a word character, such as an ANSI colour code ending in `m`, does not match
    a shape and stays. JSON escapes before a token do match: redaction cuts the text at them.
  - A backup taken with `mec backup` does not update the "last backup" in Settings.
- **Card resolve gaps on `main` (open, assigned to handoff 21).**
  - A direct `POST /api/inbox/:id/resolve` still settles a no-evidence non-release card.
  - `#persistExtras` stores a planner card's operation and evidence unredacted (spec §13
    invariant 3), and `cardDetail` does not redact field names or class.
  - A `{class}`-only `request_confirmation` is deny-only.
  - The toast says "agent was told to continue" on a planner card that runs nothing.
- **An open tab goes stale if the server restarts on a new port.** An owner ruling is still needed
  (DECISIONS #41 makes a restart reuse the last port; #44 makes `mec restart` really restart).
  A repository edit stops admitted work at its next launch (`repo_profile_changed`); that
  behaviour is kept and the Settings text now says so.
- **`MEC_FAKE_ENGINE=1` cannot run an attempt from a package.** The fake launch replays a fixture
  from `packages/testkit`, which is not shipped, so `effects:launch` reports ENOENT. Chat and
  planning work. The flag is for development and the check needs a checkout.
- **`bundle.test.ts` waits 6 seconds for health and can flake under load.**

- **Codex and OpenCode attempts (M2.4 Part B).** Each is proven alone; see `docs/log/HANDSHAKES.md`.
  - Codex's sandbox can express what Claude's does and more: its permissions profile writes only
    to the worktree and temp dir, keeps `refs`, `packed-refs`, `objects`, the index and `HEAD` of
    the shared clone unwritable while git can read them, and refuses the deny list for reading.
    The worker's shell is sandboxed; the engine itself is not.
  - Every Codex ask is refused, because an allowed one runs outside the sandbox. A worker that
    needs network or a path beyond the worktree cannot get it.
  - Push on Codex is stopped by the sandbox and by no name rule: in-sandbox commands are not asked,
    so `git push` runs and fails. The profile refuses network. On Claude the deny rule names it.
  - **OpenCode has no OS sandbox, so it cannot express the shared clone denial, or any other.** MEC
    pins `sandbox: off` and the decider refuses every shell command, git included. A worker there
    can read and edit inside the worktree and call MEC's tools, and it cannot run a test. Its
    boundary is the engine's own permission rules. They bind its tools. Nothing here binds code
    the engine itself runs, and a bug in those rules has no second line behind it.
  - A linked home brings things the attempt cannot switch off: `~/.codex/AGENTS.md` and skills on
    Codex, and connected MCP servers on OpenCode, whose tools are denied though the servers run.
    MEC's sessions land in that home's history. Dedicated slots have none of this, and neither
    engine has been proved on one here.
  - `budget.turns` binds Claude alone. Codex and OpenCode have no turn cap, so the wall clock is
    their only bound.
  - On Codex a command the sandbox refuses reaches no journal event, so a refusal may show only in
    the model's own report.
  - The model table lists `gpt-6-*`; 0.148.0's catalogue offers `gpt-5.6-*`. A planner choosing a
    Codex tier from the shipped table can pick a model the engine refuses, which fails that attempt.
  - `send` stays unsupported on both, with an explicit failure, until `deliver` is proven.
  - A stop finds a server's commands by parentage, then signals and confirms their process groups,
    so a command outlives a server that crashed before any stop: its parent is gone and nothing
    ties it to the attempt. The same holds for a job that left for a group of its own after its
    parent had gone, and for a command started in a new group between that listing and the signal.
  - OpenCode refuses a launch on a tracked link leading out of the worktree. An untracked one is
    not checked: bootstrap commands are the only other writer, and they run on the host anyway.
  - `opencode-gemini` slots can be added and take no work, until a real run proves that login:
    plans and placement leave them out, and a plan pinning one is refused as an unknown slot.
  - The Claude profile does not deny `<data>/work` or `<data>/tmp`, so a sibling's `.mec/mcp.json`
    is readable there. Codex's profile denies both.
- **Unproven on the way to 0.3.0 (6 November 2026, DECISIONS #41-42).**
  - Handoffs 22 and 23 A have run under real Claude only through the composed journey, with fake
    `gh` and a fake remote. No separate verifier has looked at any change since the owner's
    ruling. The worker loopback route was refused under real Claude in one run; the route still
    takes no token, so the sandbox is the whole fence.
  - 0.3.0 is proven on Claude only. Codex and OpenCode have not run on the final build.
  - Nothing has been checked on an installed copy.
- **A server logged "stopping on SIGTERM" and stayed alive after a planner turn** (handoff 23?).
  Not reproduced and not fixed.
- **Cause of the earlier empty tarball is unknown.** A real tarball once shipped with empty models
  and prompts. The package fix is on `main` (#44: a package with no catalogue is refused); the
  release build is still checked for it, but it is no longer a known blocker.
- **Open for 31 C (the combined PR #47 is merged; not re-checked since):** a held row shows a raw ISO time
  (`inspection.ts:597`); wake rows appear in search (`inspection.ts:895-905`); the second-tab 409
  message says "was not sent" though the message was sent and refused.
- **A process group that refuses to die (DECISIONS #45).** The attempt is failed, the failed stop
  is recorded and its capacity stays held until the group is gone: what the stop left is saved as
  `held_groups` on the attempt, counts against the slot, and is released at boot or on the 2 s pass
  once proven gone. 0.3.0 freed the capacity here; 0.3.1 does not.
- **A group that never goes holds its slot indefinitely, with no alert.** Nothing times the hold
  out and nothing tells the owner the slot unit is taken, beyond `processOutcome` on the inspection
  read and `attempt.stop_failed` in the attempt's event stream. Ending the group by hand releases it.
- **A late wake after a pause is assigned to handoff 21** with the card resolve gaps above.
- **`next/work-model` `canApprove` must map absent to null when it is wired (31 B).**
- **A Work row can lag a delivery that falls back by up to 10 seconds.** Going ready reaches the page on the `work:` stream it follows. A ready PR that falls back (`target_moved`, `ci_failed`, `pr_closed`) lands on the release and inbox streams, and the page follows neither, so the row moves on the next refetch.
- **`?ui=classic` needs working browser storage.** Where `localStorage` throws, the shell choice cannot be kept, so the page stays on the new shell, and the "Return to the classic workbench" link appears to do nothing. Classic goes in the next release (decision #35).
