-- Workspaces, check results and artifacts (PDF §14, §15, §24).

alter table attempts add column diff jsonb;

-- Large content (logs, patches) lives on disk under ARTIFACTS_DIR; rows hold the reference.
create table artifacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  attempt_id uuid references attempts (id) on delete cascade,
  kind text not null check (kind in ('check_log', 'patch', 'log', 'other')),
  name text not null,
  content_type text not null default 'text/plain; charset=utf-8',
  size_bytes bigint not null,
  sha256 text not null,
  storage_path text not null,
  created_by_runner uuid references runners (id),
  created_at timestamptz not null default now()
);
create index artifacts_attempt on artifacts (attempt_id);

-- One row per check execution, tied to the exact commit it tested.
create table check_results (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  attempt_id uuid references attempts (id) on delete cascade,
  task_id uuid references tasks (id) on delete cascade,
  delivery_id uuid references deliveries (id) on delete cascade,
  scope text not null default 'task' check (scope in ('task', 'integration')),
  name text not null,
  -- passed: exit 0; failed: the check ran and reported failure; error: it could not run.
  status text not null check (status in ('passed', 'failed', 'error')),
  exit_code integer,
  duration_ms integer not null,
  tested_sha text,
  log_artifact_id uuid references artifacts (id),
  log_tail text,
  source_event_id text,
  created_at timestamptz not null default now(),
  unique (attempt_id, source_event_id)
);
create index check_results_attempt on check_results (attempt_id);
