# Project command interface

The helper uses Python 3.9+ and the standard library. It invokes project tools
you configure; it does not replace the project's runtime or dependencies.
It works from any current directory because it locates the repository from
its own installed path: tools/repo-kit/run.py.

```bash
python3 tools/repo-kit/run.py list
python3 tools/repo-kit/run.py setup
python3 tools/repo-kit/run.py check
python3 tools/repo-kit/run.py test
python3 tools/repo-kit/run.py verify
python3 tools/repo-kit/run.py verify --dry-run
python3 tools/repo-kit/run.py test --area api
```

`list` displays configuration only. `--dry-run` executes nothing. Neither is
evidence that the application passes checks. An empty or null selected command
fails with exit code 2. `verify` validates every selected group before running
any commands, then stops at the first unsuccessful command.

## Configuration

Edit .repo-kit/commands.json after inspecting the real project. This is the
shape; replace each example tool with the project's actual command:

```json
{
  "schema_version": 1,
  "verify": ["check", "test"],
  "commands": {
    "setup": [{"argv": ["your-package-manager", "install-locked"], "cwd": ".", "timeout_seconds": 600}],
    "check": [{"argv": ["your-check-command"], "cwd": "."}],
    "test": [{"argv": ["your-test-command"], "cwd": "."}],
    "integration": null,
    "smoke": null
  },
  "areas": {
    "api": {
      "commands": {
        "test": [{"argv": ["your-api-test-command"], "cwd": "apps/api"}]
      }
    }
  }
}
```

- Each action contains an ordered, nonempty list of steps.
- `argv` is a token array. There is no implicit shell, pipe, redirect, glob,
  tilde expansion, or environment-variable interpolation. Use an existing
  repository script when a command needs shell behavior.
- `cwd` defaults to the root and must resolve to an existing directory inside
  the repository. `timeout_seconds` defaults to 600 and must be positive.
- Child processes inherit the current environment. The helper does not load
  .env files. Use the project's normal local environment setup.
- Area commands override matching root actions; other actions remain the root
  actions. An area may also override its `verify` list.
- `--area` selects explicit configuration. It does not compute affected
  dependencies. Include dependent packages and contract checks when needed.
- Custom action names such as `build` and `contracts` are supported. `verify`
  and `list` are reserved.
- Put actual checks in `verify`. Add integration, smoke, build, or generated
  artifact checks where the project needs them. Record why an action does not
  apply. Never fill a check with echo, true, or a placeholder passing test.
- Keep existing package scripts, Make/Just targets, and CI as the source of
  command logic; call them instead of duplicating their implementation.
- Do not place credentials or tokens in argv or the committed JSON file.

Exit codes: 0 selected commands passed (or an explicitly labelled list/dry
run); 2 configuration error; 124 timeout; 127 missing executable. Other child
exit codes propagate. A configuration error never means application success.

## CI integration

Use the existing workflow for a brownfield project. For a new project, create
a native workflow after the runtime and dependency manager are chosen. After
checkout and runtime provisioning, call the same setup and verify actions
used locally. Ensure their chosen tools are installed in CI. Do not create
a second competing workflow or assume Python is the application's runtime.

The kit helper's tests are separate from application tests. Passing the
helper tests never establishes application correctness.

## This repository's configuration

`.repo-kit/commands.json` wraps the native commands and nothing else:

| Action | Command | Notes |
| --- | --- | --- |
| `setup` | `pnpm install` | builds the two native modules via the pnpm allowlist |
| `check` | `pnpm check` | the full gate: typecheck + biome + both suites |
| `test` | `pnpm test:a` then `pnpm test:b` | the suites without typecheck/lint |
| `smoke` | `node apps/desktop/bin/mec.js doctor` | probes the real local engine binaries |
| `integration` | **null (deliberate)** | the real-engine canaries are quota-spending and env-gated (`MEC_REAL_*`) — never run from a wrapper; see `development.md` |

`verify` = `check` (the full gate already includes the suites — no double run).
Areas: `engines` (engines+contracts conformance), `desktop`, `web` (tests + tsc). Use an area for a lane, the root gate before handing work back.

## Accessibility gates (not in CI, not in `pnpm check`)

Like `pnpm test:screens`, these are run by hand and are never part of the full gate.

| What | Command | Notes |
| --- | --- | --- |
| axe | `pnpm test:screens` | `apps/web/test/a11y.screens.playwright.ts` runs with the screens suite. No rule is disabled; a missing surface or a run with no passing rule fails. |
| Lighthouse | `pnpm --dir apps/web test:lighthouse <baseUrl> <#route>...` | Accessibility category, 95 per route, non-zero on any miss or unreadable report. Uses Playwright's chromium with `--no-proxy-server`; JSON reports go to `$TMPDIR`. `--from-report <file>...` judges reports already on disk. |
| Gate logic | `pnpm --dir apps/web exec vitest run test/a11y-gate.test.ts` | Runs in the normal suite with stubbed reports; no browser. |

`pnpm test:screens` binds port 4173: take `/tmp/mec-screens.lock` first (`until mkdir /tmp/mec-screens.lock 2>/dev/null; do sleep 5; done`, then `rmdir` it). Lighthouse needs the page served: start the dev server (`pnpm --dir apps/web exec vite --host 127.0.0.1 --port <free port> --strictPort`) and pass the harness URL, for example `http://127.0.0.1:<port>/test/fixtures/next-harness.html?state=working` with routes `#chat #work`. `apps/web/test/fixtures/a11y-broken.html` is deliberately inaccessible and proves both gates can fail.
