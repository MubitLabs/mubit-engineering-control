-- Identity, projects, deliveries, plans, tasks and approvals (PDF §5, §8, §13, §24).

create table users (
  id uuid primary key default gen_random_uuid(),
  github_id bigint unique,
  login text not null,
  name text,
  avatar_url text,
  is_admin boolean not null default false,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index users_login_lower on users (lower(login));

-- The cookie holds a random token; only its SHA-256 is stored.
create table sessions (
  token_hash text primary key,
  user_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_user on sessions (user_id);

create table projects (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name text not null,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  -- A paused project gets no new dispatch (PDF §13).
  paused_at timestamptz,
  paused_by uuid references users (id)
);

create table memberships (
  project_id uuid not null references projects (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  role text not null check (role in ('owner', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index memberships_user on memberships (user_id);

create table repositories (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  name text not null,
  clone_url text not null,
  default_branch text not null default 'main',
  -- Reviewed command profiles: { bootstrap: [...], checks: [{ name, argv, timeoutSec }] } (PDF §15).
  validation_profile jsonb not null default '{"bootstrap": [], "checks": []}'::jsonb,
  created_at timestamptz not null default now(),
  unique (project_id, name)
);

create table deliveries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  repository_id uuid not null references repositories (id),
  title text not null,
  owner_id uuid not null references users (id),
  state text not null default 'planning',
  base_ref text not null,
  base_sha text,
  priority integer not null default 0,
  idempotency_key text not null,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, idempotency_key)
);

create table plan_revisions (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references deliveries (id) on delete cascade,
  number integer not null,
  state text not null default 'draft',
  plan_markdown text not null,
  constraints text not null default '',
  requirements jsonb not null default '[]'::jsonb,
  tasks jsonb not null default '[]'::jsonb,
  validation jsonb,
  -- Optimistic concurrency for edits; bumped on every change.
  version integer not null default 1,
  content_hash text not null,
  author_id uuid references users (id),
  supersedes_id uuid references plan_revisions (id),
  impact_summary text,
  approved_by uuid references users (id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (delivery_id, number)
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references deliveries (id) on delete cascade,
  plan_revision_id uuid not null references plan_revisions (id),
  key text not null,
  title text not null,
  spec jsonb not null,
  state text not null default 'approved',
  blocker jsonb,
  owner_id uuid references users (id),
  attempts_used integer not null default 0,
  accepted_sha text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (delivery_id, plan_revision_id, key)
);
create index tasks_delivery_state on tasks (delivery_id, state);

create table task_dependencies (
  task_id uuid not null references tasks (id) on delete cascade,
  depends_on_task_id uuid not null references tasks (id) on delete cascade,
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id)
);

-- One durable record per decision (PDF §13). binding_hash pins the exact input reviewed.
create table approvals (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('plan', 'tool', 'question', 'result', 'merge')),
  project_id uuid not null references projects (id) on delete cascade,
  delivery_id uuid references deliveries (id) on delete cascade,
  task_id uuid references tasks (id) on delete cascade,
  attempt_id uuid,
  generation integer,
  native_request_ref text,
  plan_revision_id uuid references plan_revisions (id),
  policy_revision text not null default 'v1',
  binding_hash text not null,
  input_commit text,
  title text not null,
  detail jsonb not null default '{}'::jsonb,
  requested_by_kind text not null check (requested_by_kind in ('user', 'agent', 'system')),
  requested_by text,
  allowed_decider_ids uuid[] not null,
  status text not null default 'pending',
  expires_at timestamptz,
  resolved_by uuid references users (id),
  resolved_at timestamptz,
  answer jsonb,
  created_at timestamptz not null default now()
);
create index approvals_pending on approvals (project_id, created_at) where status = 'pending';
create unique index approvals_native_request on approvals (attempt_id, native_request_ref)
  where native_request_ref is not null;

create table audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references users (id),
  action text not null,
  resource_kind text not null,
  resource_id text,
  project_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
