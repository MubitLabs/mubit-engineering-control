# Keeping repository guidance useful

Update documentation with the code change that invalidates it. Current
architecture documents describe shipped behavior; change plans describe
proposed work. Keep that status explicit.

- Root AGENTS.md contains essential commands and non-obvious common rules.
- Nested AGENTS.md contains local invariants and commands, without copied
  root policies. Add one only when that area needs different guidance.
- Current docs link to canonical source files and tests where useful.
- Decision records capture a consequential choice, alternatives considered,
  and consequences. They are not transcripts of every discussion.
- Change records contain intent and verification for substantial work.
  Small fixes can use the existing issue/PR record instead.
- Archive finished plans with their implementation revision and outcome.
  Reconcile current docs; stale proposals must not appear to be current facts.
- Keep logs, machine-specific state, credentials, and generated caches out
  of the shared instruction files.

Prefer automated enforcement for recurring import violations, type errors,
schema drift, and formatting. In a legacy project, tighten checks in bounded
areas and record the existing baseline instead of turning checks off broadly.

## This repository

- Canonical records, one home each: owner decisions → `docs/DECISIONS.md`; gate results → `docs/log/HANDSHAKES.md`; the §26 evidence matrix → `docs/fault-suite.md`; verified/fakes/absent → `docs/STATUS.md`; releases → `docs/CHANGELOG.md`. Per-change records for substantial work → `docs/changes/<change-id>/`.
- Fixtures are records, not fixtures in the mocking sense: `recorded_by` is honesty metadata; a synthetic stays synthetic with the reason in `meta.json` until a real capture replaces it.
- The baseline (`baseline.md`) is refreshed at task handover, not on every commit.
