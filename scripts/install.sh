#!/usr/bin/env bash
# MEC — one-command install from the GitHub release (review 2026-11-04 §3.1).
# Read it before you run it: ~40 lines, stdlib only, no sudo, installs into ~/.mec.
set -euo pipefail

repo="MubitLabs/mubit-engineering-control"
install_dir="$HOME/.mec/app"
bin_dir="$HOME/.local/bin"
bin_link="$bin_dir/mec"

fail() { echo "install: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing prerequisite: $1 — $2"; }

need curl "install it (e.g. brew install curl) and re-run"
need node "MEC needs Node >= 22.18 — https://nodejs.org"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || fail "Node >= 22.18 required (found $(node -v))"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
[ "$os" = "darwin" ] || [ "$os" = "linux" ] || fail "unsupported OS: $(uname -s) (macOS and Linux are supported)"

echo "install: fetching the latest release"
url_base="https://github.com/$repo/releases/latest/download"
http_code="$(curl -fsSL -o /dev/null -w '%{http_code}' "$url_base/mec-latest.tgz" || true)"
[ "$http_code" = "200" ] || fail "no release artifact yet (HTTP $http_code) — install from source: see the README"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/mec.tgz" "$url_base/mec-latest.tgz"

mkdir -p "$install_dir"
rm -rf "${install_dir:?}"/*
tar xzf "$tmp/mec.tgz" -C "$install_dir"

echo "install: building the two native modules (better-sqlite3, node-pty)"
( cd "$install_dir" && npm install --omit=dev --no-audit --no-fund ) \
  || fail "native build failed — if the message mentions prebuilds, see docs/known-limits.md"

mkdir -p "$bin_dir"
ln -sf "$install_dir/bin/mec.js" "$bin_link"
chmod +x "$install_dir/bin/mec.js"

echo "installed: $bin_link → $install_dir"
echo "next:      run 'mec' — the workbench opens in your browser at Setup"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "note:      $bin_dir is not on your PATH; add it to use 'mec' from anywhere" ;;
esac
