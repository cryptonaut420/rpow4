-- 026_pool_payouts_event_id.sql
--
-- Pool payouts now flow as MINT events directly to each participant
-- rather than as TRANSFER events from the treasury. The linkage column
-- on pool_payouts therefore points at a MINT event UUID in the general
-- case (historical rows that predate this migration may still point at
-- a TRANSFER UUID — both live in ledger_events and resolve correctly).
--
-- Rename the column to reflect the broader semantics. The underlying
-- type (UUID) is unchanged so existing rows remain valid.

ALTER TABLE pool_payouts RENAME COLUMN transfer_event_id TO event_id;
