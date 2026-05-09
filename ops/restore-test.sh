#!/usr/bin/env bash
# Restore the latest backup into a scratch DB and assert row counts.
# This is the proof-of-life for the backup system.
set -euo pipefail

# shellcheck disable=SC1091
source /etc/rpow/restic.env
export B2_ACCOUNT_ID B2_ACCOUNT_KEY RESTIC_REPOSITORY RESTIC_PASSWORD

SCRATCH=rpow_restore_test
sudo -u postgres dropdb --if-exists "$SCRATCH"
sudo -u postgres createdb -O rpow_app "$SCRATCH"

LATEST=$(restic snapshots --tag rpow --json | jq -r 'sort_by(.time) | .[-1].id')
DUMP_PATH=$(restic snapshots --tag rpow --json | jq -r 'sort_by(.time) | .[-1].paths[0]')
echo "Restoring snapshot $LATEST ($DUMP_PATH)..."

restic dump "$LATEST" "$DUMP_PATH" \
    | sudo -u postgres pg_restore --no-owner --no-privileges -d "$SCRATCH"

echo "Row counts on restored scratch DB:"
sudo -u postgres psql -d "$SCRATCH" -c "
  SELECT 'accounts' AS tbl, count(*) FROM accounts
  UNION ALL SELECT 'account_balances', count(*) FROM account_balances
  UNION ALL SELECT 'ledger_events', count(*) FROM ledger_events
  UNION ALL SELECT 'ledger_event_ids', count(*) FROM ledger_event_ids
  UNION ALL SELECT 'ledger_mint_claims', count(*) FROM ledger_mint_claims
  UNION ALL SELECT 'ledger_transfer_idempotency', count(*) FROM ledger_transfer_idempotency
  UNION ALL SELECT 'ledger_recent_events', count(*) FROM ledger_recent_events
  UNION ALL SELECT 'account_recent_events', count(*) FROM account_recent_events
  UNION ALL SELECT 'ledger_stats', count(*) FROM ledger_stats
  UNION ALL SELECT 'ledger_stat_shards', count(*) FROM ledger_stat_shards
  ORDER BY tbl;
"

sudo -u postgres dropdb "$SCRATCH"
echo "Restore drill OK."
