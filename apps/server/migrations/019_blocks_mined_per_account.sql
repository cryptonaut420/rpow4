-- 019_blocks_mined_per_account.sql
--
-- A second leaderboard ("most mined") needs a per-account block count
-- — `minted_base_units / current_reward` doesn't work because the reward
-- changes at every halving, so the same minted-base-units total can
-- represent different block counts depending on when it was earned.
--
-- We maintain `account_balances.blocks_mined` as a monotonically
-- incrementing counter, bumped atomically inside the same UPSERT that
-- already credits `minted_base_units` on every accepted PoW. Backfill
-- from MINT events so existing accounts get the right starting count.
--
-- A partial DESC index supports the second leaderboard sort. Same
-- shape as the partial index added in migration 018, just keyed on
-- minted_base_units.

ALTER TABLE account_balances
  ADD COLUMN IF NOT EXISTS blocks_mined BIGINT NOT NULL DEFAULT 0
    CHECK (blocks_mined >= 0);

UPDATE account_balances ab
SET blocks_mined = sub.n
FROM (
  SELECT actor_pubkey AS pubkey, count(*)::bigint AS n
  FROM ledger_events
  WHERE event_type = 'MINT'
  GROUP BY actor_pubkey
) sub
WHERE ab.pubkey = sub.pubkey
  AND ab.blocks_mined <> sub.n;

CREATE INDEX IF NOT EXISTS account_balances_minted_desc_idx
  ON account_balances(minted_base_units DESC, pubkey)
  WHERE minted_base_units > 0;
