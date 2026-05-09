-- 020_send_fees_memo.sql
--
-- Introduces three features:
--
--   1. Memo field on transfers (up to 64 chars, enforced at the API layer).
--
--   2. Per-transfer fees that halve with the block reward. The fee is
--      deducted from the sender's balance on top of the amount and credited
--      to the treasury account atomically in the same transaction.
--
--   3. A treasury system account (all-zero pubkey base58) that accumulates
--      collected fees. No private key corresponds to this address.
--
-- Schema changes:
--
--   ledger_events          + memo TEXT
--                          + fee_base_units BIGINT NOT NULL DEFAULT 0
--   ledger_recent_events   + memo TEXT
--                          + fee_base_units BIGINT NOT NULL DEFAULT 0
--   account_recent_events  + id UUID          (for transaction links)
--                          + memo TEXT
--                          + fee_base_units BIGINT NOT NULL DEFAULT 0
--   account_balances       + events_count BIGINT NOT NULL DEFAULT 0
--                            (maintained by mint/send for /activity total_count)
--
-- New app_counters rows:
--   total_fees_collected   — aggregate of all fee_base_units ever collected

-- ── ledger_transfer_idempotency ──────────────────────────────────────────────
-- Store the fee alongside the transfer so idempotent re-reads can return
-- the correct fee_base_units without re-querying ledger_events.
ALTER TABLE ledger_transfer_idempotency
  ADD COLUMN IF NOT EXISTS fee_base_units BIGINT NOT NULL DEFAULT 0
    CHECK (fee_base_units >= 0);

-- ── ledger_events ────────────────────────────────────────────────────────────
-- NOTE: ledger_events is partitioned. ADD COLUMN propagates to all partitions
-- automatically in Postgres 12+.
ALTER TABLE ledger_events
  ADD COLUMN IF NOT EXISTS memo TEXT,
  ADD COLUMN IF NOT EXISTS fee_base_units BIGINT NOT NULL DEFAULT 0
    CHECK (fee_base_units >= 0);

-- ── ledger_recent_events ─────────────────────────────────────────────────────
ALTER TABLE ledger_recent_events
  ADD COLUMN IF NOT EXISTS memo TEXT,
  ADD COLUMN IF NOT EXISTS fee_base_units BIGINT NOT NULL DEFAULT 0
    CHECK (fee_base_units >= 0);

-- ── account_recent_events ────────────────────────────────────────────────────
ALTER TABLE account_recent_events
  ADD COLUMN IF NOT EXISTS id UUID,
  ADD COLUMN IF NOT EXISTS memo TEXT,
  ADD COLUMN IF NOT EXISTS fee_base_units BIGINT NOT NULL DEFAULT 0
    CHECK (fee_base_units >= 0);

-- Backfill id from ledger_events for existing rows so links work on
-- already-recorded activity. On fresh databases this is a no-op.
UPDATE account_recent_events are
SET id = le.id
FROM ledger_event_ids le
WHERE are.event_seq = le.event_seq
  AND are.id IS NULL;

-- ── account_balances ─────────────────────────────────────────────────────────
ALTER TABLE account_balances
  ADD COLUMN IF NOT EXISTS events_count BIGINT NOT NULL DEFAULT 0
    CHECK (events_count >= 0);

-- Backfill: count events where this pubkey is actor (mints + sends) OR
-- counterparty (receives). Excludes the treasury pubkey from the
-- recipient count so fee-receive events don't pollute the treasury total
-- (the treasury won't have an activity feed anyway).
UPDATE account_balances ab
SET events_count = COALESCE(sq.n, 0)
FROM (
  SELECT pubkey, count(*) AS n
  FROM (
    SELECT actor_pubkey AS pubkey FROM ledger_events
    UNION ALL
    SELECT counterparty_pubkey AS pubkey
    FROM ledger_events
    WHERE counterparty_pubkey IS NOT NULL
      AND counterparty_pubkey <> '11111111111111111111111111111111'
  ) t
  GROUP BY pubkey
) sq
WHERE ab.pubkey = sq.pubkey;

-- ── Treasury account ─────────────────────────────────────────────────────────
-- Fixed all-zero address. No keypair exists for this pubkey. The server
-- credits fees here atomically inside every transfer transaction.
INSERT INTO accounts(pubkey)
VALUES ('11111111111111111111111111111111')
ON CONFLICT (pubkey) DO NOTHING;

INSERT INTO account_balances(pubkey, spendable_base_units, updated_at)
VALUES ('11111111111111111111111111111111', 0, now())
ON CONFLICT (pubkey) DO NOTHING;

-- ── Counters ─────────────────────────────────────────────────────────────────
INSERT INTO app_counters(name, value)
VALUES ('total_fees_collected', 0)
ON CONFLICT (name) DO NOTHING;
