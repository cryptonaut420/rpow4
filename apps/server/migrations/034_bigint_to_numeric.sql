-- 034_bigint_to_numeric.sql
--
-- Migrate every monetary / token-amount column from BIGINT to NUMERIC so that
-- custom RPOW assets with very large per-block rewards (e.g. 1 billion tokens
-- per block) never overflow.
--
-- DATA SAFETY: ALTER COLUMN TYPE … USING col::numeric is a lossless,
-- row-by-row rewrite. Every BIGINT value is exactly representable as NUMERIC,
-- so no data is lost or rounded. This migration runs inside the server's
-- startup transaction (statement_timeout = 0) and rolls back automatically if
-- anything fails, leaving the schema unchanged. Take a database backup before
-- deploying: ./deploy-aws-ec2.sh --backup-db
--
-- Non-monetary BIGINT columns are intentionally left unchanged:
--   • round IDs / BIGSERIAL primary keys (pool_rounds.id, pool_payouts.round_id)
--   • share counts  (pool_rounds.total_shares, pool_payouts.share_count)
--   • ledger sequence positions (event_seq, ledger_event_ids.event_seq)
--   • row / block / transfer counts (block_height, transfer_count, user_count,
--     events_count, blocks_mined, balance_row_count)
--   • shard index  (ledger_stat_shards.shard)
--
-- For partitioned tables (ledger_events, ledger_recent_events,
-- account_recent_events) ALTER TABLE on the parent automatically propagates
-- to all child partitions (PostgreSQL 12+).

-- ── account_balances ──────────────────────────────────────────────────────────
-- The ledger_accounting_reconciliation view references several of these
-- columns, so we drop it here and recreate it at the end of this migration.
DROP VIEW IF EXISTS ledger_accounting_reconciliation;

ALTER TABLE account_balances
  ALTER COLUMN spendable_base_units TYPE NUMERIC USING spendable_base_units::numeric,
  ALTER COLUMN minted_base_units    TYPE NUMERIC USING minted_base_units::numeric,
  ALTER COLUMN sent_base_units      TYPE NUMERIC USING sent_base_units::numeric,
  ALTER COLUMN received_base_units  TYPE NUMERIC USING received_base_units::numeric,
  ALTER COLUMN locked_base_units    TYPE NUMERIC USING locked_base_units::numeric;

-- ── app_counters ──────────────────────────────────────────────────────────────
-- value stores monetary names (minted_supply, burned_supply,
-- total_fees_collected) AND small count names (transfer_count, block_height).
-- NUMERIC handles both safely.
ALTER TABLE app_counters ALTER COLUMN value TYPE NUMERIC USING value::numeric;

-- ── ledger stats / shards ─────────────────────────────────────────────────────
ALTER TABLE ledger_stats      ALTER COLUMN value TYPE NUMERIC USING value::numeric;
ALTER TABLE ledger_stat_shards ALTER COLUMN value TYPE NUMERIC USING value::numeric;

-- ── canonical ledger (partitioned parent + hot mirrors + idempotency cache) ───
ALTER TABLE ledger_events
  ALTER COLUMN amount         TYPE NUMERIC USING amount::numeric,
  ALTER COLUMN fee_base_units TYPE NUMERIC USING fee_base_units::numeric;

ALTER TABLE ledger_recent_events
  ALTER COLUMN amount         TYPE NUMERIC USING amount::numeric,
  ALTER COLUMN fee_base_units TYPE NUMERIC USING fee_base_units::numeric;

ALTER TABLE account_recent_events
  ALTER COLUMN amount         TYPE NUMERIC USING amount::numeric,
  ALTER COLUMN fee_base_units TYPE NUMERIC USING fee_base_units::numeric;

ALTER TABLE ledger_transfer_idempotency
  ALTER COLUMN amount         TYPE NUMERIC USING amount::numeric,
  ALTER COLUMN fee_base_units TYPE NUMERIC USING fee_base_units::numeric;

-- ── assets configuration ──────────────────────────────────────────────────────
ALTER TABLE assets
  ALTER COLUMN max_supply_base_units          TYPE NUMERIC USING max_supply_base_units::numeric,
  ALTER COLUMN base_units_per_coin            TYPE NUMERIC USING base_units_per_coin::numeric,
  ALTER COLUMN initial_reward_base_units      TYPE NUMERIC USING initial_reward_base_units::numeric,
  ALTER COLUMN reward_reduction_value         TYPE NUMERIC USING reward_reduction_value::numeric,
  ALTER COLUMN transfer_fee_base_units        TYPE NUMERIC USING transfer_fee_base_units::numeric,
  ALTER COLUMN founder_allocation_base_units  TYPE NUMERIC USING founder_allocation_base_units::numeric,
  ALTER COLUMN treasury_allocation_base_units TYPE NUMERIC USING treasury_allocation_base_units::numeric;

-- ── faucet / claim tokens ─────────────────────────────────────────────────────
ALTER TABLE faucet_claims ALTER COLUMN amount_base_units TYPE NUMERIC USING amount_base_units::numeric;
ALTER TABLE claim_tokens  ALTER COLUMN amount_base_units TYPE NUMERIC USING amount_base_units::numeric;

-- ── pool mining: reward amounts only (round IDs / share counts stay BIGINT) ───
ALTER TABLE pool_rounds
  ALTER COLUMN reward_base_units        TYPE NUMERIC USING reward_base_units::numeric,
  ALTER COLUMN treasury_cut_base_units  TYPE NUMERIC USING treasury_cut_base_units::numeric,
  ALTER COLUMN finder_payout_base_units TYPE NUMERIC USING finder_payout_base_units::numeric,
  ALTER COLUMN pro_rata_pool_base_units TYPE NUMERIC USING pro_rata_pool_base_units::numeric;

