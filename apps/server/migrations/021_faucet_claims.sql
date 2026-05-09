-- 021_faucet_claims.sql
--
-- Public faucet that grants free tokens from the treasury once per
-- cooldown window per (pubkey, IP) pair. Each successful claim records
-- a row here so the cooldown check is just a single B-tree lookup, and
-- the actual debit/credit/event-row work reuses the standard transfer
-- ledger paths so faucet drips show up in /activity, /explorer, and
-- /ledger like any other transfer.

CREATE TABLE IF NOT EXISTS faucet_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Account that received the drip.
  pubkey TEXT NOT NULL,
  -- Originating IP (post-trustProxy). Stored as text to match Postgres
  -- inet/text behavior elsewhere in the schema; we never do CIDR-style
  -- matching, only equality.
  ip TEXT NOT NULL,
  amount_base_units BIGINT NOT NULL CHECK (amount_base_units > 0),
  -- The TRANSFER ledger event id created for this claim, so callers can
  -- jump from a faucet row straight into the explorer.
  transfer_event_id UUID,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Both lookups are "did `key` claim within the last N hours?". A DESC
-- index on `claimed_at` lets the cooldown probe stop after the first
-- row, so the check stays O(log n) regardless of total claim history.
CREATE INDEX IF NOT EXISTS faucet_claims_pubkey_claimed_at_idx
  ON faucet_claims(pubkey, claimed_at DESC);
CREATE INDEX IF NOT EXISTS faucet_claims_ip_claimed_at_idx
  ON faucet_claims(ip, claimed_at DESC);
