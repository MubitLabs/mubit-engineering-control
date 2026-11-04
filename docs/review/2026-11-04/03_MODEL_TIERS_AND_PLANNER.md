# Model tiers, capability-aware planning, and the real planner

Design for items 4 and 5 of the 4 November request, written against the repo at `e5ae484`. It replaces the v0 meta brain (`packages/meta/src/real-brain.ts`) with a planner that knows what each slot can run, chooses a **tier** per task from a user-editable **capability table**, passes the choice to the engine through the engine's own documented mechanism, lets specialists spawn their own subagents under the same tier policy, and reads everything it says from editable prompt parts rather than code constants. Vendor facts were verified on 4 November 2026 (sources at the end); every fact is also re-probed on the user's machine because these move monthly.

## 0. The idea in one paragraph

A **tier** is a named rung on a ladder — `fast`, `balanced`, `strong`, `frontier` — that the planner reasons about instead of model ids. A **capability table** (`~/.mec/models.yaml`, shipped default, user-editable) maps each tier to concrete `(engine, provider, model, effort)` choices with the facts that matter for choosing: relative speed and cost, context size, what the vendor says it is for, and which slots can run it. The planner reads the table and the live slot health in its context, writes a `tier` (or an explicit `model`) and an `effort` on every task it proposes, and may hand a specialist a **subagent policy** (what tiers its own subagents may use, and how deep). The runtime turns `tier + slot` into the engine's flags — Claude `--model opus --effort high`, Codex `-m gpt-6-luna -c model_reasoning_effort=low`, OpenCode `--model zai-coding-plan/glm-5.3-flash` — and records the resolved model on the attempt and in the scorecard, so the next plan can learn which tier earned its keep. Nothing in the table is a secret, nothing in it is a credential, and the meta agent cannot edit it.

## 1. What exists today, and the gap

| Spec (§6, §7, §16) | In the repo | Gap |
| --- | --- | --- |
| Context compiler: history, stages, confirmations, holds, budgets, slot health and utilisation | the turn sees the message text and `workItemId (stage)` pairs | everything else |
| Platform tools: nine, incl. `route`, `ask_user`, `spawn_agent` with slot hint, `read` | three executed (`acknowledge`, `propose_plan`, `report_result`); the rest answer `{ok:true}` | six tools |
| Task brief: original request verbatim, owned paths, acceptance checks, budget, slot class | `objective` + `depends_on` + optional `role`; one pseudo-check | model/tier, effort, owned paths, checks, budget |
| Model selection | none; `--model` pushed only if an input carries it; Codex ran `gpt-5.6-sol`, OpenCode `glm-4.7` and `gemini-2.5-flash` because they were the defaults at hand | the whole tier layer |
| Specialists' own subagents | Claude Code specialists inherit the session model for any subagent they spawn; Codex `ultra` and OpenCode `subagent` permission are unconstrained | a per-attempt subagent policy |
| Prompt parts on disk, editable, revisioned | none; `META_PROTOCOL_TEXT` is a constant | all of §16's surface |

Two of the defaults used in real recordings are already stale: Z.ai routes `glm-4.7` to GLM-5.3-Flash, and Google lists `gemini-2.5-flash` as legacy with access limited to prior users. A table re-probed on install is the only durable answer.

## 2. The tier ladder

Four tiers, deliberately few. The names are what the planner, the UI and the scorecards speak; the models behind them are data.

| Tier | Meaning for the planner | Default use |
| --- | --- | --- |
| `fast` | cheapest and quickest; follows instructions well; shallow reasoning | mechanical edits, renames, lint fixes, file moves, test scaffolding from a template, summaries, triage, the specialist's own subagents for lookups |
| `balanced` | the daily driver: good code, good judgement, moderate cost | implementers on clearly scoped tasks, test authors, repair agents, most reviews |
| `strong` | deep reasoning, long horizon, higher cost; used where correctness is the point | architecture-touching implementation, security review, hard repairs, mid-merge conflicts, PR review of large changes |
| `frontier` | the hardest, longest work; may bill credits beyond plan limits; slow | root-cause investigations across a codebase, design decisions with many constraints; never by default — the user pre-authorises per repo or per request |

