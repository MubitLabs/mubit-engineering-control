# MEC user guide

MEC (Mubit Engineering Control) is a local meta-agent orchestration app: you connect your coding agents (Claude Code, Codex, OpenCode), talk to one **meta agent** in chat, and it plans, spawns specialists, and runs the delivery loop — worktrees → checks → review → integration → PR — interrupting you only for guardrail confirmations. Everything runs on your machine: SQLite storage, no cloud, credentials never leave it.

This guide describes the product's behaviour of record (plan [`docs/plan/PLAN_v4.1_local_meta_agent.md`](plan/PLAN_v4.1_local_meta_agent.md); sections cited as §n). What today's build has already proven is recorded in [`docs/log/HANDSHAKES.md`](log/HANDSHAKES.md); what is still gap is recorded in [`docs/fault-suite.md`](fault-suite.md).

## Concepts

### Slots and credential homes

A **slot** binds one engine to one provider and one credential in an isolated home directory (`~/.mec/engines/<engine>/<slot>`) — it is the unit of login, health, quota and scheduling, and a machine can hold several (two Claude subscriptions, one GLM and one Gemini slot on OpenCode). Two custody classes exist and nothing else: **vendor-held OAuth sessions** (Claude and ChatGPT subscriptions) live only in the vendor CLI's own store inside the slot home — MEC never reads, copies or refreshes them, and sign-in always completes through the vendor's own flow; **user-owned API keys** are pasted once in the Slots panel and land in the slot's keystore file (mode 0600) and nowhere else — the database keeps only a fingerprint (provider, last four characters, salted hash) for display and redaction. Only `healthy` slots receive work.

### Work items and stages

Every request becomes a **work item** carrying a **mandate** (origin, scope, policy version, budget, expiry). The meta agent decomposes it into a **plan** (a task graph, validated deterministically), specialists execute **tasks** as **attempts** (one agent execution each, in an isolated git worktree on a pinned base). An open work item always has exactly one **stage** from a first-match table, computed from facts, whose label says whom it waits for: *Needs your answer / approval*, *Sign in again*, *Ready for review*, *Blocked*, *Held by you*, *Waiting for quota (resets hh:mm)*, *Queued*, *Waiting for a trigger*, *Working*. A `person` stage means the item cannot continue without you. Work is preserved through every failure — quota exhaustion, expired logins, crashes, restarts — and resumed, never lost silently.

### Confirmations: nothing leaves the machine without your click

External side effects — `git push`, PR create/edit/merge, branch delete, force operations, writes outside a registered worktree — are **always confirm** (§13): a card appears in the inbox and chat showing the exact operation, diff/SHA and consequences, and nothing runs until you answer. A second class (dependency installs beyond the bootstrap profile, migrations, large spends, switching parked work to another slot) is **confirm by default** and can be pre-authorised in the policy file. The first answer wins (compare-and-set); a changed input makes an earlier approval stale; **expiry is never consent** — a card that timed out was not approved, and the agent is told so. Autonomous by default: planning, spawning within caps, checks, reviews, local integration merges.

### Holds

Say "wait" or "hold on" and the work item is **held**: the hold persists across follow-ups, new attempts and restarts until **you** lift it. Timers, bots and webhooks can never resume held work. A status question ("how is it going?") is answered without resuming the work.

### The meta agent and specialists

The **meta agent** runs on a slot you choose: it admits requests, acknowledges once in a sentence, proposes plans, routes follow-ups to the specialist that owns them, monitors, integrates and reports. It never rewrites your request, never approves its own confirmations, and never edits policy or prompt defaults — there is no tool for it. **Specialists** (implementer, code reviewer, PR reviewer, security checker, test author, integrator, repair agent, release agent) come from a built-in, user-editable registry. The receipt ladder ensures your messages are never silently dropped: a crash between stages never marks an input handled.

## The five screens

1. **Chat** (home) — the conversation with the meta agent: one-sentence acknowledgements, plans as cards, quiet status updates, questions as inline decision cards with evidence one click away. Routine tool activity stays out.
2. **Inbox** — open work items in a `person` stage first, ordered by what unblocks the most work, then problems that need a person (a login card, a key to replace). Each card offers its action directly; a healthy state takes no space.
3. **Work view** — work items by stage, the live agent graph (roles, slots, states), per-attempt reports, transcripts, diffs, checks and findings; a work item's page shows its originating message, mandate, questions and handoffs.
4. **Slots view** — one card per slot: engine, provider, identity, state and reason, last probe, reported utilisation and reset time, pinning; actions *Sign in again*, *Replace key*, *Validate*, *Retire*. *Add slot* is a wizard: engine → provider → sign in (terminal card, OAuth) or paste key (masked form) → validate → done.
5. **Settings** — the policy file, prompt bundles with diffs and history, check and isolation profiles, backups, pause.

## The policy file

Policy lives in a user-owned file you edit — v0 keeps the document JSON, and the plan names the file `~/.mec/policy.yaml`. Agents never write it, and its version hash is recorded with every mandate and plan. Fields: `preAuthorised` (required; explicit pre-authorisation entries per class, each with scope and optional spend bound), `capsOverride` (caps on parallelism/fan-out/budget), `repoTightening` (per-repo overrides that may only **tighten** — a wider override is refused). The always-confirm classes (push, PR create/edit/merge, branch delete, force ops) can never be pre-authorised — a policy document that tries is rejected at load.

