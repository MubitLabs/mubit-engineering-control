-- The durable event log is the authority for what happened (PDF §16, §24).
-- Each stream ('project:<uuid>', 'fleet') has a gap-free sequence. Appending takes a row lock on
-- the stream, so commit order equals sequence order and SSE clients can resume from a cursor
-- without missing late-committing rows.

create table event_streams (
  stream text primary key,
  last_seq bigint not null default 0
);

create table events (
  id bigint generated always as identity primary key,
  stream text not null references event_streams (stream),
  seq bigint not null,
  type text not null,
  project_id uuid,
  delivery_id uuid,
  task_id uuid,
  attempt_id uuid,
  actor_kind text not null check (actor_kind in ('user', 'runner', 'system', 'agent')),
  actor_id text,
  payload jsonb not null default '{}'::jsonb,
  -- Runner-originated events keep their source identity for deduplication (PDF §25).
  source_runner_id uuid,
  source_event_id text,
  source_sequence bigint,
  source_generation integer,
  occurred_at timestamptz not null default now(),
  recorded_at timestamptz not null default now(),
  unique (stream, seq)
);

create unique index events_source_dedupe on events (source_runner_id, source_event_id)
  where source_event_id is not null;
create index events_attempt on events (attempt_id, id) where attempt_id is not null;
create index events_task on events (task_id, id) where task_id is not null;

-- Transactional outbox: written in the same transaction as the state change it announces.
create table outbox (
  id bigint generated always as identity primary key,
  topic text not null,
  target text,
  payload jsonb not null,
  idempotency_key text not null unique,
  available_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

create index outbox_pending on outbox (topic, available_at) where delivered_at is null;
