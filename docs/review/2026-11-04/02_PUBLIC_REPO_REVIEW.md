# Public-repository review and the one-command install

Items 2 and 3 of the 4 November request. The repository is public (Apache-2.0) but the product is for internal use; the review therefore asks two questions of every file: *does a stranger reading this understand what it is and how to run it?* and *does a colleague get from zero to a healthy slot in one command?*

## 1. What is already good

Apache-2.0 with a full LICENSE and NOTICE; a README with an honest "what is proven" table linking to evidence; `CONTRIBUTING.md` with the fixture discipline and the engine-adding recipe; `docs/STATUS.md`, `docs/fault-suite.md`, `docs/engines.md` and `docs/log/HANDSHAKES.md` — few repos state what is real this plainly; CODEOWNERS; CI on two Node versions; `.node-version`; Biome; no secrets, no credential paths anywhere in the tree (checked: `.gitignore` covers `.env*`, `.mec/`; the fixtures are redacted).

## 2. Findings, in priority order

### Must fix (a stranger is misled or blocked)

1. **The tarball has no workbench.** `scripts/pack-tarball.mjs` stages `bin/` and `dist/` only; `apps/desktop/src/server.ts` resolves the UI from `../../web/dist` relative to the bundle, which does not exist in an extracted tarball. The README's "internal tarball" path therefore starts a server with no UI. Fix: build `apps/web` in `pack-tarball.mjs`, copy it to `dist/web/`, and resolve `WEB_DIST` as `dist/web` when running from a bundle (fall back to `../../web/dist` in the repo).
2. **Quickstart is four manual commands plus a restart with an env var.** The meta slot must be passed as `MEC_META_SLOT=<path>` on a *second* start, and the UI build is a separate step. Fix in §3 below: one command, and the meta slot read from the store (`/api/wizard/meta-slot` already persists it — `serve` should read it instead of the env var).
3. **No GitHub Release and no tag.** `git tag -l` is empty; the only version is `0.1.0` in `package.json`. A public repo without a release has no installable artifact and no changelog anchor. Fix: a release workflow (§3.3) that tags, builds the tarball on both OSes, and attaches it.
4. **Branch protection and review.** 52 commits straight to `main`, no PRs, while CONTRIBUTING and CODEOWNERS describe cross-review. Protect `main`: require the `ci` workflow, require one review (CODEOWNERS), no force-push, linear history. For a one-operator phase, the reviewer can be an agent instance, but the gate should exist.
5. **Internal-only statements contradict "public".** The README says "never a public registry" and "distributed inside the company", `CONTRIBUTING.md` calls it "an internal, free-forever product", and `DECISIONS.md` #4 amends the plan to internal distribution. A public repo under Apache-2.0 needs one honest sentence at the top: *"Open source under Apache-2.0; built for Mubit's own use; no support promised; issues welcome, PRs reviewed when we can."* And decide whether `pack:internal` stays "internal" in name — if the tarball is attached to a public release, call it what it is.
6. **`CLAUDE.md` describes two named stream owners** and a date-stamped era. Replace with the five rules that apply to any contributor or agent (areas, contracts rule, spec rule, credential rule, fixture rule) and no names.
7. **`docs/known-limits.md` is stale** (Claude-only probes; OpenCode "in progress" in the README layout table) relative to `STATUS.md`. One source of truth: STATUS carries the moving record, known-limits carries the *designed* limits only (no auto-update, no compile-on-install, single user).

### Should fix (quality of a public repo)