Effort is orthogonal: each tier carries a default effort and the planner may raise or lower it with a reason (`fast/medium` for a mechanical edit that must not drift; `strong/max` for a security pass the policy marks blocking).

## 3. The capability table (`~/.mec/models.yaml`)

Shipped as a default under `packages/prompts/defaults/models.yaml`, copied to `~/.mec/models.yaml` on first run, editable in Settings → Models with the same provenance and *Default updated* flow as prompt parts (§16.3). Agents never write it; its hash is recorded with every plan. The shipped default as of 4 November 2026:

```yaml
version: 1
tiers: [fast, balanced, strong, frontier]

engines:
  claude:
    # Claude Code aliases resolve per provider; on the Anthropic API/subscriptions today:
    # opus → Opus 5.5 (the plan default), sonnet → Sonnet 5.5, haiku → Haiku 5.5; fable → Fable 5.1.
    # Anthropic's own cost guidance: Sonnet for most coding, Opus for architecture and multi-step
    # reasoning, Haiku for simple subagents, lower effort for simple tasks (code.claude.com/docs/en/costs).
    select: { flag: "--model", effort_flag: "--effort" }
    effort_levels: [low, medium, high, xhigh, max]       # per model; probe confirms; 'medium' is the 5.5-family default
    models:
      haiku:   { tier: fast,     effort: medium, speed: 4, cost: 1,  context: 1m, output: 128k, api_usd_per_mtok: [0.10, 0.50],
                 vendor_says: "fast and efficient, for simple tasks; meant as a subagent beside Opus and Sonnet" }
      sonnet:  { tier: balanced, effort: medium, speed: 3, cost: 3,  context: 1m, output: 128k, api_usd_per_mtok: [2, 10],
                 vendor_says: "latest Sonnet, for daily coding tasks" }
      opus:    { tier: strong,   effort: high,   speed: 2, cost: 5,  context: 1m, output: 128k, api_usd_per_mtok: [4, 20],
                 vendor_says: "latest Opus, for complex reasoning tasks; clearly stronger on open-ended work" }
      fable:   { tier: frontier, effort: high,   speed: 1, cost: 8,  context: 1m, output: 128k, api_usd_per_mtok: [10, 50],
                 bills: "credits on Pro; up to 50% of the weekly limit included on Max/Ultra",
                 vendor_says: "for the hardest and longest-running tasks" }
    # Subscriptions also carry per-family windows ("Opus limit", "Sonnet limit"): a parked attempt on one family
    # may continue on another family of the same slot — the planner sees rate_limit_type seven_day_opus/sonnet.
    subagents:
      mechanism: agents_file            # per-attempt --agents <file>; frontmatter model/effort per subagent
      depth_var: CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH
      force_vars: [CLAUDE_CODE_SUBAGENT_MODEL, CLAUDE_CODE_SUBAGENT_MODEL_FORCE]

  codex:
    select: { flag: "-m", effort_override: "-c model_reasoning_effort=\"<level>\"" }   # -c values are TOML: quote strings
    effort_levels: [low, medium, high, xhigh, max, ultra]  # 'ultra' = parallel subagents, not deeper thinking; not on Luna
    models:
      gpt-6-luna:   { tier: fast,     effort: low,    speed: 4, cost: 1,
                      vendor_says: "focused, high-volume tasks: summarising, extraction, focused coding; fastest and cheapest" }
      gpt-6.1-terra:{ tier: fast,     effort: medium, speed: 4, cost: 2, requires_cli: ">=0.159.0",
                      vendor_says: "fast, efficient writing, visual understanding, computer use" }
      gpt-6.1-sol:  { tier: balanced, effort: medium, speed: 3, cost: 3, context: 500k,
                      vendor_says: "near-Astra results for repeated, long-running work at lower cost" }
      gpt-6-astra:  { tier: strong,   effort: high,   speed: 2, cost: 5,
                      vendor_says: "hardest end-to-end work across code, apps and research; Max for one hard problem, Ultra when the work parallelises" }
    subagents:
      mechanism: config                 # subagents are on by default (agents.enabled / features.multi_agent):
      keys: [agents.default_subagent_model, agents.default_subagent_reasoning_effort, agents.max_concurrent_threads_per_session]
      catalogue: "$CODEX_HOME/agents/*.toml"   # name, description, developer_instructions, model, model_reasoning_effort
      ultra: "only when the policy allows subagents"

  opencode:
    select: { flag: "--model", syntax: "provider/model#variant" }   # variants per model catalog; probe lists them
    providers:
      zai-coding-plan:
        # credit multipliers (input/cached/output per 10k tokens): glm-5.3 = 6.9/1.7/24; glm-5.3-flash = 2.3/0.56/8
        # glm-5.2 and glm-5.1 route to glm-5.3; glm-4.7 routes to glm-5.3-flash. Off-peak (outside Mon–Fri 14:00–18:00 UTC+8) is half price.
        # effort variants #low | #high | #max (default max; Z.ai recommends max for coding)
        models:
          glm-5.3-flash: { tier: fast,     variant: high, speed: 4, cost: 1, context: 1m, output: 128k,
                           vendor_says: "the Flash model; multimodal; about three times cheaper in credits than GLM-5.3" }
          glm-5.3:       { tier: balanced, variant: max,  speed: 3, cost: 3, context: 1m, output: 128k,
                           vendor_says: "the flagship, for long-horizon coding" }
        # no 'strong' on this provider: the planner uses it for balanced/fast work and for provider-diverse review
      google:
        # variants map to thinkingLevel: low | medium | high (Flash-Lite adds minimal); 2.5 models reroute on 1 Dec 2026
        models:
          gemini-3.5-flash-lite: { tier: fast,     variant: low,    speed: 4, cost: 1, api_usd_per_mtok: [0.30, 2.50],
                                   vendor_says: "fastest, most cost-effective; high-throughput" }
          gemini-3.8-flash:      { tier: balanced, variant: medium, speed: 3, cost: 2, context: 1m, api_usd_per_mtok: [0.75, 3.75],
                                   vendor_says: "most intelligent Flash; long-horizon coding and agents" }
          gemini-4-argon:        { tier: strong,   variant: high,   speed: 2, cost: 5, context: 1m, free_tier: false, api_usd_per_mtok: [2, 10],
                                   vendor_says: "flagship reasoning model" }
    subagents:
      mechanism: agents_config          # agents.<name>.model = "provider/model#variant", mode: subagent; the `subagent` permission allows or denies spawning

routing:
  # which tier each built-in role asks for by default; the planner may override per task with a reason
  roles:
    implementer:      { tier: balanced }
    test_author:      { tier: balanced }
    code_reviewer:    { tier: balanced, prefer: different_provider }
    pr_reviewer:      { tier: strong,   prefer: different_provider }
    security_checker: { tier: strong,   effort: max }
    integrator:       { tier: balanced }
    repair_agent:     { tier: strong }
    release_agent:    { tier: fast }
    meta_agent:       { tier: strong,   effort: high }
  # specialists' own subagents: the ceiling they may spawn, and how deep
  subagents:
    default: { max_tier: fast, depth: 1 }
    repair_agent: { max_tier: balanced, depth: 1 }
    security_checker: { max_tier: balanced, depth: 1 }
  frontier: { requires: preauthorised }   # confirmation class; never autonomous
```

