-- 027_multi_assets.sql
--
-- Introduce first-class mineable assets. Existing RPOW4 state is backfilled
-- into the immutable default asset (RPOW4.0); new user-created assets share
-- the same ledger/accounting machinery via asset_id.

CREATE TABLE IF NOT EXISTS assets (
  id UUID PRIMARY KEY,
  family_code TEXT NOT NULL DEFAULT 'RPOW4',
  sequence_number INTEGER NOT NULL UNIQUE CHECK (sequence_number >= 0),
  display_code TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  nickname TEXT NOT NULL CHECK (char_length(nickname) BETWEEN 3 AND 40),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 280),
  creator_pubkey TEXT REFERENCES accounts(pubkey),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  system_default BOOLEAN NOT NULL DEFAULT false,
  supply_mode TEXT NOT NULL DEFAULT 'capped' CHECK (supply_mode IN ('capped','unlimited')),
  max_supply_base_units BIGINT CHECK (max_supply_base_units IS NULL OR max_supply_base_units > 0),
  base_units_per_coin BIGINT NOT NULL DEFAULT 1000000000 CHECK (base_units_per_coin = 1000000000),
  initial_reward_base_units BIGINT NOT NULL CHECK (initial_reward_base_units > 0),
  reward_schedule_type TEXT NOT NULL DEFAULT 'halving_by_blocks'
    CHECK (reward_schedule_type IN ('none','halving_by_blocks','percent_by_blocks','fixed_by_blocks')),
  reward_interval_blocks INTEGER NOT NULL CHECK (reward_interval_blocks > 0),
  reward_reduction_type TEXT NOT NULL DEFAULT 'percent'
    CHECK (reward_reduction_type IN ('none','percent','fixed')),
  reward_reduction_value BIGINT NOT NULL DEFAULT 50 CHECK (reward_reduction_value >= 0),
  difficulty_schedule_type TEXT NOT NULL DEFAULT 'linear_by_blocks'
    CHECK (difficulty_schedule_type IN ('linear_by_blocks')),
  difficulty_start_bits INTEGER NOT NULL CHECK (difficulty_start_bits BETWEEN 4 AND 64),
  difficulty_step_blocks INTEGER NOT NULL CHECK (difficulty_step_blocks > 0),
  difficulty_max_bits INTEGER NOT NULL CHECK (difficulty_max_bits BETWEEN 4 AND 64),
  mining_algo TEXT NOT NULL DEFAULT 'rpow_classic' CHECK (mining_algo IN ('rpow_classic')),
  pool_enabled BOOLEAN NOT NULL DEFAULT true,
  pool_enable_at_difficulty_bits INTEGER CHECK (pool_enable_at_difficulty_bits IS NULL OR pool_enable_at_difficulty_bits BETWEEN 4 AND 64),
  pool_fee_bps INTEGER NOT NULL DEFAULT 200 CHECK (pool_fee_bps BETWEEN 0 AND 2000),
  pool_finder_bps INTEGER NOT NULL DEFAULT 2500 CHECK (pool_finder_bps BETWEEN 0 AND 10000),
  pool_share_bits INTEGER NOT NULL DEFAULT 24 CHECK (pool_share_bits BETWEEN 4 AND 64),
  transfer_fee_base_units BIGINT NOT NULL DEFAULT 0 CHECK (transfer_fee_base_units >= 0),
  founder_allocation_base_units BIGINT NOT NULL DEFAULT 0 CHECK (founder_allocation_base_units >= 0),
  treasury_allocation_base_units BIGINT NOT NULL DEFAULT 0 CHECK (treasury_allocation_base_units >= 0),
  launch_burn_event_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS assets_one_default_idx
  ON assets(system_default)
  WHERE system_default;

