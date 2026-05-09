#!/usr/bin/env bash
# One-shot dependency install + workspace package builds. Run by the
# `install` service in compose.yaml; subsequent `docker compose up` calls
# detect the sentinel file and exit fast.
#
# Force a fresh install:
#   docker compose run --rm install rm -f node_modules/.dev-installed
set -euo pipefail

cd /app

SENTINEL=node_modules/.dev-installed
SHARED_BUILT=packages/shared/dist/index.js

if [ -f "$SENTINEL" ] && [ -f "$SHARED_BUILT" ]; then
  echo "[install] node_modules + workspace builds already present (skip)"
  echo "[install] to force a rebuild: docker compose run --rm install rm -f $SENTINEL"
  exit 0
fi

echo "[install] running npm ci across workspaces..."
npm ci --workspaces --include-workspace-root --ignore-scripts

echo "[install] building @rpow/shared..."
npm run build --workspace @rpow/shared

touch "$SENTINEL"
echo "[install] done"