8. **Add the standard community files** under `.github/`: `SECURITY.md` (how to report, what is in scope — the threat model already exists, link it), `ISSUE_TEMPLATE/bug.yml` asking for the `mec doctor` bundle and the engine versions, `PULL_REQUEST_TEMPLATE.md` with the fixture and §26 row checklist, `CODE_OF_CONDUCT.md` (Contributor Covenant), `SUPPORT.md` (two lines: no SLA, issues welcome), `FUNDING.yml` absent on purpose.
9. **Commit message hygiene**: several subjects exceed 600 characters. Subject ≤ 72 chars, body for the narrative; the long form belongs in `docs/log/`. A `commitlint`-style check is overkill; a line in CONTRIBUTING and a PR template is enough.
10. **`docs/plan/` naming**: the three plans have inconsistent names (`PLAN_v4.1_implementation_plan.md` is the product plan). Rename to `spec.md`, `product-plan.md`, `parallel-split.md` with the original titles inside, and add `docs/README.md` as an index: start here → spec → status → evidence.
11. **README structure for a stranger**: lead with what it is in two sentences and a 20-second screenshot or terminal capture of a delivery (ack → plan → cards → PR), then Install, then "What is proven", then the layout. The security paragraph is good; keep it. Add a "Requirements" box: macOS/Linux, Node ≥ 22.18, one of the three engines installed and signed in, `gh` for PRs.
12. **Engine-version matrix in the README** (from `docs/engines.md`): Claude Code 2.1.317, Codex 0.148.0, OpenCode 2.2.5 — the versions the fixtures were recorded on — with the date, so a reader knows what "proven" means.
13. **CI**: add a job that builds the tarball and runs `node bin/mec.js --version` and `mec doctor --json` from the extracted artifact on `ubuntu-latest` and `macos-latest` (GitHub-hosted, no secrets) — the install path tested, not just the suites. Add `pnpm audit --prod` and the compliance guard as named steps so their status is visible.
14. **Dependabot** (or Renovate) for npm with a weekly cadence, grouped; engines are *not* npm dependencies, so a scheduled "vendor re-verification" issue (plan §10) is a separate monthly reminder workflow.
15. **Repository metadata**: description, topics (`agents`, `claude-code`, `codex`, `opencode`, `orchestration`, `local-first`), the website field pointing at `docs/README.md`; disable Wiki and Projects; enable Discussions only if someone will answer.
16. **Top-level `scripts/`** holds build scripts; fine. Add `scripts/release-tarball.mjs` (or extend `pack-tarball`) and keep `bin` executable bits in git (`git update-index --chmod=+x`).
17. **`apps/web/package.json` pins React 19 / Vite 8 / TypeScript ~5.8** while the root pins TypeScript 5.9.3 — align through the workspace catalog so one `pnpm up` moves both.

### Nice to have

18. A `docs/architecture.md` with the two diagrams from the spec (§3 and the slot matrix) and one paragraph per package — the spec is 21k words and a stranger will not read it first.
19. A 90-second asciinema of `npx … → wizard → first delivery`.
20. `CHANGELOG.md` at the root (it lives in `docs/`), Keep-a-Changelog format, one entry per release.

## 3. The easiest install and first run

### 3.1 What the user types

```bash
npx mubit-engineering-control        # or: npm i -g mubit-engineering-control && mec
```