INSERT INTO assets (
  id, sequence_number, display_code, slug, nickname, description,
  system_default, supply_mode, max_supply_base_units, initial_reward_base_units,
  reward_schedule_type, reward_interval_blocks, reward_reduction_type,
  reward_reduction_value, difficulty_schedule_type, difficulty_start_bits,
  difficulty_step_blocks, difficulty_max_bits, mining_algo, pool_enabled,
  pool_fee_bps, pool_finder_bps, pool_share_bits, transfer_fee_base_units
)
VALUES (
  '00000000-0000-4000-8000-000000000000',
  0,
  'RPOW4.0',
  'rpow4-0',
  'RPOW4',
  'The original RPOW4 asset.',
  true,
  'capped',
  21000000::bigint * 1000000000::bigint,
  50000000000,
  'halving_by_blocks',
  210000,
  'percent',
  50,
  'linear_by_blocks',
  24,
  50000,
  50,
  'rpow_classic',
  true,
  200,
  2500,
  24,
  1000000000
)
ON CONFLICT (id) DO NOTHING;

-- Event type expansion for true burns and explicit genesis allocations.
-- Drop both the canonical name and any auto-suffixed duplicate Postgres
-- may have left behind on a partitioned table from prior schema churn —
-- partition-level CHECKs are independent objects, so the cascade from the
-- parent only fires when the constraint name actually matches.
ALTER TABLE ledger_events DROP CONSTRAINT IF EXISTS ledger_events_event_type_check;
ALTER TABLE ledger_events DROP CONSTRAINT IF EXISTS ledger_events_event_type_check1;
ALTER TABLE ledger_events ADD CONSTRAINT ledger_events_event_type_check
  CHECK (event_type IN ('MINT','TRANSFER','BURN','GENESIS_ALLOCATION'));

ALTER TABLE ledger_recent_events DROP CONSTRAINT IF EXISTS ledger_recent_events_event_type_check;
ALTER TABLE ledger_recent_events ADD CONSTRAINT ledger_recent_events_event_type_check
  CHECK (event_type IN ('MINT','TRANSFER','BURN','GENESIS_ALLOCATION'));

ALTER TABLE account_recent_events DROP CONSTRAINT IF EXISTS account_recent_events_type_check;
ALTER TABLE account_recent_events ADD CONSTRAINT account_recent_events_type_check
  CHECK (type IN ('mint','send','receive','burn','genesis'));

-- Per-asset dimensions. Defaults backfill all existing rows to RPOW4.0.
ALTER TABLE app_counters
  ADD COLUMN IF NOT EXISTS asset_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000000' REFERENCES assets(id);
ALTER TABLE app_counters DROP CONSTRAINT IF EXISTS app_counters_pkey;
ALTER TABLE app_counters ADD PRIMARY KEY (asset_id, name);
INSERT INTO app_counters(asset_id, name, value)
VALUES ('00000000-0000-4000-8000-000000000000', 'burned_supply', 0)
ON CONFLICT (asset_id, name) DO NOTHING;

ALTER TABLE ledger_stats
  ADD COLUMN IF NOT EXISTS asset_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000000' REFERENCES assets(id);
ALTER TABLE ledger_stats DROP CONSTRAINT IF EXISTS ledger_stats_pkey;
ALTER TABLE ledger_stats ADD PRIMARY KEY (asset_id, name);

ALTER TABLE ledger_stat_shards
  ADD COLUMN IF NOT EXISTS asset_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000000' REFERENCES assets(id);
ALTER TABLE ledger_stat_shards DROP CONSTRAINT IF EXISTS ledger_stat_shards_pkey;
ALTER TABLE ledger_stat_shards ADD PRIMARY KEY (asset_id, name, shard);

ALTER TABLE account_balances
  ADD COLUMN IF NOT EXISTS asset_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000000' REFERENCES assets(id);
ALTER TABLE account_balances DROP CONSTRAINT IF EXISTS account_balances_pkey;
ALTER TABLE account_balances ADD PRIMARY KEY (asset_id, pubkey);

ALTER TABLE ledger_event_ids
  ADD COLUMN IF NOT EXISTS asset_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000000' REFERENCES assets(id);
