#!/usr/bin/env bash
# One-time (idempotent) host setup for Mubit Engineering Control. Runs as root on the droplet;
# deploy.sh copies this directory to /opt/mec/deploy and runs it:
#   deploy/deploy.sh provision
#
# It installs PostgreSQL 16, adds a 4 GB swapfile, creates the `mec` system user, database and
# role, writes /etc/mec/control.env once, installs the systemd units and adds the Caddy site.
# Existing services on the host (OpenClaw, builderprofile) are not touched.
set -euo pipefail

DOMAIN="${MEC_DOMAIN:-mec.139-59-181-123.sslip.io}"
ADMIN_LOGINS="${MEC_ADMIN_LOGINS:-e1daru}"
RUNNER_USER="${MEC_RUNNER_USER:-max}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE=/etc/mec/control.env

log() { echo "[provision] $*"; }
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

# ── Swap: the host has 3.8 GB and no swap; builds and agents need headroom ──────────────────
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  if [ ! -f /swapfile ]; then
    log "creating 4G swapfile"
    fallocate -l 4G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/60-mec-swap.conf
sysctl -q -p /etc/sysctl.d/60-mec-swap.conf

# ── Packages ─────────────────────────────────────────────────────────────────────────────────
if ! dpkg -s postgresql-16 >/dev/null 2>&1; then
  log "installing postgresql-16"
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q postgresql-16 rsync git
fi
systemctl enable --now postgresql >/dev/null
corepack enable

# ── Users and directories ────────────────────────────────────────────────────────────────────
if ! id mec >/dev/null 2>&1; then
  log "creating system user mec"
  useradd --system --home-dir /var/lib/mec --create-home --shell /usr/sbin/nologin mec
fi
install -d -o mec -g mec -m 0750 /var/lib/mec /var/lib/mec/artifacts /var/lib/mec/backups
install -d -o root -g root -m 0755 /opt/mec /opt/mec/releases
install -d -o root -g mec -m 0750 /etc/mec
install -d -o "$RUNNER_USER" -g "$RUNNER_USER" -m 0700 "/home/$RUNNER_USER/.config/mec" "/home/$RUNNER_USER/mec"

# ── Configuration (written once; secrets are added in place, never committed) ────────────────
if [ ! -f "$ENV_FILE" ]; then
  log "writing $ENV_FILE"
  umask 027
  cat > "$ENV_FILE" <<EOF
DATABASE_URL=postgres://mec:$(openssl rand -hex 24)@127.0.0.1:5432/mec
HOST=127.0.0.1
PORT=4100
PUBLIC_URL=https://$DOMAIN
AUTH_MODE=github
GITHUB_ORG=MubitLabs
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
MEC_ADMIN_LOGINS=$ADMIN_LOGINS
ARTIFACTS_DIR=/var/lib/mec/artifacts
MIGRATE_ON_START=false
LOG_LEVEL=info
MEC_LIMIT_GLOBAL=2
MEC_LIMIT_PER_EMPLOYEE=2
EOF
  chown root:mec "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
fi

# ── Database and role ────────────────────────────────────────────────────────────────────────
DB_PASSWORD="$(sed -n 's#^DATABASE_URL=postgres://mec:\([^@]*\)@.*#\1#p' "$ENV_FILE")"
[ -n "$DB_PASSWORD" ] || { echo "cannot read DB password from $ENV_FILE" >&2; exit 1; }
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -q -v pw="$DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE mec LOGIN PASSWORD %L', :'pw') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mec') \gexec
SELECT format('ALTER ROLE mec PASSWORD %L', :'pw') \gexec
SQL
if ! runuser -u postgres -- psql -tAc "select 1 from pg_database where datname = 'mec'" | grep -q 1; then
  log "creating database mec"
  runuser -u postgres -- createdb -O mec mec
fi

# ── systemd units ────────────────────────────────────────────────────────────────────────────
install -m 0644 "$HERE/systemd/mec-control.service" /etc/systemd/system/mec-control.service
install -m 0644 "$HERE/systemd/mec-runner.service" /etc/systemd/system/mec-runner.service
systemctl daemon-reload
systemctl enable mec-control >/dev/null

# ── Caddy site (the main Caddyfile already imports sites/*.caddy) ────────────────────────────
install -m 0644 "$HERE/caddy/mec.caddy" /etc/caddy/sites/mec.caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || {
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  exit 1
}
systemctl reload caddy

# ── Daily database backup, keeping 14 days ───────────────────────────────────────────────────
cat > /etc/cron.d/mec-backup <<'EOF'
# m h dom mon dow user command
17 3 * * * mec pg_dump --format=custom --file=/var/lib/mec/backups/mec-$(date +\%Y\%m\%d).dump "$(sed -n 's/^DATABASE_URL=//p' /etc/mec/control.env)" && find /var/lib/mec/backups -name 'mec-*.dump' -mtime +14 -delete
EOF
chmod 0644 /etc/cron.d/mec-backup

log "done"
