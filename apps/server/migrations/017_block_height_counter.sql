-- 017_block_height_counter.sql
--
-- RPOW4 introduces a Bitcoin-style block-based issuance schedule:
-- the reward halves every 210,000 blocks (1 successful PoW = 1 block)
-- and difficulty steps up every 164,062 blocks. Both schedules read
-- from a monotonically increasing block-height counter, which is
-- maintained alongside `minted_supply` in `app_counters`.
--
-- This migration adds the counter and backfills it from the existing
-- `ledger_events` MINT count so that an in-flight database (dev, staging,
-- or a fresh prod) keeps a consistent block height when the new code
-- ships.

INSERT INTO app_counters(name, value)
SELECT 'block_height',
       (SELECT count(*) FROM ledger_events WHERE event_type = 'MINT')
ON CONFLICT (name) DO NOTHING;
