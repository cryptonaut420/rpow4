#!/usr/bin/env bash
# Run by the `server` service in compose.yaml.
# 1. Wait until the db container accepts connections.
# 2. Ensure a persistent dev signing keypair exists in the runtime volume.
# 3. Exec `tsx watch` so source edits hot-reload the running server.
set -euo pipefail

cd /app

DB_HOST=${PGHOST:-db}
DB_USER=${PGUSER:-rpow}

echo "[server] waiting for postgres at ${DB_HOST}..."
until pg_isready -h "$DB_HOST" -U "$DB_USER" >/dev/null 2>&1; do
  sleep 0.5
done
echo "[server] postgres is ready"

mkdir -p /app/.runtime
KEYS_FILE=/app/.runtime/signing-keys.env
if [ ! -s "$KEYS_FILE" ]; then
  echo "[server] generating dev Ed25519 signing keypair (one-time)..."
  node /app/docker/gen-keys.mjs > "$KEYS_FILE"
  echo "[server] wrote $KEYS_FILE"
fi
# Inject RPOW_SIGNING_{PRIVATE,PUBLIC}_KEY_HEX into the env for the server.
set -a
# shellcheck disable=SC1090
. "$KEYS_FILE"
set +a

echo "[server] starting tsx watch on apps/server/src/server.ts..."
exec npx --no-install tsx watch apps/server/src/server.ts
