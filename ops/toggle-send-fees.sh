#!/usr/bin/env bash
# Toggle accounts.send_fees_waived for one RPOW account.
#
# Run from the repo root on any host where the rpow stack is up:
#
#     ./ops/toggle-send-fees.sh alice          # by handle (case-insensitive)
#     ./ops/toggle-send-fees.sh 9aXt…pubkey…   # by base58 pubkey
#
# Flips the flag: if currently OFF -> ON, if ON -> OFF.
#
# Auto-detects which Docker Compose project is active:
#   prod : ops/aws-ec2/prod.env + ops/aws-ec2/compose.prod.yaml (rpow4-prod)
#   dev  : compose.yaml at the repo root                       (rpow4-dev)
#
# Talks straight to the `db` service via `psql`, so no server rebuild is
# required — the change is visible to /send immediately and to /me within
# the small TTL of the per-pubkey cache (~2 s).

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -ne 1 ]]; then
  echo "usage: $(basename "$0") <pubkey | handle>" >&2
  exit 1
fi
ARG="$1"

if [[ -f ops/aws-ec2/prod.env && -f ops/aws-ec2/compose.prod.yaml ]]; then
  COMPOSE=(docker compose --env-file ops/aws-ec2/prod.env -f ops/aws-ec2/compose.prod.yaml)
  MODE=prod
else
  COMPOSE=(docker compose)
  MODE=dev
fi

if ! "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx db; then
  echo "the 'db' service is not running (mode: $MODE). bring the stack up first." >&2
  exit 3
fi

# CTE version: find the row by pubkey OR case-insensitive display_name,
# flip the flag, return (pubkey, new_state, display_name) so this script
# can print a friendly summary. psql -v binds :'arg' as a quoted literal,
# so the value is never interpolated into the SQL text.
SQL=$(cat <<'EOF'
WITH match AS (
  SELECT pubkey FROM accounts
  WHERE pubkey = :'arg' OR lower(display_name) = lower(:'arg')
  LIMIT 1
),
upd AS (
  UPDATE accounts a
  SET send_fees_waived = NOT a.send_fees_waived
  FROM match m
  WHERE a.pubkey = m.pubkey
  RETURNING a.pubkey, a.send_fees_waived, COALESCE(a.display_name, '') AS display_name
)
SELECT pubkey, send_fees_waived, display_name FROM upd;
EOF
)

OUT=$(
  "${COMPOSE[@]}" exec -T db \
    psql -X -A -t -F '|' -U rpow -d rpow \
    -v arg="$ARG" \
    -c "$SQL"
)
OUT=$(printf '%s' "$OUT" | tr -d '\r' | sed -E '/^$/d')

if [[ -z "$OUT" ]]; then
  echo "no account matching '$ARG' (tried base58 pubkey + case-insensitive handle)" >&2
  exit 2
fi

IFS='|' read -r PUBKEY WAIVED HANDLE <<<"$OUT"
LABEL="$PUBKEY"
[[ -n "$HANDLE" ]] && LABEL="\"$HANDLE\" ($PUBKEY)"

if [[ "$WAIVED" == "t" ]]; then
  echo "send fees WAIVED for $LABEL"
else
  echo "send fees RESTORED (normal fees) for $LABEL"
fi
