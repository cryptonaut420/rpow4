-- 018_stats_counters.sql
--
-- Public stats page (top-100 leaderboard + send count) needs two things
-- the existing schema doesn't already maintain:
--
--   1. A monotonically-incremented `transfer_count` counter so /ledger
--      and the stats page can return "how many sends ever" in O(1).
--      Backfilled from existing TRANSFER events; the send route increments
--      it atomically inside the same CTE that writes the ledger event.
--
--   2. A partial DESC index on account_balances.spendable_base_units so
--      `ORDER BY spendable_base_units DESC LIMIT 100` runs as a tiny
--      index range scan instead of a full table sort. Partial because
--      the long tail of zero-balance accounts is the bulk of the table
--      and never appears on the leaderboard. Trailing pubkey gives a
--      deterministic tie-break order.

INSERT INTO app_counters(name, value)
SELECT 'transfer_count',
       (SELECT count(*) FROM ledger_events WHERE event_type = 'TRANSFER')
ON CONFLICT (name) DO NOTHING;

CREATE INDEX IF NOT EXISTS account_balances_spendable_desc_idx
  ON account_balances(spendable_base_units DESC, pubkey)
  WHERE spendable_base_units > 0;