ALTER TABLE pool_payouts
  ALTER COLUMN payout_base_units TYPE NUMERIC USING payout_base_units::numeric;

-- ── RPOW2 custody ─────────────────────────────────────────────────────────────
ALTER TABLE external_deposits   ALTER COLUMN amount_base_units TYPE NUMERIC USING amount_base_units::numeric;
ALTER TABLE external_withdrawals ALTER COLUMN amount_base_units TYPE NUMERIC USING amount_base_units::numeric;

-- ── internal markets ─────────────────────────────────────────────────────────
ALTER TABLE market_orders
  ALTER COLUMN price_quote_base_units        TYPE NUMERIC USING price_quote_base_units::numeric,
  ALTER COLUMN original_base_units           TYPE NUMERIC USING original_base_units::numeric,
  ALTER COLUMN remaining_base_units          TYPE NUMERIC USING remaining_base_units::numeric,
  ALTER COLUMN reserved_remaining_base_units TYPE NUMERIC USING reserved_remaining_base_units::numeric;

ALTER TABLE market_trades
  ALTER COLUMN price_quote_base_units  TYPE NUMERIC USING price_quote_base_units::numeric,
  ALTER COLUMN base_amount_base_units  TYPE NUMERIC USING base_amount_base_units::numeric,
  ALTER COLUMN quote_amount_base_units TYPE NUMERIC USING quote_amount_base_units::numeric,
  ALTER COLUMN fee_base_units          TYPE NUMERIC USING fee_base_units::numeric;

-- ── trollbox ──────────────────────────────────────────────────────────────────
ALTER TABLE trollbox_messages ALTER COLUMN fee_base_units TYPE NUMERIC USING fee_base_units::numeric;

-- ── legacy tables (conditional — may not exist in all environments) ───────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'tokens' AND column_name = 'value') THEN
    ALTER TABLE tokens ALTER COLUMN value TYPE NUMERIC USING value::numeric;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'transfers' AND column_name = 'amount') THEN
    ALTER TABLE transfers ALTER COLUMN amount TYPE NUMERIC USING amount::numeric;
  END IF;
END $$;

-- ── recreate reconciliation view with ::numeric casts ─────────────────────────
-- (was ::bigint from migration 032; those casts would overflow for large-value
-- custom assets now that the underlying columns are NUMERIC)
CREATE VIEW ledger_accounting_reconciliation AS
WITH balance_totals AS (
  SELECT
    asset_id,
    COALESCE(sum(spendable_base_units), 0)::numeric                          AS spendable_base_units,
    COALESCE(sum(locked_base_units), 0)::numeric                             AS locked_base_units,
    COALESCE(sum(spendable_base_units + locked_base_units), 0)::numeric      AS total_balance_base_units,
    COALESCE(sum(minted_base_units), 0)::numeric                             AS minted_base_units,
    COALESCE(sum(sent_base_units), 0)::numeric                               AS sent_base_units,
    COALESCE(sum(received_base_units), 0)::numeric                           AS received_base_units,
    count(*)::bigint                                                         AS balance_row_count
  FROM account_balances
  GROUP BY asset_id
),
stats AS (
  SELECT
    a.id AS asset_id,
    a.asset_kind,
    COALESCE((SELECT value FROM app_counters      WHERE asset_id = a.id AND name = 'minted_supply'),    0)::numeric AS minted_supply_counter,
    COALESCE((SELECT value FROM ledger_stats      WHERE asset_id = a.id AND name = 'circulating_supply'), 0)::numeric AS circulating_supply,
    COALESCE((SELECT value FROM ledger_stats      WHERE asset_id = a.id AND name = 'user_count'),       0)::bigint  AS user_count,
    COALESCE((SELECT sum(value) FROM ledger_stat_shards WHERE asset_id = a.id AND name = 'total_transferred'), 0)::numeric AS total_transferred
  FROM assets a
)
SELECT
  stats.asset_id,
  stats.minted_supply_counter,
  COALESCE(balance_totals.minted_base_units, 0)::numeric           AS minted_base_units,
  stats.circulating_supply,
  COALESCE(balance_totals.spendable_base_units, 0)::numeric        AS spendable_base_units,
  COALESCE(balance_totals.locked_base_units, 0)::numeric           AS locked_base_units,
  COALESCE(balance_totals.total_balance_base_units, 0)::numeric    AS total_balance_base_units,
  stats.total_transferred,
  COALESCE(balance_totals.sent_base_units, 0)::numeric             AS sent_base_units,
  COALESCE(balance_totals.received_base_units, 0)::numeric         AS received_base_units,
  stats.user_count,
  COALESCE(balance_totals.balance_row_count, 0)::bigint            AS balance_row_count,
  (stats.asset_kind = 'external_custodial' OR stats.minted_supply_counter = COALESCE(balance_totals.minted_base_units, 0)) AS minted_matches_balances,
  (stats.circulating_supply = COALESCE(balance_totals.total_balance_base_units, 0))      AS circulating_matches_balances,
  (stats.total_transferred  = COALESCE(balance_totals.sent_base_units, 0))               AS transferred_matches_sent,
  (stats.total_transferred  = COALESCE(balance_totals.received_base_units, 0))           AS transferred_matches_received,
  (stats.user_count         = COALESCE(balance_totals.balance_row_count, 0))             AS user_count_matches_balances
FROM stats
LEFT JOIN balance_totals ON balance_totals.asset_id = stats.asset_id;
