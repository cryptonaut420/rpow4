-- The first cut of the launch-burn flow incremented `sent_base_units` on
-- the burning account, which broke the reconciliation invariant
-- `total_transferred = sum(sent_base_units)` (sent_base_units is meant to
-- be the cumulative outbound transfer total, not a generic "outflow"
-- counter). Burns are now kept out of sent_base_units in code, but any
-- existing dev/prod data has to be reversed.
--
-- For every BURN ledger event, decrement the actor's sent_base_units by
-- the burn amount. Idempotent against multiple migration runs because
-- this migration file only runs once (tracked in schema_migrations).

UPDATE account_balances ab
SET sent_base_units = ab.sent_base_units - burns.total
FROM (
  SELECT asset_id, actor_pubkey AS pubkey, sum(amount)::bigint AS total
  FROM ledger_events
  WHERE event_type = 'BURN'
  GROUP BY asset_id, actor_pubkey
) AS burns
WHERE ab.asset_id = burns.asset_id
  AND ab.pubkey = burns.pubkey
  AND ab.sent_base_units >= burns.total;
