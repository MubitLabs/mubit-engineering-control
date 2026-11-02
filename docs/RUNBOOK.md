# Runbook — Mubit Engineering Control

## What runs where

| Piece | Where | Logs |
| --- | --- | --- |
| Control plane (`mec-control.service`, user `mec`) | droplet-max, `127.0.0.1:4100`, code in `/opt/mec/current` | `journalctl -u mec-control` |
| Public endpoint | Caddy site `/etc/caddy/sites/mec.caddy` → https://mec.139-59-181-123.sslip.io | Caddy |
| Database | PostgreSQL 16, database `mec` (localhost only) | `journalctl -u postgresql` |
| Runner (`mec-runner.service`, user `max`) | droplet-max, state in `/home/max/mec` (journal, repos, worktrees) | `journalctl -u mec-runner` |
| Config and secrets | `/etc/mec/control.env` (root:mec 0640), `/home/max/.config/mec/runner.env` (max 0600) | — |
| Artifacts | `/var/lib/mec/artifacts` | — |
| Backups | `/var/lib/mec/backups`, daily 03:17, 14 kept | — |

Root access is via the `openclaw` ssh alias; `droplet-max` is the `max` user.

## Deploy and roll back

```bash
deploy/deploy.sh                 # build locally, upload a release, migrate, switch, restart, health-check
deploy/deploy.sh provision       # also re-run host provisioning (after changing deploy/)
```

Releases live in `/opt/mec/releases`; the three newest are kept. Rolling back code:

```bash
ssh openclaw 'ls -1t /opt/mec/releases'
ssh openclaw 'ln -sfn /opt/mec/releases/<older> /opt/mec/current && systemctl restart mec-control mec-runner'
```

Migrations only move forward; a rollback across a migration needs a reviewed down-migration.

## One-time setup

1. **GitHub sign-in.** Create an OAuth App in MubitLabs with callback
   `https://mec.139-59-181-123.sslip.io/auth/github/callback`. Put `GITHUB_CLIENT_ID` and
   `GITHUB_CLIENT_SECRET` in `/etc/mec/control.env`, then `systemctl restart mec-control`. Only
   active MubitLabs members can sign in; admins are listed in `MEC_ADMIN_LOGINS`.
2. **Claude Code on the runner.** `ssh droplet-max`, run `claude`, then `/login`. The runner's
   probe picks it up within five minutes (Accounts page shows sign-in `ok`).
3. **Repository token.** A fine-grained PAT limited to the delivery repositories (Contents and Pull
   requests: read and write). Put it in `/home/max/.config/mec/runner.env` as `MEC_GIT_TOKEN` (push)
   and in `/etc/mec/control.env` as `GITHUB_TOKEN` (pull requests), then restart both services.
4. **A runner for an employee.** Fleet → *Enrol a runner* (or on the host:
   `node /opt/mec/current/apps/control/dist/admin.js invite --owner <login> --label <text>`), then on
   the employee's machine `node apps/runner/dist/main.js enrol --url https://mec.139-59-181-123.sslip.io --invite <token> --name <name>`.
5. **An execution profile.** The runner's owner opens Accounts → *Offer an agent account*, picks the
   runner and agent, grants projects and (optionally) delegates.

## Launch checks before a delivery

- Fleet: the runner is **online**, not draining, with free capacity and enough disk.
- Accounts: the profile's sign-in is **ok** and the project is granted.
- Project: the repository is registered with a reviewed validation profile (bootstrap + checks)
  and the check names the tasks will use.
- Repository access: a coordinator run or a first attempt resolves the base SHA (shown pinned on
  the delivery). Private submodules fail preparation with a clear message if access is missing.

## When work stalls

Every waiting task shows a blocker on the delivery page.

| Blocker / state | Meaning | Action |
| --- | --- | --- |
| `dependency` | Prerequisites not yet integrated (or accepted, for contract dependencies) | Review and accept the prerequisites |
| `capacity` | A limit (global, employee, delivery, profile, runner) is reached | Wait, or raise the limit in `control.env` |
| `infrastructure` — no runner | No connected runner offers the agent / no usable profile | Check Fleet and Accounts |
| attempt `stalled` | The runner stopped reporting; the lease expired | Wait for it to reconnect. If the machine is gone, an admin uses *Confirm process stopped*, then *Abandon* to start fresh |
| `reviewer` | Waiting for result review | Inbox → Accept result / Send back |
| `decision` | Attempt budget used | Start a repair attempt manually or cancel the task |
| attempt `awaiting_input` | The agent asked a question or needs a tool approval | Inbox |
| attempt `auth_required` | Native agent sign-in expired | The account owner signs in again on the runner, then *Resume* |
| attempt `quota_wait` | Usage limit reached (reset time shown if known) | Wait and *Resume*, or *Abandon* and start on another granted profile — never automatic |
| attempt `checks_failed` | Acceptance checks failed | The next attempt repairs with the exact failures |
| repair after `integration_conflict` | The accepted change conflicts with the integration branch | The repair attempt resolves the merge it starts with |

Useful queries: `ssh openclaw runuser -u postgres -- psql -d mec`, then e.g.
`select key, state, blocker->>'detail' from tasks where delivery_id = '<id>';`.

## Draining a runner (host maintenance)

1. Fleet → *Drain*. It takes no new work; current attempts finish.
2. Wait until its active count is 0 (or interrupt what must stop — work and branches are preserved).
3. `systemctl stop mec-runner`, do the maintenance, `systemctl start mec-runner`.
4. Fleet → *Undrain*.

Emergency: Fleet → *Stop fleet* pauses all dispatch and interrupts every attempt, tracking each
runner's acknowledgement. Unreachable runners are listed, not assumed stopped. *Resume dispatch*
when ready.

## Backups and restoring the database

Daily `pg_dump` runs as `mec` into `/var/lib/mec/backups`. Prove a backup restores with:

```bash
ssh openclaw bash /opt/mec/deploy/restore-drill.sh
```

To restore for real:

1. `systemctl stop mec-control`.
2. Restore the dump into `mec` (`pg_restore --clean --no-owner --role=mec -d mec < dump`).
3. Pause dispatch before starting control:
   `insert into settings (key, value) values ('dispatch', '{"dispatchPaused": true}') on conflict (key) do update set value = excluded.value;`
4. `systemctl start mec-control`. Runners reconnect: events the backup missed are replayed from
   their journals; attempts the backup never recorded are stopped on the runner (their workspaces
   kept) and listed as `runner.unknown_attempt` fleet events.
5. Check Fleet and the deliveries, then *Resume dispatch*. Tasks whose attempts were stopped start
   once, fresh.

## Rotating credentials

- Runner device token: Fleet → *Revoke*, then enrol again with a new invitation.
- OAuth secret or tokens: replace in the env file, restart the service.
- Sessions: `delete from sessions;` signs everyone out.
