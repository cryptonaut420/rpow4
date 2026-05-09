-- Run against both source and target Postgres post-restore.
-- Output should be IDENTICAL row-for-row, table-for-table.
-- If any row differs, ABORT cutover.
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
UNION ALL SELECT 'schema_migrations', count(*) FROM schema_migrations
ORDER BY tbl;
