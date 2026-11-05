# Evidence and planned validation

5 November 2026 · source base `a102313` · planning only. No test, mutant, build, model turn, PR, merge, release or reinstall was executed for this plan. Read-only source investigation is evidence of wiring/gaps, not proof of live behavior. Historic baselines do not verify a new candidate.

## Evidence classes

- **Source-proven:** exact file/line paths in `research-user-journey.md` and the runtime/observability research reports linked by CHANGE.md. Source claims describe the inspected revision only.
- **Observed installed UI:** earlier computer walkthrough saw Settings blank the whole shell (`TypeError n.find is not a function`); Work titles as IDs and detail loading persisting about two minutes; Chat planning with zero tasks; API-key-only Add slot entry; Setup navigation/numbering inconsistency. Clear removed reply context immediately but reload restored it. No claim of candidate reproduction or saved screenshot files.
- **Observed positive subset:** empty Needs you; light Chat/dark Work and Slots; slash composer focus, Escape → G/W navigation; Escape closes Work details and returns focus; Cmd+K opens/Escape closes; Auto theme restored. Not the full keyboard/theme matrix.
- **Not exercised:** model request, launch/completion, five Settings tabs (blocked by crash), Setup Finish, credential entry, approvals/questions, quota/auth switch, deletion/retirement or release. No sends/store/config submissions; transient UI selections/themes occurred.
- **Remote guardrails:** prior read-only GitHub queries on 5 November returned nine strict required checks, no required human reviews/rulesets, linear history, force push/delete forbidden, auto-merge off. Copilot COMMENTED review observed on merged PR #23. Recheck before release rather than treating this as permanent state.

## Planned commands — not results

Builder/verifier run these as appropriate to their owned slice after execution authorization:

```sh
pnpm check
pnpm test:a
pnpm test:b
pnpm exec vitest run apps/web apps/desktop
pnpm exec vitest run packages/meta packages/runtime packages/store
pnpm exec vitest run packages/domain packages/policy packages/integration packages/scorecards
pnpm build:desktop
pnpm pack:internal
python3 tools/repo-kit/run.py verify
```

Within `apps/web`: `pnpm exec tsc --noEmit` and `pnpm test:screens`. Use `pnpm exec biome check <explicit-touched-paths>` for focused lint. Full `pnpm check` remains required before deploying while CI/protections are unchanged. Do not duplicate full successful gates without a changed candidate or unresolved concern.

Accessibility and mutation automation are not established by the inspected tooling. The implementing agent must add a concrete minimal runner or document exact targeted semantic mutations before claiming these pass; do not invent a `test:mutants` script. No real-engine invocation until quota/environment/slot authority is agreed. Existing gated `MEC_REAL_*` tests remain separate; no credentials may be read to construct their invocation.

## Required meaningful regression cases

| Concern | Regression must fail before repair | Independent acceptance evidence |
| --- | --- | --- |
| Real HTTP/view contracts | Current prompts/models/questions shapes fail the actual consumer; missing `/api` returns HTML; render error takes shell down | Packaged real HTTP server + browser; JSON errors and recoverable pane; no fixture substitution |
| Repo and message authority | Missing/mismatched repo, wrong selected work, Clear repopulation, changed retry target/key, rapid Enter, stale draft | Two scratch repositories, concurrent work, navigation/reload and uncertain-response retries; no cross-repo mutation |
| Worker orchestration | Enqueue-only work never starts or lacks result; stale claim/replay can start twice; blocked dependency starts prematurely | Real bounded request through meta→worker→checks→result, observing actual records/process behavior; injected crash/restart; exactly one effect |
| Human actions | Wrong question/effect target, stale plan/SHA, duplicate/expired answer, unintended hold release, stopped work resume | Questions and approvals retain exact identity; stop/hold/pause distinctions match spec; independent replay/concurrency evidence |
| Read models and privacy | Secret-shaped payload survives snapshot/event/artifact; unbounded history; unsafe artifact path; false zero/missing cost | Redaction before write and before response; bounded paging/replay; path confinement; source-linked fields and honest unknown |
| Configuration/readiness | Finish with unusable prerequisites, fake prompt save, stale save overwrites draft, unapproved policy application | Scratch first run through second repo; durable reload; stale revision refusal; owner apply and preserved drafts |
| Installed delivery | Package version mismatch or source-only fix; PR announced before checks, merge inferred from call | Versioned artifact smoke, hard refresh, end-to-end installed journey; GitHub confirms actual PR/merge state |

Mutants target these safety semantics: remove repo matching, allow duplicate claim/action, bypass stale-generation/revision/expiry, release held work on status, resume stopped work, remove redaction/path confinement, infer completion from process exit. A meaningful check must detect the deliberate mutation; do not count an implementation-mirroring assertion as evidence.

## Evidence ledger to populate during execution

For each PR: base/candidate/merged SHA; implementer and separate verifier identity; exact failing and passing regression commands/outcomes; mutants and detection results; existing/new failures; real versus synthetic evidence; screenshot paths in both themes; accessibility and keyboard results; current flag/capability state; card/PR/check/release references; installed version and post-install outcome; recovery exercised or limits. All currently **pending**.

Do not persist customer/private traces, slot identities/fingerprints, raw messages or credentials. Screenshots must be privacy-swept before saving. Reports expose concise redacted decisions and reports, not private chain of thought. A mocked test never establishes a real-engine gate.


## Full visual overhaul prototype walkthrough — 5 November

The parent coordinator visually inspected the standalone synthetic prototype through CUA at `http://127.0.0.1:54318/ui-overhaul-preview.html`. Observed: improved Conversation request headline and actual-model/connection detail; consistent light/dark Work hierarchy; Settings hides the task inspector and irrelevant Details action; Needs you enters without stale task detail; Inspect opens push-approval evidence titled for the tested branch on sample commit `7b34c91`. Final view was default Conversation with Overview inspector.

A final source correction resets task/approval scope to Overview and shows checks-not-run for the in-progress task; that last correction was not broadly regression-tested after reload. This is limited visual prototype review, not production behavior proof or a full interactive test pass. No screenshot files were saved. No production tests, axe/Lighthouse, viewport/responsive matrix or accessibility checks ran. The prototype uses synthetic data, makes no network calls and changes no installed product state.
