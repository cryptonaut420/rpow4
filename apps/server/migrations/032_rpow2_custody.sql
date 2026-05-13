-- 032_rpow2_custody.sql
--
-- RPOW2 is an externally-backed custodial asset. Users deposit by sending
-- RPOW2 to a banker account on rpow2.com with their RPOW4 pubkey/handle in
-- the memo; this app credits an internal RPOW2 balance that can trade against
-- RPOW4.0. Withdrawals are queued and require admin approval before the banker
-- sends RPOW2 back out.

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS asset_kind TEXT NOT NULL DEFAULT 'mineable'
  CHECK (asset_kind IN ('mineable', 'external_custodial'));

COMMENT ON COLUMN assets.asset_kind IS
  'mineable assets are PoW-issued internally; external_custodial assets are backed by an external banker account.';

INSERT INTO assets (
  id, family_code, sequence_number, display_code, slug, nickname, description,
  status, system_default, supply_mode, max_supply_base_units,
  initial_reward_base_units, reward_schedule_type, reward_interval_blocks,
  reward_reduction_type, reward_reduction_value, difficulty_schedule_type,
  difficulty_start_bits, difficulty_step_blocks, difficulty_max_bits,
  mining_algo, pool_enabled, pool_fee_bps, pool_finder_bps, pool_share_bits,
  transfer_fee_base_units, asset_kind
)
VALUES (
  '00000000-0000-4000-8000-000000000002',
  'RPOW',
  2000002,
  'RPOW2',
  'rpow2',
  'RPOW2',
  'Externally-backed RPOW2 balance credited from the RPOW2 banker account.',
  'active',
  false,
  'unlimited',
  NULL,
  1,
  'none',
  1,
  'none',
  0,
  'linear_by_blocks',
  24,
  1,
  24,
  'rpow_classic',
  false,
  0,
  0,
  24,
  0,
  'external_custodial'
)
ON CONFLICT (id) DO NOTHING;

UPDATE assets
   SET asset_kind = 'external_custodial',
       pool_enabled = false,
       transfer_fee_base_units = 0,
       description = 'Externally-backed RPOW2 balance credited from the RPOW2 banker account.'
 WHERE id = '00000000-0000-4000-8000-000000000002';

INSERT INTO app_counters(asset_id, name, value)
VALUES
  ('00000000-0000-4000-8000-000000000002', 'minted_supply', 0),
  ('00000000-0000-4000-8000-000000000002', 'burned_supply', 0),
  ('00000000-0000-4000-8000-000000000002', 'block_height', 0),
  ('00000000-0000-4000-8000-000000000002', 'transfer_count', 0),
  ('00000000-0000-4000-8000-000000000002', 'total_fees_collected', 0)
ON CONFLICT (asset_id, name) DO NOTHING;

INSERT INTO ledger_stats(asset_id, name, value)
VALUES
  ('00000000-0000-4000-8000-000000000002', 'circulating_supply', 0),
  ('00000000-0000-4000-8000-000000000002', 'user_count', 0)
ON CONFLICT (asset_id, name) DO NOTHING;

INSERT INTO ledger_stat_shards(asset_id, name, shard, value)
SELECT '00000000-0000-4000-8000-000000000002', 'total_transferred', gs::smallint, 0
FROM generate_series(0, 63) AS gs
ON CONFLICT (asset_id, name, shard) DO NOTHING;

