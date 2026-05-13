#!/usr/bin/env bash
# Repair a custom RPOW asset that was assigned a wrong sequence number due to
# the RPOW2 sentinel sequence (2000002) being included in the MAX() query.
#
# Usage (run from repo root):
#
#   ./ops/repair-asset-sequence.sh <wrong_display_code> <correct_seq>
#
# Examples:
#   ./ops/repair-asset-sequence.sh RPOW4.2000003 1
#   ./ops/repair-asset-sequence.sh RPOW4.2000004 2
#
# What it fixes:
#   assets.sequence_number   wrong → correct
#   assets.display_code      RPOW4.2000003 → RPOW4.1
#   assets.slug              rpow4-2000003-* → rpow4-1-* (if auto-generated)
#   markets.symbol           RPOW4.2000003/RPOW4.0 → RPOW4.1/RPOW4.0
#   ledger_events.memo       "launch RPOW4.2000003" → "launch RPOW4.1"
#
# Talks straight to the `db` service via psql — no server rebuild needed.
# After running, restart the server container to clear any in-memory asset cache.

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -ne 2 ]]; then
  echo "usage: $(basename "$0") <wrong_display_code> <correct_seq>" >&2
  echo "  e.g: $(basename "$0") RPOW4.2000003 1" >&2
  exit 1
fi

WRONG_CODE="$1"
CORRECT_SEQ="$2"
CORRECT_CODE="RPOW4.${CORRECT_SEQ}"

DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1; then
    DOCKER=(sudo docker)
  else
    echo "docker is not reachable as $(whoami)" >&2
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

echo "=== RPOW Asset Sequence Repair ==="
echo "  Mode          : $MODE"
echo "  Wrong code    : $WRONG_CODE"
echo "  Correct code  : $CORRECT_CODE (sequence $CORRECT_SEQ)"
echo ""

# Dry-run: show what would change
echo "--- Current state ---"
"${COMPOSE[@]}" exec -T db \
  psql -X -U rpow -d rpow \
  -v wrong_code="$WRONG_CODE" \
  -v correct_code="$CORRECT_CODE" \
  -v correct_seq="$CORRECT_SEQ" \
<<'SQL'
SELECT
  a.sequence_number,
  a.display_code,
  a.slug,
  a.nickname,
  a.asset_kind,
  a.status,
  (SELECT symbol FROM markets WHERE base_asset_id = a.id LIMIT 1) AS market_symbol
FROM assets a
WHERE a.display_code = :'wrong_code';
SQL

echo ""
read -r -p "Apply repair? [y/N] " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  echo "Aborted." >&2
  exit 0
fi

# Apply in a single transaction
"${COMPOSE[@]}" exec -T db \
  psql -X -U rpow -d rpow \
  -v wrong_code="$WRONG_CODE" \
  -v correct_code="$CORRECT_CODE" \
  -v correct_seq="$CORRECT_SEQ" \
<<'SQL'
BEGIN;

-- 1. Check the target sequence number is not already taken
DO $$
DECLARE
  cnt int;
BEGIN
  SELECT count(*) INTO cnt FROM assets
  WHERE sequence_number = current_setting('wrong_code.seq', true)::int
    AND display_code <> current_setting('wrong_code.code', true);
END;
$$;

-- 2. Fix the asset row
UPDATE assets
SET
  sequence_number = :'correct_seq'::int,
  display_code    = :'correct_code',
  -- Fix slug only if it was auto-generated (contains the wrong seq number)
  slug = CASE
    WHEN slug LIKE 'rpow4-' || split_part(:'wrong_code', '.', 2) || '-%'
    THEN 'rpow4-' || :'correct_seq' || '-' ||
         substr(slug, length('rpow4-' || split_part(:'wrong_code', '.', 2) || '-') + 1)
    ELSE slug
  END
WHERE display_code = :'wrong_code';

-- 3. Fix market symbol
UPDATE markets
SET symbol = :'correct_code' || '/RPOW4.0'
WHERE symbol = :'wrong_code' || '/RPOW4.0';

-- 4. Fix burn event memo
UPDATE ledger_events
SET memo = 'launch ' || :'correct_code'
WHERE memo = 'launch ' || :'wrong_code';

-- 5. Show result
SELECT
  a.sequence_number,
  a.display_code,
  a.slug,
  (SELECT symbol FROM markets WHERE base_asset_id = a.id LIMIT 1) AS market_symbol,
  (SELECT memo FROM ledger_events
   WHERE actor_pubkey = a.creator_pubkey AND event_type = 'BURN'
     AND memo LIKE 'launch %'
   ORDER BY created_at DESC LIMIT 1) AS burn_memo
FROM assets a
WHERE a.display_code = :'correct_code';

COMMIT;
SQL

echo ""
echo "Done. Restart the server container to clear the in-memory asset cache:"
echo "  cd ops/aws-ec2 && docker compose -f compose.prod.yaml restart server"
