-- Drops the stale event_type CHECK constraint left over from migration
-- 015 on ledger_events. ledger_events is partitioned, and its per-partition
-- CHECK constraints exist independently of the parent's constraint — so
-- the DROP/ADD CONSTRAINT in 027 left an old `_check1` (restricted to
-- MINT/TRANSFER) on every partition AND on the parent. The new permissive
-- `_check` (which also allows BURN and GENESIS_ALLOCATION) was added on
-- top, but rows must satisfy every CHECK on the partition, so launching a
-- new asset fails with:
--   new row for relation "ledger_events_pNNN" violates check constraint
--   "ledger_events_event_type_check1"
-- Dropping the stale constraint at the parent cascades to all partitions
-- in a single statement.

ALTER TABLE ledger_events DROP CONSTRAINT IF EXISTS ledger_events_event_type_check1;
