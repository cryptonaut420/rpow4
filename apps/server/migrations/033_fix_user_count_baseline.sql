-- ── Reconcile baseline user_count with account_balances row count ─────────────
--
-- Migration 020 seeds the treasury account_balances row (the system account
-- that collects fees) but never bumped ledger_stats.user_count to match. After
-- migration 027 backfilled asset_id, this manifests as a baseline drift in
-- ledger_accounting_reconciliation.user_count_matches_balances for the
-- default asset and for any system asset that was given a treasury seat
-- without a corresponding user_count adjustment.
--
-- All NEW writers correctly bump user_count via the (xmax = 0) idiom on
-- INSERT ... ON CONFLICT, so this one-time corrective UPDATE is the cleanest
-- way to true up the historical drift. Re-running the migration is a no-op
-- because the SET clause is computed from the current account_balances state.

UPDATE ledger_stats AS ls
   SET value = sub.row_count,
       updated_at = now()
  FROM (
    SELECT asset_id, count(*)::bigint AS row_count
      FROM account_balances
     GROUP BY asset_id
  ) AS sub
 WHERE ls.asset_id = sub.asset_id
   AND ls.name = 'user_count'
   AND ls.value <> sub.row_count;
