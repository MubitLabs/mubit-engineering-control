# Host-run agreement, the approval key, and the repo environment

On `fix/runtime-defaults` at `4b259ab`, with `666b530` picked on top. The owner ruled that the real runner stays on by default, with per-repository agreement: nothing runs in a repository until the owner agrees. A review found three blockers. This is a permissions change, so a blockers-only review follows it.

## What was wrong

- **B1.** On first start of an upgraded store, old work launched by itself. Mandates never expire, and a slot's first healthy probe released it. Ready tasks, queued attempts with a live row, parked attempts and interrupted attempts all ran. The new test reproduced it on the old code: the queued row drained, a parked attempt reached generation 2.
- **B2.** Attaching a repository gave host execution with no agreement, and the Settings copy said the opposite of what happens. `repo.trust` reaches a launch only as an unread `repo_trusted`.
- **B3.** `SSH_AUTH_SOCK` reached repo commands.
- **Approval route.** A keyless POST settled a card: the new test got 200 on a deny and 422 on an approve. Any local process could say the owner's word.

## The agreement

- `hostRunAgreedAt` on the repository doc. Absent means not agreed, so a store from before it starts unagreed with no migration. It is outside the profile, so `profileHash` and `repositoryRevision` are unchanged, and work pinned earlier keeps its pin.
- Only `POST /api/repositories/:id/host-run/agree` sets it. A repository's POST body, a PATCH and a setup draft cannot.
- `launchAuthority` and `resumeAuthority` defer with `host_run_unagreed`, so rows stay and nothing runs. A policy change waits for it, as it does for a hold.
- A pass places nothing in an unagreed repository: the task defers and says so once. `resumeParked` starts nothing. So a ready task gets no attempt and a parked attempt no new generation until the owner agrees.
- Every path that runs repo commands is gated: the launch gate, the resume gate for a recheck, the launcher before each bootstrap command, the runner before each check of a running attempt, and delivery before integrating, before each integration bootstrap command, and before each combined check. A repair is a launch, and goes through the same gate.

## What the brief did not spell out

- **Blocked work.** "Stays put" was not true before this: `launchAuthority` ran a queued attempt on blocked work, so agreeing would have released it. The launch and resume gates now defer with `blocked`.
- **Withdrawal during a run.** An engine already running finishes its turn, as agreed. Its checks are repo commands, so they stop at the next check. They end with no verdict (`checks_stopped: host_run_unagreed`) and a recheck row waits for the owner, who gets the verdict on agreeing again.
- **Capacity.** A small change avoids the indefinite hold. `cannotStartYet` is true of a queued, resuming or re-checking attempt whose work is unagreed or blocked, and `occupies` and `inUse` skip it. An attempt whose group a boot could not prove gone keeps its place (§8.1), and so does one that is running. A row stays, and it is looked at every 30 s.
- **`SSH_AUTH_SOCK`.** The brief said `repoEnv` only. Integration's bootstrap and checks build their own environment in `delivery.ts` with the same leak, and a test proved it, so `repoInherited` serves both. Engines are unchanged. This is the one deviation from the letter of the brief.
- **Agreeing needs the approval key.** The brief asked for the existing `onRequest` guard, which only stops browsers: an agreed repository's check could have agreed to another repository with one POST. Withdrawing needs no key, so losing the key can never keep work from stopping.

## The approval key

The owner's ruling: if a worker can reach the approval route, add an approval secret and retest. A key is minted in the server's memory at start and required by every route whose path ends in `/resolve`, and by agree, matched on the route's own pattern so a new resolve route is covered unasked. A browser gets it from a one-time code in the fragment of a link the server itself opens. The tab keeps it in `sessionStorage`, and shares it over a same-origin channel.

- **Why not a cookie.** A cookie goes to every port on 127.0.0.1, a repository's own dev server among them.
- **Why not derive anything on disk.** A check can write there too, so a stored hash of the old key could not prove who held it. So a restart ends the key, and a tab shows **Link this browser**, one click.
- **The link's origin** is the server's own port, never the request's `Host`, which a caller chooses: a forged Host would have sent the code to another site.
- **On a mac** the link goes over `osascript`'s stdin, because argv is what any process reads in `ps`. Elsewhere `xdg-open` takes it in argv, and `docs/known-limits.md` says so.
- **Deliberate path.** `mec --approval-key-fd=N`: whoever starts the server chooses a key and hands it in on an inherited descriptor. There is no environment variable, and `mec restart` drops it. The journey rig uses this.

This meets the brief's bar: a check process cannot get the key by reading `~/.mec` or calling loopback, browser headers or not. It is a real barrier against that and not against a hostile process running as the owner, which has the owner's powers: it can run `gh` with the owner's login, write the store directly, or stop this server. `docs/known-limits.md` lists them. That is why the owner should read an agreement as a decision about the repository and everything it can reach.

## Copy

`RepositoryForm` and `TrustControl` no longer imply trust decides what runs. A person sees **Waiting for your agreement** on such work in Work (a new `person/agreement` stage, after `held`) and in Needs you (one `agreement` row per repository, with its count). The armed panel is in Settings, Repositories, and under the Setup steps once a repository is added. It states what the agreement allows, how many items wait, and that it can be withdrawn.

## Records

`realRunnerOn` reads `false` as off, in any case. No SQL migration. `packages/contracts` is unchanged, so there is no fixture or CONTRACTS §10 line. `§10`'s stage table gained a row, and `spec.md` is the coordinator's to update. `docs/DECISIONS.md` also needs the owner's ruling recorded.

## Limits

- The classic shell's Settings has no agreement panel, and its decision view shows `approval_required` as a plain failure. The new shell is the default.
- Other owner routes take no key: chat, questions, hold, lift, stop, slots, policy, repository edits and trust. None answers a card. A question's answer can steer a specialist.
- `repo_trusted` is still unread, so "Trusted: engines honour" is a claim this change did not verify. The copy now says trust does not decide what runs.
- Only the fake CLI ran. See `VERIFICATION.md`.
