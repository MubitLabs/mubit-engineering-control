-- Runners, enrolment and attempts (PDF §6, §11, §24, §25).

-- Single-use, short-lived invitation for one employee's environment.
create table runner_invites (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  owner_id uuid not null references users (id),
  label text not null,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  runner_id uuid
);

create table runners (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users (id),
  name text not null unique,
  -- Device credential: only the hash is stored.
  token_hash text not null unique,
  hostname text,
  os text,
  arch text,
  runner_version text,
  capacity jsonb not null default '{}'::jsonb,
  agents jsonb not null default '[]'::jsonb,
  status text not null default 'offline' check (status in ('online', 'offline')),
  -- Draining: no new assignments, current work may finish.
  draining boolean not null default false,
  revoked_at timestamptz,
  connected_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create table attempts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  delivery_id uuid not null references deliveries (id) on delete cascade,
  task_id uuid not null references tasks (id) on delete cascade,
  number integer not null,
  kind text not null default 'implement' check (kind in ('implement', 'repair', 'coordinator', 'integration')),
  state text not null default 'queued',
  agent_kind text not null,
  runner_id uuid references runners (id),
  -- Lease: generation fences older runners; expiry triggers reconciliation, not replacement.
  generation integer not null default 0,
  lease_expires_at timestamptz,
  native_session_ref text,
  base_sha text,
  branch text,
  head_sha text,
  inputs jsonb not null default '{}'::jsonb,
  result jsonb,
  blocker jsonb,
  -- Highest runner event sequence persisted for this attempt.
  last_sequence bigint not null default -1,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (task_id, number)
);

-- At most one attempt per task may hold the active slot: a duplicate dispatch cannot start a
-- second process (PDF §11, §26).
create unique index attempts_active_slot on attempts (task_id)
  where state in ('leased', 'preparing', 'running', 'awaiting_input', 'work_complete', 'checking', 'stalled');
create index attempts_runner_active on attempts (runner_id)
  where state in ('leased', 'preparing', 'running', 'awaiting_input', 'work_complete', 'checking', 'stalled');
create index attempts_lease on attempts (lease_expires_at)
  where state in ('leased', 'preparing', 'running', 'awaiting_input', 'work_complete', 'checking');

alter table approvals add constraint approvals_attempt_fk foreign key (attempt_id) references attempts (id) on delete cascade;

-- Outbox rows addressed to a runner are delivered over its WebSocket and acknowledged.
alter table outbox add column sent_at timestamptz;
create index outbox_runner_pending on outbox (target, id) where delivered_at is null and topic = 'runner.command';
