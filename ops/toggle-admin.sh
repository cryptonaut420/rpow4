#!/usr/bin/env bash
# Toggle accounts.is_admin for one RPOW account.
#
# Run from the repo root on any host where the rpow stack is up:
#
#     ./ops/toggle-admin.sh cryptonaut       # by handle (case-insensitive)
#     ./ops/toggle-admin.sh 9aXt…pubkey…     # by base58 pubkey
#
# Flips the flag: if currently OFF -> ON (admin enabled), if ON -> OFF (revoked).
#
# Auto-detects which Docker Compose project is active:
#   prod : ops/aws-ec2/prod.env + ops/aws-ec2/compose.prod.yaml (rpow4-prod)
#   dev  : compose.yaml at the repo root                        (rpow4-dev)
#
# Talks straight to the `db` service via `psql` — no server rebuild needed.
# The change is visible to /me and the admin UI within the session cache TTL (~2s).

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -ne 1 ]]; then
  echo "usage: $(basename "$0") <pubkey | handle>" >&2
  exit 1
fi
ARG="$1"

DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1; then
    DOCKER=(sudo docker)
  else
    echo "docker is not reachable as $(whoami) and 'sudo' is unavailable." >&2
    echo "fix: add user to the docker group (sudo usermod -aG docker $(whoami) && newgrp docker)" >&2
    exit 4
  fi
fi

if [[ -f ops/aws-ec2/prod.env && -f ops/aws-ec2/compose.prod.yaml ]]; then
  COMPOSE=("${DOCKER[@]}" compose --env-file ops/aws-ec2/prod.env -f ops/aws-ec2/compose.prod.yaml)
  MODE=prod
else
  COMPOSE=("${DOCKER[@]}" compose)
  MODE=dev
fi

RUNNING=$("${COMPOSE[@]}" ps --status running --services)
if ! grep -qx db <<<"$RUNNING"; then
  echo "the 'db' service is not running (mode: $MODE). bring the stack up first." >&2
  exit 3
fi

OUT=$(
  "${COMPOSE[@]}" exec -T db \
    psql -X -A -t -F '|' -U rpow -d rpow \
    -v arg="$ARG" \
<<'SQL'
WITH match AS (
  SELECT pubkey FROM accounts
  WHERE pubkey = :'arg' OR lower(display_name) = lower(:'arg')
  LIMIT 1
),
upd AS (
  UPDATE accounts a
  SET is_admin = NOT a.is_admin
  FROM match m
  WHERE a.pubkey = m.pubkey
  RETURNING a.pubkey, a.is_admin, COALESCE(a.display_name, '') AS display_name
)
SELECT pubkey, is_admin, display_name FROM upd;
SQL
)
OUT=$(printf '%s' "$OUT" | tr -d '\r' | sed -E '/^$/d')

if [[ -z "$OUT" ]]; then
  echo "no account matching '$ARG' (tried base58 pubkey + case-insensitive handle)" >&2
  exit 2
fi

IFS='|' read -r PUBKEY IS_ADMIN HANDLE <<<"$OUT"
LABEL="$PUBKEY"
[[ -n "$HANDLE" ]] && LABEL="\"$HANDLE\" ($PUBKEY)"

if [[ "$IS_ADMIN" == "t" ]]; then
  echo "admin ENABLED for $LABEL"
else
  echo "admin REVOKED for $LABEL"
fi
