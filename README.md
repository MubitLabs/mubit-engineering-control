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
| [M1](docs/milestones/M1.md) | Domain and policy: state machines, task-graph validation, leases, permissions |
| [M2](docs/milestones/M2.md) | Control API, GitHub login, plan revisions, atomic approvals, SSE, web shell |
| [M3](docs/milestones/M3.md) | Droplet provisioning and deploy pipeline (live at https://mec.139-59-181-123.sslip.io) |
| [M4](docs/milestones/M4.md) | Runner and protocol: enrolment, WebSocket, journal and replay, supervisor, fake agent, fleet UI |
| [M5](docs/milestones/M5.md) | Scheduler, leases and recovery: fair limits, reconciliation, fencing, pause and fleet stop |
| [M6](docs/milestones/M6.md) | Workspaces and checks: pinned worktrees, diffs, check results, artifacts |
| [M7](docs/milestones/M7.md) | Claude Code adapter, decision bridge and inbox, execution profiles, steering messages |

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
