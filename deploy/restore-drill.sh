#!/usr/bin/env bash
# Restore drill (PDF §26): restore the newest backup into a scratch database, check that the
# schema and the active work are consistent, then drop it. Production is not touched.
#
#   ssh openclaw bash /opt/mec/deploy/restore-drill.sh            # newest backup
#   ssh openclaw bash /opt/mec/deploy/restore-drill.sh <file.dump>
#
# A real restore follows docs/RUNBOOK.md ("Restoring the database"): restore, pause dispatch,
# start control, let runners reconnect and replay, then resume dispatch.
set -euo pipefail

BACKUPS=/var/lib/mec/backups
DUMP="${1:-$(ls -1t "$BACKUPS"/mec-*.dump 2>/dev/null | head -1)}"
DRILL_DB=mec_restore_drill
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "no backup found in $BACKUPS" >&2; exit 1; }

psql_q() { runuser -u postgres -- psql -v ON_ERROR_STOP=1 -qtA "$@"; }

echo "[drill] restoring $DUMP into $DRILL_DB"
psql_q -c "drop database if exists $DRILL_DB with (force)"
psql_q -c "create database $DRILL_DB owner mec"
runuser -u postgres -- pg_restore --no-owner --role=mec --dbname="$DRILL_DB" < "$DUMP"

echo "[drill] checks"
fail=0
check() {
  local label="$1" sql="$2" expect="$3"
  local got
  got="$(psql_q -d "$DRILL_DB" -c "$sql")"
  if [ "$got" = "$expect" ]; then echo "  ok   $label"; else echo "  FAIL $label (got '$got', expected '$expect')"; fail=1; fi
}
check "migrations recorded" "select count(*) > 0 from schema_migrations" "t"
check "at most one active attempt per task" \
  "select count(*) from (select task_id from attempts where state in ('leased','preparing','running','awaiting_input','work_complete','checking','stalled') group by task_id having count(*) > 1) x" "0"
check "event sequences gap-free per stream" \
  "select count(*) from (select stream, max(seq) - count(*) as gap from events group by stream) x where gap <> 0" "0"
check "every event stream counter matches its events" \
  "select count(*) from event_streams s where s.last_seq <> (select coalesce(max(seq), 0) from events e where e.stream = s.stream)" "0"
check "no approval resolved twice" \
  "select count(*) from (select approval_id from (select payload->>'approvalId' as approval_id from events where type = 'approval.resolved') r group by approval_id having count(*) > 1) x" "0"

echo "[drill] active work a restored control would reconcile with runners:"
psql_q -d "$DRILL_DB" -c "select a.id, t.key, a.state, a.generation, r.name from attempts a join tasks t on t.id = a.task_id left join runners r on r.id = a.runner_id where a.state in ('leased','preparing','running','awaiting_input','work_complete','checking','stalled','interrupted','quota_wait','auth_required')" || true

psql_q -c "drop database $DRILL_DB with (force)"
if [ "$fail" = 0 ]; then echo "[drill] passed"; else echo "[drill] FAILED"; exit 1; fi