Opens `http://127.0.0.1:<port>` in the default browser on the first run, straight into Setup. That requires publishing to npm under the name the owner already reserved in spirit (`DECISIONS.md` #2 keeps `mubit-engineering-control` / `mec`); publishing a public package is compatible with "built for internal use" — it is the delivery channel, not a support promise. If the owner keeps the "no public registry" decision, the fallback that is still one command:

```bash
curl -fsSL https://github.com/MubitLabs/mubit-engineering-control/releases/latest/download/install.sh | bash
# → downloads mec-<version>.tgz for this OS/arch, installs into ~/.mec/app, links ~/.local/bin/mec, runs `mec`
```

Both paths end in the same place; the script is 40 lines and lives in the repo so it can be read before it is run.

### 3.2 What has to change in the code (one day)

| # | Change | Where |
| --- | --- | --- |
| 1 | Ship the web UI inside the artifact: `pack-tarball.mjs` runs `vite build` and copies `apps/web/dist` → `dist/web`; `server.ts` resolves `WEB_DIST` from `dist/web` when bundled | `scripts/pack-tarball.mjs`, `apps/desktop/src/server.ts` |
| 2 | Read the meta slot from the store at start (`wizard/meta-slot` already persists it); `MEC_META_SLOT` becomes an override, not the way | `apps/desktop/src/serve.ts`, `composition.ts` |
| 3 | `mec` with no slot and no repository starts the server **and opens the browser on `#/wizard`**; `mec --no-open` for scripts; print the URL either way | `apps/desktop/src/serve.ts` |
| 4 | `mec --version`, `mec help`; `mec doctor` prints the three engine versions and whether each is signed in in its default home (it has the probes already) | `apps/desktop/src/mec.ts` |
| 5 | Native modules: both ship prebuilds for macOS/Linux × arm64/x64 via `prebuild-install` (better-sqlite3 12.x) and node-pty 1.1.x; the artifact's `package.json` already lists only those two as dependencies. Keep `--ignore-scripts=false` out of the user's hands: the install script runs `npm install --omit=dev` inside `~/.mec/app` and surfaces the §21.7 message if a prebuild is missing | `scripts/install.sh` (new) |
| 6 | Publish: a `release.yml` workflow on tag `v*` that runs `pnpm check`, builds the tarball on `ubuntu-latest` and `macos-latest` (the artifact is platform-neutral JS plus platform-resolved natives at install time, so one tarball is enough — the matrix is the smoke test), attaches `mec-<version>.tgz` and `install.sh` to the GitHub Release, and (if the owner agrees) `npm publish` from the staged directory with provenance | `.github/workflows/release.yml` (new) |
| 7 | Smoke in CI: extract the tarball, `node bin/mec.js --version`, `mec doctor --json`, start the server with `MEC_DATA_DIR=$(mktemp -d)` and `curl /healthz`, stop | `.github/workflows/ci.yml` |

### 3.3 README "Install" section (drop-in text)

```markdown
## Install

Requirements: macOS or Linux · Node ≥ 22.18 · at least one coding agent installed and signed in
(Claude Code, Codex CLI, or OpenCode) · `gh` signed in if you want MEC to open pull requests.

    npx mubit-engineering-control

That starts MEC on 127.0.0.1 and opens Setup in your browser: it finds your installed agents,
lets you link an existing login or sign in to a dedicated one (through the vendor's own flow —
MEC never sees a token), paste an API key if you use GLM or Gemini, register a repository, and
pick which slot runs the meta agent. Two minutes, no terminal.

Prefer a script? `curl -fsSL …/releases/latest/download/install.sh | bash` installs the same
artifact into `~/.mec/app` and puts `mec` on your PATH. Read it first; it is 40 lines.

Then: talk to the meta agent in **Chat**; approve pushes, PRs and merges in **Inbox**; watch the
work in **Work**. `mec status`, `mec doctor`, `mec stop` from any terminal.
```

### 3.4 First-run journey (what the wizard must do, for §6 of the UI spec)

1. Detect engines and versions; show which are signed in already (the existing probes).
2. For each engine the user wants: *Link existing login* (one click) · *Sign in to a dedicated slot* (terminal card) · *Paste an API key* (masked form). Explain in one line what "link" means (sessions in your history, shared quota).
3. Register a repository: path or URL; MEC reads the repo's own README/`package.json`/`Makefile` and *proposes* bootstrap and check commands for the user to accept (today the user types them).
4. Choose the meta agent's slot (default: the healthiest subscription slot).
5. Done: a card that says what to try first, with a one-click example request on the registered repo.

## 4. Governance for a public repo that is run by one person and agents

- `main` protected; PRs from short-lived branches; CI required; one approving review — from the other person when available, else an agent instance that did not write the change, with the review recorded in the PR.
- `DECISIONS.md` #8 (standing approval for external effects) expires at R2 exit as written; record the expiry date in the file.
- A `MAINTAINERS.md` naming who answers issues and the expected response time ("best effort, usually within a week").
- Monthly "vendor re-verification" issue opened by a scheduled workflow with the checklist from the spec §28 and `docs/engines.md`.
