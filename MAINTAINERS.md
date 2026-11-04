# Maintainers

- **Shankha** — [@MubitLabs](https://github.com/MubitLabs). Answers issues and reviews PRs, best
  effort, usually within a week. No SLA ([SUPPORT.md](.github/SUPPORT.md)); security reports go
  through [SECURITY.md](.github/SECURITY.md), conduct reports through
  [CODE_OF_CONDUCT.md](.github/CODE_OF_CONDUCT.md).

## Review model during the one-operator phase

- **Every PR is cross-reviewed** (implementation plan §7.2): during the one-operator phase the
  reviewer is an agent instance that did **not** write the change — a fresh context, never the
  author's own. The review is recorded in the PR: which instance reviewed, and what it checked.
- **GitHub required-review is OFF.** A required approving review can only come from a second
  GitHub identity, which does not exist yet; requiring it would either block every PR or force a
  rubber-stamp second account. This is deliberate and documented here. The gates that hold today:
  CI (`pnpm check`) plus the recorded cross-review above.
- When a second maintainer identity exists, turn branch protection's required review on (one
  approval, CODEOWNERS) and retire this note.
