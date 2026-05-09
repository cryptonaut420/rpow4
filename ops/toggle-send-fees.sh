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

# On a stock Ubuntu EC2 host the deploying user is usually not in the
# `docker` group, so `docker …` fails with EACCES on /var/run/docker.sock
# while `sudo docker …` works. Probe once and prefix every subsequent
# call accordingly. Suppress only the connectivity-probe output; real
# errors below remain visible.
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

# `ps --status running --services` lists service names of running containers.
# Failure here is a real configuration / permission problem, so let stderr
# through instead of swallowing it.
RUNNING=$("${COMPOSE[@]}" ps --status running --services)
if ! grep -qx db <<<"$RUNNING"; then
  echo "the 'db' service is not running (mode: $MODE). bring the stack up first." >&2
  exit 3
fi

# CTE: find the row by pubkey OR case-insensitive display_name, flip the
# flag, return (pubkey, new_state, display_name) for a friendly summary.
#
# The SQL is fed in through stdin (not -c) because psql variable
# substitution (`:'arg'` → safely quoted SQL literal) is only performed
# for stdin / file input, not for command-string mode. -v binds the
# value globally; the heredoc just carries the SQL.
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
  SET send_fees_waived = NOT a.send_fees_waived
  FROM match m
  WHERE a.pubkey = m.pubkey
  RETURNING a.pubkey, a.send_fees_waived, COALESCE(a.display_name, '') AS display_name
)
SELECT pubkey, send_fees_waived, display_name FROM upd;
SQL
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
