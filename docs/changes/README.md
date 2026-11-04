# Change records

For substantial work, use one folder per change, named NNN-short-title or the
existing issue ID. A single change.md is enough for a modest change. Add
separate spec.md, plan.md, and verification.md only when their size warrants it.

Record observable acceptance criteria, compatibility requirements, affected
components, dependencies, implementation steps, and actual verification.
The extracted kit contains CHANGE.md, TASK.json, and VERIFICATION.md templates.

Small fixes may use the existing issue/PR workflow. If the project already
uses OpenSpec, Spec Kit, or another durable planning system, keep that system
as canonical and link it here instead of creating competing records.

Current behavior belongs in current architecture/spec docs. Proposed changes
remain labelled as proposed until they are implemented and verified.

## This repository

Change records live in `docs/changes/<change-id>/` (`CHANGE.md` + `VERIFICATION.md`) for substantial agent-driven work, adopted 2026-11-04. They complement — never replace — the canonical records: gates → `docs/log/HANDSHAKES.md`, releases → `docs/CHANGELOG.md`, owner decisions → `docs/DECISIONS.md`, verified/fakes/absent → `docs/STATUS.md`. History before the adoption convention lives in those canonical files and the git log.
