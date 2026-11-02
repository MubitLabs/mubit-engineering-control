-- Coordinator planning (PDF §8). The coordinator runs as an attempt of a hidden per-delivery
-- planning task, so it shares claims, leases, journals and the decision bridge with normal work.
alter table tasks add column kind text not null default 'work' check (kind in ('work', 'planning'));
create index tasks_delivery_kind on tasks (delivery_id, kind);
