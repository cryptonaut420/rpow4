-- 016_drop_redundant_hot_indexes.sql
--
-- 015 briefly created explicit DESC indexes on hot tables. Their primary
-- keys already support the same scans by walking the btree backward:
--
--   ledger_recent_events_pkey(event_seq)
--   account_recent_events_pkey(pubkey, event_seq, type)
--
-- Drop the redundant copies to reduce write amplification on every mint/send.

DROP INDEX IF EXISTS ledger_recent_events_seq_desc_idx;
DROP INDEX IF EXISTS account_recent_events_pubkey_seq_idx;
