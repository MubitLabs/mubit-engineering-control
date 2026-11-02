# Mubit Engineering Control

A private web app that turns an implementation plan into coordinated work across employees'
coding-agent CLIs. A coordinator proposes a task graph, a deterministic scheduler leases tasks to
employee-owned runners, agents work in isolated git worktrees, humans answer decisions in an inbox,
checks and review gate acceptance, and an integration queue produces one tested pull request.

The full specification is [`docs/Mubit_Engineering_Control_Build_Plan.pdf`](docs/Mubit_Engineering_Control_Build_Plan.pdf).
This repository builds **v1, the core delivery loop**, as numbered milestones. Each milestone has a
short explainer in [`docs/milestones/`](docs/milestones/).

| Milestone | Component |
| --- | --- |
| [M0](docs/milestones/M0.md) | Foundation: workspace, event log, outbox, migrations, CI |

## Layout

```
apps/web            React + Vite workbench
apps/control        Fastify API, scheduler, outbox, reconciliation, SSE, SQL migrations
apps/runner         Runner daemon: supervisor, journal, WebSocket client, workspaces, checks
packages/contracts  Zod schemas shared by web, control and runner
packages/domain     Pure state machines, task-graph validation, lease rules
packages/policy     Permission checks
packages/agents     Agent adapter interface and adapters (fake, Claude Code)
packages/git        Clones, worktrees, merges, diffs
packages/testkit    Fake runner, fake agent scripts, recorded fixtures
deploy/             Droplet provisioning, systemd units, Caddy site, deploy script
```

## Development

```bash
pnpm install
pnpm db:up      # Postgres 16 in Docker on 127.0.0.1:5434
pnpm check      # typecheck + lint + tests
```