Rules the table encodes and the code enforces:

1. **Tiers are relative within a provider.** `strong` on GLM does not exist, so a `strong` task placed on a GLM slot degrades to `balanced` and the attempt records `tier_degraded: strong→balanced (provider has no strong)`; the planner is told in its next context. Cross-provider "equivalence" is never claimed in code — the `vendor_says` strings are the vendor's words, shown verbatim in the UI, and the scorecards are the only comparison MEC makes.
2. **Probe before trust.** On slot creation and after every engine upgrade, the probe lists what the installed engine actually offers (`claude --model` acceptance per alias; Codex `/model` catalogue via app-server `model/list`; OpenCode `opencode models` and the catalog's variants) and marks table entries `available`, `unavailable` or `unlisted` per slot. The planner only sees available ones.
3. **Cost is a number the user can see, not a promise.** `cost` is a relative index per provider; API-key slots add real spend from the engine's `usage` events; subscription slots add utilisation. Both land on the task card.
4. **The user edits, the agent proposes.** The table is a prompt part in all but name: same revisions, same *Default updated* diff, same proposal area. The setup agent (§7) edits it through the same API the Settings page uses.

## 4. How a tier becomes engine flags

The runtime owns this (`packages/runtime`), not the adapters' callers: `resolveModel(brief.model_request, slot, table) → { model, effort, argv_additions, env_additions, subagent_config }`, recorded on the attempt as `resolved_model`.

| Engine | Model | Effort | Specialist's own subagents |
| --- | --- | --- | --- |
| Claude Code | `--model <alias or id>` (`haiku`, `sonnet`, `opus`, `fable`, `sonnet[1m]`…); a `claude-glm` slot maps aliases via `ANTHROPIC_DEFAULT_*_MODEL` instead | `--effort` with `low`, `medium`, `high`, `xhigh` or `max` (defaults: `medium` on the 5.5 family, `high` elsewhere; unsupported levels fall back) | a per-attempt `--agents <file>` written by the runtime: one entry per allowed subagent role with `model` and `effort` from the policy, `tools` limited to the role's allowlist; `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` from the policy (`1` disables nesting); `CLAUDE_CODE_SUBAGENT_MODEL` + `_FORCE=1` when the policy says "only this tier"; `Agent(...)` entries in `--disallowedTools` for roles the policy forbids |
| Codex | `-m <id>` (`gpt-6-luna`, `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6.1-terra` ≥0.159) or `model` in `thread/start` on the app-server | `-c 'model_reasoning_effort="<level>"'` with `low`, `medium`, `high`, `xhigh` or `max` (TOML-quoted); `ultra` only when the policy allows subagents | Codex subagents are on by default: the runtime writes the slot's `config.toml` overrides per launch — `agents.enabled`, `agents.default_subagent_model`, `agents.default_subagent_reasoning_effort`, `agents.max_concurrent_threads_per_session` — and a `$CODEX_HOME/agents/<role>.toml` per allowed subagent role (`model`, `model_reasoning_effort`, `developer_instructions`); `agents.enabled = false` when the policy says no subagents |
| OpenCode | `--model provider/model#variant` on `run`, or `model: {providerID, id, variant}` on `POST /api/session`; variants come from the catalog (GLM `low`/`high`/`max`; Gemini `low`/`medium`/`high`, Flash-Lite adds `minimal`) | the `#variant` | `agents.<name>` entries with `mode: subagent` and a pinned `model: "provider/model#variant"` in the slot's `opencode.json` for each allowed role; the `subagent` permission action `allow`s or `deny`s spawning; a subagent without a model inherits the parent, so every allowed role is pinned |

The adapter contract gains one optional field on `LaunchSpec`: `model: { id, effort?, variant? }` and one on `AttemptBrief`: `model_request: { tier?, model?, effort?, reason }` — both nullable, both appended under CONTRACTS §10 as `contracts-v0.1` with a fixture update (the smoke fixtures record which model ran).

## 5. The planner: what the meta agent sees, says and does

### 5.1 Context compiled per turn (replaces the two-line context)

```
<state>
  conversation: the last N messages with their routing (new work / attached to wi_… / conversation), acknowledgements
  work: every open work item with stage, tasks (role, tier, slot, state, head sha), open questions, holds, blockers
  confirmations: pending cards with class and expiry
  slots: id · engine · provider · state · utilisation (or unknown) · reset time · available tiers
  budgets: remaining turns/wall-clock/spend per work item; today's spend per API slot
  policy: caps, pre-authorised classes, pairs, frontier allowed?, policy hash
  models: the capability table, available entries only, with vendor_says and relative speed/cost
  scorecard hints: for this repo, per role×tier: success rate, repair rate, mean wall-clock (unknown until data exists)
</state>
```

The compiler is deterministic code in `packages/meta/src/context.ts`; its output is bounded (sizes in the plan §6) and pinned to the turn's bundle revision.

### 5.2 The tool set (all nine, executed)

```
acknowledge(message_id, text)
route(message_id, decision: new_work | attach(wi) | stop(wi) | hold(wi) | release(wi) | conversation, note?)
propose_plan(work_item, tasks[])           task = { id, objective, original_request_ref, owned_paths[],
                                                    acceptance_checks[], depends_on[], role,
                                                    model_request: { tier | model, effort?, reason },
                                                    slot_hint?: { class | slot_id }, budget?,
                                                    subagent_policy?: { max_tier, depth } }
spawn_agent(task, role, model_request?, slot_hint?)       — for ad-hoc work outside a plan (bounded by caps)
ask_user(question, for_message_id?, options?)
request_confirmation(operation, evidence)   — incl. class 'frontier_model' when a task asks for frontier
report_result(work_item, summary, artifacts)
read(resource, cursor?)                     — work_item/…, task/…, attempt/…/report, slots, models, scorecards/…
stop_agent(attempt) / cancel_task(task)
```

Validation stays deterministic (`packages/domain`): graph validity, caps, mandate, budget, **tier availability on at least one healthy slot** (else a repair issue naming the alternatives), **frontier only with pre-authorisation**, subagent policy within the role's ceiling. Four invalid proposals escalate, unchanged.

### 5.3 Planning rules (prompt text, editable — shipped in `roles/meta_agent/planning.md`)

> Choose the cheapest tier that the task's risk allows, and say why in `reason`. Mechanical work is `fast`. Work with a clear scope and existing tests is `balanced`. Work that touches interfaces, concurrency, security, data migration, or that a previous attempt failed is `strong`. `frontier` needs the user's pre-authorisation; propose it only when the task is an investigation whose cost of being wrong is high, and say what a `strong` attempt would miss. Reviews prefer a different provider than the implementer; the security checker runs `strong` at `max` effort when policy marks its findings blocking. Give a specialist a subagent policy only when its task has separable lookups; subagents are `fast` by default. When a slot is above its utilisation ceiling, place elsewhere or say the work waits. Record every tier choice; the scorecard will tell us next week whether it was right.

### 5.4 The specialist's side

Every specialist brief now carries `model_request`, `resolved_model` (after the runtime resolves it), `subagent_policy`, and the role's shipped instructions. The specialist's own prompt part says what it may spawn: for Claude Code, the runtime's `--agents` file is the only subagent catalogue the engine sees (`lookup` on `fast`, `test_runner` on `fast`, `reviewer` on `balanced` when allowed), with depth from the policy. A specialist that needs a stronger model than its brief allows does not switch models; it reports `blocked` with `needs: tier strong` and the planner re-plans — the same discipline as asking for a wider scope.

### 5.5 Learning without experiments (R1 scope)

The scorecard already records per-attempt outcomes; add `tier`, `resolved_model`, `effort`, `tier_degraded`, `spend` and `utilisation_delta`. A nightly projection builds `scorecards/tiers` per repository: role × tier → success rate, repair rate, review findings, wall-clock, cost. The planner reads it as hints (unknown until five attempts exist); the Models settings page shows it beside each table row. R4's experiments consume the same rows.

## 6. Prompt system: modular, editable, on disk (item 5)

### 6.1 Layout (§16, now with the model table and the meta agent's parts)

```
~/.mec/prompts/
  shared/communication.md       voice, attention rule, 100-word ceiling, never ask for secrets
  shared/scope.md               when to stop with a draft (§7)
  shared/delivery.md            PR evidence, commit identity, UI evidence, review budget
  roles/meta_agent/protocol.md  the turn protocol (tools, order, what a valid turn is)
  roles/meta_agent/planning.md  §5.3 above: tiering, placement, questions, routing
  roles/implementer.md … roles/release_agent.md   one file per built-in role
  roles/subagents/lookup.md, test_runner.md, reviewer.md   the catalogue specialists may spawn
  engines/claude.md, codex.md, opencode.md        engine-specific notes (tool names, reporting)
  conventions.md                imported from the repo's AGENTS.md/CLAUDE.md, then edited
  skills/<name>/SKILL.md
  models.yaml                   the capability table (§3)
  revisions/                    immutable snapshots: <n>.json = full config + base + origin + time
```

Each file has a shipped default in `packages/prompts/defaults/` with the same path; an override records `defaultBaseHash`; the assembled bundle per attempt is `shared → role → conventions → delivery → engine → skills → generated` (environment, slot health, policy, models) — generated last so caches stay warm.

### 6.2 The API and the two surfaces

`GET/PUT /api/prompts` (config + revision; 409 on a stale base), `GET /api/prompts/defaults`, `GET /api/prompts/revisions/:n`, `POST /api/prompts/preview` (assemble a role's full text without saving), `GET/PUT /api/models` (the table, same mechanics), `GET /api/prompts/changes` (parts whose default changed since the override: old default, new default, user text).

- **Settings → Prompts** (human): a part list grouped by layer with *changed* and *Default updated* marks; an editor with the default beside the text; *Keep mine* / *Use new default* / *Reset*; a *Full prompt* tab that shows the assembled text for a chosen role and engine; *History* with diffs. One save bar per block, visible only with a draft.
- **The setup agent** (§7) edits through the same API, so a change made in chat and a change made in the editor are the same kind of revision with origin `agent` vs `panel`.

### 6.3 Tests that keep it honest

Model-surface test: every role's assembled text validates against the tool schemas it names and stays within its size budget; the built-in text states each rule the code enforces (length ceilings, report vocabulary, "never ask for secrets", the tier rules). A shipped default that drifts from the schema fails CI, not the user.

## 7. The setup agent (item 5)

A `setup_agent` role on the meta agent's slot, reachable from Chat (an "Setup" mode toggle) and from `mec setup` in the terminal, with its own prompt part (`roles/setup_agent.md`) and a tool set that is the Settings API plus the slot CLI's safe subset:

```
read(settings | slots | repositories | prompts | models | policy | status | doctor)
propose_change(target: prompts|models|policy|repository, patch, reason)   → a draft the user applies with one click (or `yes` in chat)
apply_change(draft_id)                                                    → only after the user said yes in this conversation
open_login_card(engine, label) / open_key_form(provider, label)          → the workbench opens the card; the agent never sees a credential
register_repository(url_or_path, bootstrap, checks, trust)
set_meta_slot(slot_id)
run_doctor()
```

Its working rules come from dsh-superagent's SETUP.md and are shipped as prompt text: one question per message with a recommended one-word answer; never a secret in chat; read `doctor` first and skip what it answers; one plan message, then execute after confirmation; after any change, show the resulting diff of the part and offer to revert. The same agent handles *changes* later ("make reviewers always use a different provider", "stop using frontier", "raise the implementer's budget") — each becomes a `propose_change` draft with the diff visible in the inbox, applied by the user. Policy, prompts and the model table therefore have exactly one write path: a revision with an origin.

Two guards: the setup agent can never pre-authorise a confirmation class or widen caps without the draft being shown as a confirmation card of class *policy change*; and it runs on `fast` or `balanced` by default — it is a form-filler with manners, not a planner.

## 8. Implementation plan (two weeks, one engineer + agent)

| # | Work | Files | Days |
| --- | --- | --- | --- |
| T1 | `models.yaml` schema (Zod), shipped default, loader with provenance; `GET/PUT /api/models`; probe-driven availability marks per slot | `packages/prompts/src/models.ts`, `defaults/models.yaml`, `packages/slots/src/model-probe.ts`, server routes | 2 |
| T2 | `resolveModel()` in the runtime; `LaunchSpec.model`, `AttemptBrief.model_request` (`contracts-v0.1` + fixture update); Claude `--model/--effort`, Codex `-m/-c`, OpenCode `#variant`/session model; `resolved_model` on the attempt | `packages/runtime/src/model.ts`, `packages/engines/src/*/argv.ts`, `packages/contracts` | 2 |
| T3 | Subagent policy: Claude `--agents` file writer + depth/force env + `Agent(...)` denies; Codex `ultra` gate; OpenCode `subagent` permission + pinned agent models | `packages/runtime/src/subagents.ts`, adapters | 1.5 |
| T4 | Prompt parts on disk: defaults directory, loader, overrides with `defaultBaseHash`, revisions, `Default updated`, preview, API; move `META_PROTOCOL_TEXT` into `roles/meta_agent/protocol.md`; write the eight role defaults + shared parts + subagent catalogue (the text itself is the main work) | `packages/prompts/src/{store,loader}.ts`, `defaults/**`, server routes | 3 |
| T5 | Context compiler + the nine tools executed for real + validation of tier/frontier/subagent policy; wakes for specialist reports; `route` for follow-ups, stop, hold | `packages/meta/src/{context,brain,tools}.ts`, `packages/domain` | 3 |
| T6 | Scorecard tier fields + nightly `scorecards/tiers` projection + planner hints | `packages/scorecards` | 1 |
| T7 | Setup agent role, tools, drafts as confirmation cards, `mec setup` | `packages/meta/src/setup-agent.ts`, server, CLI | 2 |
| T8 | Tests: model-surface over real text; tier validation; resolve fixtures per engine (the smoke recordings now assert `resolved_model`); a real-engine canary that runs one `fast` and one `balanced` attempt and checks the engine's reported model | — | 1.5 |

Acceptance: a request produces a plan whose tasks carry tiers with reasons; a `fast` task runs on Haiku/Luna/Flash and the attempt shows it; a review runs on a different provider; a specialist's subagent on Claude runs on the policy's tier (visible in the engine's `agents` events); the user edits `roles/implementer.md` in Settings and the next attempt's pinned bundle contains the edit; the setup agent changes the reviewer's tier through a draft the user applies.

## Sources (verified 4 November 2026)

- Claude Code model configuration — aliases, what they resolve to, effort levels per model and defaults, `ANTHROPIC_DEFAULT_*_MODEL`, `MAX_THINKING_TOKENS`, Fable billing to credits: https://code.claude.com/docs/en/model-config
- Claude Code subagents — frontmatter `model`/`effort`, resolution order, `CLAUDE_CODE_SUBAGENT_MODEL(_FORCE)`, nesting depth `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, `--agents` JSON/file, `Agent(...)` denies: https://code.claude.com/docs/en/sub-agents
- Claude Code costs page — Anthropic's own guidance (Sonnet for most coding, Opus for architecture and multi-step reasoning, Haiku subagents, lower effort for simple tasks): https://code.claude.com/docs/en/costs
- Claude model ids, context (1M) and API pricing: https://platform.claude.com/docs/en/models/overview · Fable on plans: https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan · per-family limit messages: https://code.claude.com/docs/en/errors
- Codex models for ChatGPT sign-in — `gpt-6-astra`, `gpt-6.1-sol` (500K context), `gpt-6.1-terra` (CLI ≥0.159.0), `gpt-6-luna`; retirements; effort names incl. Max and Ultra (subagents): https://learn.chatgpt.com/codex/models · model selection guidance: https://learn.chatgpt.com/codex/model-selection
- Codex configuration — `-m`, `model_reasoning_effort`, `-c` overrides (TOML values), profiles: https://learn.chatgpt.com/codex/config-file/config-reference · subagents (`agents.*` keys, `$CODEX_HOME/agents/*.toml`): https://learn.chatgpt.com/codex/agent-configuration/subagents
- Z.ai GLM-5.3 and GLM-5.3-Flash model notes (effort `low|high|max`, context/output): https://docs.z.ai/guides/llm/glm-5.3 · https://docs.z.ai/guides/vlm/glm-5.3-flash
- Gemini thinking levels (`thinkingLevel` per model) and pricing: https://ai.google.dev/gemini-api/docs/generate-content/thinking · https://ai.google.dev/gemini-api/docs/pricing
- OpenCode V2 provider catalog (models.dev) for `zai-coding-plan` and `google` variants: https://github.com/sst/models.dev/tree/dev/providers
- OpenCode V2 models — `provider/model#variant`, variants from the catalog, root `model`: https://opencode.ai/v2/docs/models/
- OpenCode V2 agents and permissions — per-agent `model`, the `subagent` permission action: https://opencode.ai/v2/docs/agents/ · https://opencode.ai/v2/docs/permissions/
- GLM Coding Plan — callable models, credit multipliers, tier allowances, off-peak, legacy id routing: https://docs.z.ai/devpack/overview · https://docs.z.ai/devpack/faq
- Gemini models — current ids and positioning, legacy 2.5 access: https://ai.google.dev/gemini-api/docs/models
- The repo's own engine notes (what ran, protocol deltas): `docs/engines.md` at `e5ae484`
