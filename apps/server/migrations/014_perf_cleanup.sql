-- 014_perf_cleanup.sql
--
-- Schema cleanup + storage tuning after the move to the account-balance +
-- ledger-events model in 013. Two things happen here:
--
--   1. The pre-013 transactional tables (tokens, transfers, challenges)
--      are no longer read or written by any code path. Their rows live
--      on as ledger_events / account_balances entries, copied during
--      013's backfill. Drop them so autovacuum, planner stats, and
--      pg_dump stop spending cycles on dead weight.
--
--   2. Configure fillfactor + autovacuum thresholds on the hot UPDATE
--      tables so that:
--        - HOT (heap-only-tuple) updates have room on each page and don't
--          touch the index, killing index bloat.
--        - autovacuum kicks in earlier than the default 20% threshold,
--          which is far too lazy for tables that take thousands of
--          UPDATEs per second.
--      Append-only ledger_events isn't tuned here — it's a different
--      shape (no UPDATEs).

DROP TABLE IF EXISTS challenges CASCADE;
DROP TABLE IF EXISTS tokens CASCADE;
DROP TABLE IF EXISTS transfers CASCADE;

-- account_balances: updated on every mint (1 row), every transfer (2 rows).
-- 20% slack per page leaves headroom for HOT updates; the write rate is
-- high enough that 5% bloat is too lazy.
ALTER TABLE account_balances SET (
  fillfactor = 80,
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

-- app_counters: 1-2 rows, updated on every mint. Heavy churn on a tiny
-- table is the textbook fillfactor-low / autovacuum-aggressive case.
ALTER TABLE app_counters SET (
  fillfactor = 70,
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02
);

-- ledger_stats: 2 rows, updated on every mint/transfer/signup.
ALTER TABLE ledger_stats SET (
  fillfactor = 70,
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.02
);

-- ledger_stat_shards: 64 rows, updated on every transfer (one shard).
ALTER TABLE ledger_stat_shards SET (
  fillfactor = 80,
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

-- accounts: updated on each /auth/session login (last_login_at) and on
-- display-name changes. Less hot than balances, so a gentler tuning.
ALTER TABLE accounts SET (
  fillfactor = 90,
  autovacuum_vacuum_scale_factor = 0.1
);
