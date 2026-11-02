-- Execution profiles, delegation grants and the attempt message queue (PDF §5, §12, §13).

-- An execution profile binds an employee, a native agent account on their runner, and grants.
-- The account itself never leaves the runner: control stores only a label and its health.
create table execution_profiles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users (id),
  runner_id uuid not null references runners (id),
  agent_kind text not null,
  label text not null,
  model text,
  agent_version text,
  capability_set jsonb not null default '[]'::jsonb,
  auth_state text not null default 'unknown' check (auth_state in ('ok', 'required', 'unknown')),
  allowed_project_ids uuid[] not null default '{}',
  delegate_ids uuid[] not null default '{}',
  max_active integer not null default 1,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (runner_id, agent_kind, label)
);

alter table attempts add column profile_id uuid references execution_profiles (id);

-- Steering messages: one ordered queue per attempt; delivered is confirmed by the runner.
create table attempt_messages (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references attempts (id) on delete cascade,
  author_id uuid not null references users (id),
  body text not null,
  status text not null default 'queued' check (status in ('queued', 'delivered', 'rejected')),
  client_key text not null,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  unique (attempt_id, client_key)
);
