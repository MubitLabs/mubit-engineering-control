-- Review, integration and pull requests (PDF §14, §15).

alter table tasks drop constraint tasks_kind_check;
alter table tasks add constraint tasks_kind_check check (kind in ('work', 'planning', 'integration'));

-- What the next attempt must know: review notes, failed checks, or an integration conflict.
alter table tasks add column repair_context jsonb;

-- The delivery's integration branch advances one accepted task at a time.
alter table deliveries add column integration_sha text;
-- The integration commit that is also on the remote (a PR can only point at a pushed branch).
alter table deliveries add column integration_pushed_sha text;

create table pull_requests (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references deliveries (id) on delete cascade,
  number integer not null,
  url text not null,
  head_branch text not null,
  head_sha text not null,
  base_ref text not null,
  -- Mirrors GitHub; 'merged' is recorded only when GitHub reports it.
  state text not null default 'open' check (state in ('open', 'closed', 'merged')),
  checks jsonb,
  merged_at timestamptz,
  last_polled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (delivery_id, number)
);