What ships conservative by default: **nothing is pre-authorised**, caps are low, auto-failover between slots is off (explicit switch only), and pacing on subscription slots stays within ordinary individual usage (§5.11). Widen per class only with evidence. A policy change never cancels live work silently — affected items get a policy-changed note and mandates are revalidated before any resume.

## Prompt bundles

Prompt text is layered and versioned: shared → role → team conventions/delivery/scope → engine notes → skills, with generated sections (environment, slot health, policy) last. A **revision** is what every save creates: an immutable snapshot of the full configuration with its predecessor, timestamp and origin; a save names its base revision and a conflicting save is refused without losing your draft. Running attempts keep the revision they were pinned to; a later attempt reads the latest one, and MEC records which revision each attempt ran under. When an app update changes a default, you see the diff and choose — upgrades are proposals, never ambushes.

## Backups

`mec backup` writes a tar of the state directory plus a consistent copy of the SQLite database; `mec restore` restores it, and every slot re-probes before scheduling resumes. (The backup engine and its exclusion rules are `apps/desktop/src/backup.ts` / `restore.ts`; the CLI commands land with the §21 packaging surface — see [`docs/reference.md`](reference.md).) Excluded by exact path rules, and why: `keys/` directories under `engines/` (slot keystores), `.credentials.json` (Claude Code sessions), `auth.json` (Codex credentials), `opencode.db` (OpenCode credentials), `*.key`, `.salt`, and lock files. **A backup archive must never contain a credential** — that is the point of the two custody classes; excluded entries are reported by name only, and a restore drill scans the extracted tree for credential files. Retention: operational logs 30 days, delivery evidence 90 days, decisions kept; cleanup never touches slot homes.

## Vendor terms, in plain words

The five hard rules (§5.11), and what they mean for you:

1. **Unmodified binaries.** MEC runs the vendor CLI you installed, as published, through its documented headless interface. No patching, proxying or re-implemented clients.
2. **Your credentials, their flow.** Sign-in completes inside the vendor's own flow. MEC never collects, stores or intermediates a Claude.ai or ChatGPT credential.
3. **No cross-vendor subscription use.** A Claude subscription is used only through Claude Code. OpenCode and Codex slots use API keys or their own vendor's subscription — never a Claude login.
4. **Ordinary, individual usage.** Subscription limits assume one person's normal use. MEC's caps default low and pace by reported utilisation; for sustained parallel work, use API-key slots.
5. **One human, one subscription per slot.** No pooling, no sharing, no running other people's requests from a subscription slot.

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Slot shows `degraded` / `auth_expired` | The vendor OAuth session in that slot's home expired (or was revoked) | Click **Sign in again** on the slot card or the inbox card and complete the vendor's own login flow in the terminal card. Affected attempts park `auth_required` and resume automatically once the probe reports healthy — nothing switches slots silently. |
| Attempt parked `quota_wait` | The slot hit a provider usage limit (Claude five-hour/seven-day window, ChatGPT window, GLM credit window, Gemini per-minute/per-day) | With a reported reset time, parked attempts resume automatically at reset. With `unknown` (GLM), resume on the next healthy probe or an explicit user action. To continue sooner: use the explicit **Switch slot** action — same worktree, new attempt, recorded handoff. |
| Nothing in inbox but no work starts | (a) setup incomplete — no slot or repository; (b) the work item is **held** by you; (c) every runnable attempt is parked and the stage is *Waiting for quota* | Run `mec status`: exit 3 means waiting for setup (add a slot, register a repository). In the Work view check the stage: *Held by you* lifts only when you say go; *Waiting for quota* unblocks at the reset time shown. |
| Second `mec` refuses to start | The directory lock: one writer per state directory (`mec: another process owns <dir>`) | Stop the first instance (`mec stop`) and start again; a lock whose owner pid is provably dead is cleared automatically. Two data directories (`MEC_DATA_DIR`) are the way to run two instances. |
| Login card times out | Logins are bounded at ten minutes; cancel or timeout kills the process group and the slot returns to `home_ready` with nothing half-written | Start the login again; use the card's assisted buttons (*Open sign-in page*, *Copy code*, *Paste code*) when your engine version offers them. Only one login runs at a time — vendor CLIs share fixed callback ports. |
| CI green but merge card says `ci_failed` | The merge leg reads checks from GitHub before spending your approval and requires **every** check `gh pr checks` reports to be state `SUCCESS` — a skipped/neutral check, or a check whose name/context does not match the protection rule exactly (e.g. `check` vs `ci / check`), reads as failed | Run `gh pr checks <pr>` yourself to see exactly what the card saw; make every reported check genuinely `SUCCESS` (re-run skipped/neutral ones, fix the protection context) and answer the card again. The approval is not spent on a merge that could not run. |
| `doctor` reports sandbox missing | Claude Code's Bash sandbox on Linux needs `bubblewrap` and `socat`, and they are not installed | Install `bubblewrap` and `socat`, then re-run. Policy decides what a missing sandbox means per repo: `required` fails the attempt, `preferred` degrades to permission prompts. (The automated check in `mec doctor` is still being wired — see [`docs/fault-suite.md`](fault-suite.md); macOS uses the built-in Seatbelt profile.) |

For what each fix path has proven in a real run, see [`docs/log/HANDSHAKES.md`](log/HANDSHAKES.md) and the per-row evidence in [`docs/fault-suite.md`](fault-suite.md).
