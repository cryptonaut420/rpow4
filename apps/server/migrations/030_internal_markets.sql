-- 030_internal_markets.sql
--
-- Internal spot markets. Every active non-default RPOW trades against the
-- default RPOW4.0 asset. Open limit orders reserve funds in locked balances
-- so the book is fully backed while preserving total supply accounting.

ALTER TABLE account_balances
  ADD COLUMN IF NOT EXISTS locked_base_units BIGINT NOT NULL DEFAULT 0 CHECK (locked_base_units >= 0);

CREATE TABLE IF NOT EXISTS markets (
  id UUID PRIMARY KEY,
  base_asset_id UUID NOT NULL REFERENCES assets(id),
  quote_asset_id UUID NOT NULL REFERENCES assets(id),
  symbol TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  taker_fee_bps INTEGER NOT NULL DEFAULT 0 CHECK (taker_fee_bps BETWEEN 0 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (base_asset_id <> quote_asset_id),
  UNIQUE (base_asset_id, quote_asset_id)
);

CREATE TABLE IF NOT EXISTS market_orders (
  id UUID PRIMARY KEY,
  market_id UUID NOT NULL REFERENCES markets(id),
  owner_pubkey TEXT NOT NULL REFERENCES accounts(pubkey),
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  order_type TEXT NOT NULL CHECK (order_type IN ('limit','market')),
  price_quote_base_units BIGINT CHECK (price_quote_base_units IS NULL OR price_quote_base_units > 0),
  original_base_units BIGINT NOT NULL CHECK (original_base_units > 0),
  remaining_base_units BIGINT NOT NULL CHECK (remaining_base_units >= 0),
  reserved_asset_id UUID REFERENCES assets(id),
  reserved_remaining_base_units BIGINT NOT NULL DEFAULT 0 CHECK (reserved_remaining_base_units >= 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partially_filled','filled','cancelled','expired','rejected')),
  client_order_id UUID NOT NULL,
  client_signature_base58 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  CHECK (
    (order_type = 'limit' AND price_quote_base_units IS NOT NULL)
    OR (order_type = 'market' AND price_quote_base_units IS NULL)
  ),
  UNIQUE (owner_pubkey, client_order_id)
);

CREATE INDEX IF NOT EXISTS market_orders_book_bids_idx
  ON market_orders(market_id, price_quote_base_units DESC, created_at ASC, id ASC)
  WHERE side='buy' AND status IN ('open','partially_filled') AND remaining_base_units > 0;

CREATE INDEX IF NOT EXISTS market_orders_book_asks_idx
  ON market_orders(market_id, price_quote_base_units ASC, created_at ASC, id ASC)
  WHERE side='sell' AND status IN ('open','partially_filled') AND remaining_base_units > 0;

CREATE INDEX IF NOT EXISTS market_orders_owner_idx
  ON market_orders(owner_pubkey, created_at DESC);

CREATE TABLE IF NOT EXISTS market_trades (
  id UUID PRIMARY KEY,
  market_id UUID NOT NULL REFERENCES markets(id),
  maker_order_id UUID NOT NULL REFERENCES market_orders(id),
  taker_order_id UUID NOT NULL REFERENCES market_orders(id),
  maker_pubkey TEXT NOT NULL REFERENCES accounts(pubkey),
  taker_pubkey TEXT NOT NULL REFERENCES accounts(pubkey),
  taker_side TEXT NOT NULL CHECK (taker_side IN ('buy','sell')),
  price_quote_base_units BIGINT NOT NULL CHECK (price_quote_base_units > 0),
  base_amount_base_units BIGINT NOT NULL CHECK (base_amount_base_units > 0),
  quote_amount_base_units BIGINT NOT NULL CHECK (quote_amount_base_units > 0),
  fee_base_units BIGINT NOT NULL DEFAULT 0 CHECK (fee_base_units >= 0),
  fee_asset_id UUID NOT NULL REFERENCES assets(id),
  base_event_id UUID,
  quote_event_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS market_trades_market_created_idx
  ON market_trades(market_id, created_at DESC, id DESC);

INSERT INTO markets(id, base_asset_id, quote_asset_id, symbol, status, taker_fee_bps)
SELECT
  gen_random_uuid(),
  a.id,
  d.id,
  a.display_code || '/' || d.display_code,
  'active',
  0
FROM assets a
CROSS JOIN assets d
WHERE d.system_default = true
  AND a.system_default = false
  AND a.status = 'active'
ON CONFLICT (base_asset_id, quote_asset_id) DO NOTHING;

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
  (stats.minted_supply_counter = COALESCE(balance_totals.minted_base_units, 0)) AS minted_matches_balances,
  (stats.circulating_supply = COALESCE(balance_totals.total_balance_base_units, 0)) AS circulating_matches_balances,
  (stats.total_transferred = COALESCE(balance_totals.sent_base_units, 0)) AS transferred_matches_sent,
  (stats.total_transferred = COALESCE(balance_totals.received_base_units, 0)) AS transferred_matches_received,
  (stats.user_count = COALESCE(balance_totals.balance_row_count, 0)) AS user_count_matches_balances
FROM stats
LEFT JOIN balance_totals ON balance_totals.asset_id = stats.asset_id;
