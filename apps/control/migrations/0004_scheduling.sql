-- Scheduling controls (PDF §11, §13).

-- Installation-wide switches, e.g. {"dispatchPaused": true} after a fleet stop.
create table settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references users (id),
  updated_at timestamptz not null default now()
);

-- A fleet stop interrupts every current attempt and tracks which runners acknowledged it. It
-- cannot claim a disconnected machine stopped until that runner confirms.
create table fleet_stops (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references users (id),
  reason text not null default '',
  attempts jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