CREATE TABLE IF NOT EXISTS external_asset_configs (
  asset_id UUID PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  provider_key TEXT NOT NULL UNIQUE,
  api_base_url TEXT NOT NULL,
  banker_email TEXT NOT NULL,
  deposit_enabled BOOLEAN NOT NULL DEFAULT true,
  withdrawal_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO external_asset_configs(asset_id, provider_key, api_base_url, banker_email)
VALUES (
  '00000000-0000-4000-8000-000000000002',
  'rpow2',
  'https://api.rpow2.com',
  'rpow4bank@gmail.com'
)
ON CONFLICT (asset_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS external_sync_state (
  provider_key TEXT PRIMARY KEY REFERENCES external_asset_configs(provider_key) ON DELETE CASCADE,
  cursor_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_run_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  paused BOOLEAN NOT NULL DEFAULT false
);

INSERT INTO external_sync_state(provider_key)
VALUES ('rpow2')
ON CONFLICT (provider_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS external_deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES assets(id),
  provider_key TEXT NOT NULL REFERENCES external_asset_configs(provider_key),
  fingerprint TEXT NOT NULL UNIQUE,
  account_pubkey TEXT REFERENCES accounts(pubkey),
  sender_external_id TEXT NOT NULL,
  raw_memo TEXT,
  resolved_memo_kind TEXT CHECK (resolved_memo_kind IN ('pubkey','handle')),
  amount_base_units BIGINT NOT NULL CHECK (amount_base_units > 0),
  external_observed_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('credited','unattributed','ignored')),
  credited_event_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  credited_at TIMESTAMPTZ,
  note TEXT
);
CREATE INDEX IF NOT EXISTS external_deposits_account_idx
  ON external_deposits(asset_id, account_pubkey, external_observed_at DESC)
  WHERE account_pubkey IS NOT NULL;
CREATE INDEX IF NOT EXISTS external_deposits_status_idx
  ON external_deposits(provider_key, status, external_observed_at DESC);

CREATE TABLE IF NOT EXISTS external_withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES assets(id),
  provider_key TEXT NOT NULL REFERENCES external_asset_configs(provider_key),
  requester_pubkey TEXT NOT NULL REFERENCES accounts(pubkey),
  destination_external_id TEXT NOT NULL,
  amount_base_units BIGINT NOT NULL CHECK (amount_base_units > 0),
  status TEXT NOT NULL CHECK (status IN ('pending_approval','sending','sent','rejected','failed')),
  admin_pubkey TEXT REFERENCES accounts(pubkey),
  idempotency_key TEXT NOT NULL UNIQUE,
  external_transfer_id TEXT,
  burn_event_id UUID,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS external_withdrawals_requester_idx
  ON external_withdrawals(asset_id, requester_pubkey, created_at DESC);
CREATE INDEX IF NOT EXISTS external_withdrawals_status_idx
  ON external_withdrawals(provider_key, status, created_at ASC);

INSERT INTO markets(id, base_asset_id, quote_asset_id, symbol, status, taker_fee_bps)
VALUES (
  gen_random_uuid(),
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000000',
  'RPOW2/RPOW4.0',
  'active',
  25
)
ON CONFLICT (base_asset_id, quote_asset_id) DO UPDATE SET
  symbol = EXCLUDED.symbol,
  taker_fee_bps = 25,
  status = 'active',
  updated_at = now();

DROP VIEW IF EXISTS ledger_accounting_reconciliation;
CREATE VIEW ledger_accounting_reconciliation AS
WITH balance_totals AS (
  SELECT
    asset_id,
    COALESCE(sum(spendable_base_units), 0)::bigint AS spendable_base_units,
    COALESCE(sum(locked_base_units), 0)::bigint AS locked_base_units,
    COALESCE(sum(spendable_base_units + locked_base_units), 0)::bigint AS total_balance_base_units,
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
    a.asset_kind,
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
  COALESCE(balance_totals.locked_base_units, 0)::bigint AS locked_base_units,
  COALESCE(balance_totals.total_balance_base_units, 0)::bigint AS total_balance_base_units,
  stats.total_transferred,
  COALESCE(balance_totals.sent_base_units, 0)::bigint AS sent_base_units,
  COALESCE(balance_totals.received_base_units, 0)::bigint AS received_base_units,
  stats.user_count,
  COALESCE(balance_totals.balance_row_count, 0)::bigint AS balance_row_count,
  (stats.asset_kind = 'external_custodial' OR stats.minted_supply_counter = COALESCE(balance_totals.minted_base_units, 0)) AS minted_matches_balances,
  (stats.circulating_supply = COALESCE(balance_totals.total_balance_base_units, 0)) AS circulating_matches_balances,
  (stats.total_transferred = COALESCE(balance_totals.sent_base_units, 0)) AS transferred_matches_sent,
  (stats.total_transferred = COALESCE(balance_totals.received_base_units, 0)) AS transferred_matches_received,
  (stats.user_count = COALESCE(balance_totals.balance_row_count, 0)) AS user_count_matches_balances
FROM stats
LEFT JOIN balance_totals ON balance_totals.asset_id = stats.asset_id;