CREATE INDEX IF NOT EXISTS ledger_event_ids_asset_idx ON ledger_event_ids(asset_id, event_seq);

ALTER TABLE ledger_mint_claims
  ADD COLUMN IF NOT EXISTS asset_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000000' REFERENCES assets(id);
ALTER TABLE ledger_mint_claims DROP CONSTRAINT IF EXISTS ledger_mint_claims_pkey;
ALTER TABLE ledger_mint_claims ADD PRIMARY KEY (asset_id, challenge_id);

ALTER TABLE ledger_transfer_idempotency
  ADD COLUMN IF NOT EXISTS asset_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000000' REFERENCES assets(id);
ALTER TABLE ledger_transfer_idempotency DROP CONSTRAINT IF EXISTS ledger_transfer_idempotency_pkey;
ALTER TABLE ledger_transfer_idempotency ADD PRIMARY KEY (asset_id, idempotency_key);

ALTER TABLE ledger_events
  ADD COLUMN IF NOT EXISTS asset_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000000' REFERENCES assets(id),
  ADD COLUMN IF NOT EXISTS fee_base_units BIGINT NOT NULL DEFAULT 0 CHECK (fee_base_units >= 0),
  ADD COLUMN IF NOT EXISTS memo TEXT;
CREATE INDEX IF NOT EXISTS ledger_events_asset_seq_idx ON ledger_events(asset_id, event_seq DESC);
CREATE INDEX IF NOT EXISTS ledger_events_asset_actor_seq_idx ON ledger_events(asset_id, actor_pubkey, event_seq DESC);
CREATE INDEX IF NOT EXISTS ledger_events_asset_counterparty_seq_idx
  ON ledger_events(asset_id, counterparty_pubkey, event_seq DESC)
  WHERE counterparty_pubkey IS NOT NULL;

ALTER TABLE ledger_recent_events
  ADD COLUMN IF NOT EXISTS asset_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000000' REFERENCES assets(id);
CREATE INDEX IF NOT EXISTS ledger_recent_events_asset_seq_idx ON ledger_recent_events(asset_id, event_seq DESC);

ALTER TABLE account_recent_events
  ADD COLUMN IF NOT EXISTS asset_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000000' REFERENCES assets(id);
ALTER TABLE account_recent_events DROP CONSTRAINT IF EXISTS account_recent_events_pkey;
ALTER TABLE account_recent_events ADD PRIMARY KEY (asset_id, pubkey, event_seq, type);
CREATE INDEX IF NOT EXISTS account_recent_events_asset_pubkey_seq_idx
  ON account_recent_events(asset_id, pubkey, event_seq DESC);

ALTER TABLE claim_tokens
  ADD COLUMN IF NOT EXISTS asset_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000000' REFERENCES assets(id);
CREATE INDEX IF NOT EXISTS claim_tokens_asset_sender_idx
  ON claim_tokens(asset_id, sender_pubkey, created_at DESC);

ALTER TABLE faucet_claims
  ADD COLUMN IF NOT EXISTS asset_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000000' REFERENCES assets(id);

ALTER TABLE trollbox_messages
  ADD COLUMN IF NOT EXISTS asset_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000000' REFERENCES assets(id);

ALTER TABLE pool_rounds
  ADD COLUMN IF NOT EXISTS asset_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000000' REFERENCES assets(id);
