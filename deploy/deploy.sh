#!/usr/bin/env bash
# Build locally, ship a release to the droplet, migrate, switch, restart, health-check.
#
#   deploy/deploy.sh             # deploy the working tree
#   deploy/deploy.sh provision   # (re)run host provisioning first, then deploy
#
# MEC_DEPLOY_HOST is an ssh alias with root access (default: openclaw).
set -euo pipefail

HOST="${MEC_DEPLOY_HOST:-openclaw}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ "${1:-}" = "provision" ]; then
  ssh "$HOST" install -d -m 0755 /opt/mec /opt/mec/deploy
  rsync -az --delete deploy/ "$HOST:/opt/mec/deploy/"
  ssh "$HOST" bash /opt/mec/deploy/provision.sh
fi

SHA="$(git rev-parse --short HEAD)"
[ -z "$(git status --porcelain)" ] || SHA="$SHA-dirty"
RELEASE="$(date -u +%Y%m%d%H%M%S)-$SHA"

echo "[deploy] building $RELEASE"
pnpm install --frozen-lockfile >/dev/null
pnpm build >/dev/null

echo "[deploy] uploading"
ssh "$HOST" install -d -m 0755 "/opt/mec/releases/$RELEASE"
rsync -az \
  --exclude node_modules --exclude .git --exclude '.env' --exclude '.env.*' --exclude coverage \
  --exclude '*.log' --exclude .DS_Store --exclude 'docs/*.pdf' --exclude .mec \
  ./ "$HOST:/opt/mec/releases/$RELEASE/"

echo "[deploy] installing, migrating, switching"
ssh "$HOST" bash -s -- "$RELEASE" <<'REMOTE'
set -euo pipefail
RELEASE="$1"
cd "/opt/mec/releases/$RELEASE"
chmod -R a+rX .
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --prod --frozen-lockfile --ignore-scripts >/dev/null
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' /etc/mec/control.env)"
runuser -u mec -- env DATABASE_URL="$DATABASE_URL" /usr/bin/node apps/control/dist/migrate.js
ln -sfn "/opt/mec/releases/$RELEASE" /opt/mec/current
systemctl restart mec-control
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4100/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:4100/healthz >/dev/null || { journalctl -u mec-control -n 50 --no-pager; exit 1; }
if systemctl is-enabled mec-runner >/dev/null 2>&1; then systemctl restart mec-runner; fi
# Keep the three newest releases.
ls -1dt /opt/mec/releases/* | tail -n +4 | xargs -r rm -rf
echo "[deploy] live: $RELEASE"
REMOTE