DROP INDEX IF EXISTS pool_rounds_open_idx;
CREATE INDEX IF NOT EXISTS pool_rounds_open_idx
  ON pool_rounds(asset_id, id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pool_rounds_one_open_per_asset_idx
  ON pool_rounds(asset_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS pool_rounds_asset_ended_at_idx
  ON pool_rounds(asset_id, ended_at DESC) WHERE ended_at IS NOT NULL;

ALTER TABLE pool_shares
  ADD COLUMN IF NOT EXISTS asset_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000000' REFERENCES assets(id);
DROP INDEX IF EXISTS pool_shares_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS pool_shares_uniq
  ON pool_shares(asset_id, challenge_id, nonce_text);
CREATE INDEX IF NOT EXISTS pool_shares_asset_round_pubkey_idx
  ON pool_shares(asset_id, round_id, pubkey);

ALTER TABLE pool_payouts
  ADD COLUMN IF NOT EXISTS asset_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000000' REFERENCES assets(id);
ALTER TABLE pool_payouts DROP CONSTRAINT IF EXISTS pool_payouts_pkey;
ALTER TABLE pool_payouts ADD PRIMARY KEY (asset_id, round_id, pubkey);

-- Keep the first pool round available for the default asset after the new
-- unique open-round constraint has been added.
INSERT INTO pool_rounds (asset_id, started_at)
SELECT '00000000-0000-4000-8000-000000000000', now()
WHERE NOT EXISTS (
  SELECT 1
  FROM pool_rounds
  WHERE asset_id = '00000000-0000-4000-8000-000000000000'
    AND ended_at IS NULL
);

-- Postgres' CREATE OR REPLACE VIEW only allows appending columns to the
-- end of the existing column list, but the multi-asset variant inserts
-- asset_id as the first column. Drop the previous view first so the new
-- shape can be installed cleanly. The view is purely diagnostic, so there
-- are no dependents to worry about.
DROP VIEW IF EXISTS ledger_accounting_reconciliation;
CREATE VIEW ledger_accounting_reconciliation AS
WITH balance_totals AS (
  SELECT
    asset_id,
    COALESCE(sum(spendable_base_units), 0)::bigint AS spendable_base_units,
    COALESCE(sum(minted_base_units), 0)::bigint AS minted_base_units,
    COALESCE(sum(sent_base_units), 0)::bigint AS sent_base_units,
    COALESCE(sum(received_base_units), 0)::bigint AS received_base_units,
    count(*)::bigint AS balance_row_count
  FROM account_balances
  GROUP BY asset_id
),
stats AS (
  SELECT
    a.id AS asset_id,
    COALESCE((SELECT value FROM app_counters WHERE asset_id=a.id AND name='minted_supply'), 0)::bigint AS minted_supply_counter,
    COALESCE((SELECT value FROM ledger_stats WHERE asset_id=a.id AND name='circulating_supply'), 0)::bigint AS circulating_supply,
    COALESCE((SELECT value FROM ledger_stats WHERE asset_id=a.id AND name='user_count'), 0)::bigint AS user_count,
    COALESCE((SELECT sum(value) FROM ledger_stat_shards WHERE asset_id=a.id AND name='total_transferred'), 0)::bigint AS total_transferred
  FROM assets a
)
SELECT
  stats.asset_id,
  stats.minted_supply_counter,
  COALESCE(balance_totals.minted_base_units, 0)::bigint AS minted_base_units,
  stats.circulating_supply,
  COALESCE(balance_totals.spendable_base_units, 0)::bigint AS spendable_base_units,
  stats.total_transferred,
  COALESCE(balance_totals.sent_base_units, 0)::bigint AS sent_base_units,
  COALESCE(balance_totals.received_base_units, 0)::bigint AS received_base_units,
  stats.user_count,
  COALESCE(balance_totals.balance_row_count, 0)::bigint AS balance_row_count,
  (stats.minted_supply_counter = COALESCE(balance_totals.minted_base_units, 0)) AS minted_matches_balances,
  (stats.circulating_supply = COALESCE(balance_totals.spendable_base_units, 0)) AS circulating_matches_balances,
  (stats.total_transferred = COALESCE(balance_totals.sent_base_units, 0)) AS transferred_matches_sent,
  (stats.total_transferred = COALESCE(balance_totals.received_base_units, 0)) AS transferred_matches_received,
  (stats.user_count = COALESCE(balance_totals.balance_row_count, 0)) AS user_count_matches_balances
FROM stats
LEFT JOIN balance_totals ON balance_totals.asset_id = stats.asset_id;
