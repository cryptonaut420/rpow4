-- 013_scalable_ledger.sql
--
-- Move hot accounting away from per-token scans. Tokens/transfers remain as
-- legacy history for backfill, but live balance/stat reads use compact
-- maintained rows and append-only ledger events.

CREATE TABLE IF NOT EXISTS account_balances (
  pubkey TEXT PRIMARY KEY REFERENCES accounts(pubkey) ON DELETE CASCADE,
  spendable_base_units BIGINT NOT NULL DEFAULT 0 CHECK (spendable_base_units >= 0),
  minted_base_units BIGINT NOT NULL DEFAULT 0 CHECK (minted_base_units >= 0),
  sent_base_units BIGINT NOT NULL DEFAULT 0 CHECK (sent_base_units >= 0),
  received_base_units BIGINT NOT NULL DEFAULT 0 CHECK (received_base_units >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_stats (
  name TEXT PRIMARY KEY,
  value BIGINT NOT NULL CHECK (value >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_stat_shards (
  name TEXT NOT NULL,
  shard SMALLINT NOT NULL CHECK (shard >= 0 AND shard < 64),
  value BIGINT NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (name, shard)
);

CREATE TABLE IF NOT EXISTS ledger_events (
  event_seq BIGSERIAL PRIMARY KEY,
  id UUID NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN ('MINT','TRANSFER')),
  actor_pubkey TEXT NOT NULL,
  counterparty_pubkey TEXT,
  amount BIGINT NOT NULL CHECK (amount > 0),
  challenge_id UUID,
  solution_nonce TEXT,
  idempotency_key TEXT,
  client_signature_base58 TEXT,
  server_sig BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_events_actor_created_idx
  ON ledger_events(actor_pubkey, event_seq DESC);
CREATE INDEX IF NOT EXISTS ledger_events_counterparty_created_idx
  ON ledger_events(counterparty_pubkey, event_seq DESC)
  WHERE counterparty_pubkey IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ledger_events_mint_challenge_unique
  ON ledger_events(challenge_id)
  WHERE event_type='MINT' AND challenge_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ledger_events_transfer_idempotency_unique
  ON ledger_events(idempotency_key)
  WHERE event_type='TRANSFER' AND idempotency_key IS NOT NULL;

-- Ensure all historical owners/counterparties have account rows before
-- creating balance rows. This is idempotent for fresh databases.
INSERT INTO accounts(pubkey)
SELECT pubkey FROM (
  SELECT owner_pubkey AS pubkey FROM tokens
  UNION
  SELECT sender_pubkey AS pubkey FROM transfers
  UNION
  SELECT recipient_pubkey AS pubkey FROM transfers
) s
WHERE pubkey IS NOT NULL
ON CONFLICT (pubkey) DO NOTHING;

INSERT INTO account_balances (
  pubkey,
  spendable_base_units,
  minted_base_units,
  sent_base_units,
  received_base_units,
  updated_at
)
SELECT
  a.pubkey,
  COALESCE(valid_tokens.n, 0),
  COALESCE(minted_tokens.n, 0),
  COALESCE(sent_transfers.n, 0),
  COALESCE(received_transfers.n, 0),
  now()
FROM accounts a
LEFT JOIN (
  SELECT owner_pubkey AS pubkey, sum(value) AS n
  FROM tokens
  WHERE state='VALID'
  GROUP BY owner_pubkey
) valid_tokens ON valid_tokens.pubkey = a.pubkey
LEFT JOIN (
  SELECT owner_pubkey AS pubkey, sum(value) AS n
  FROM tokens
  WHERE parent_token_id IS NULL
  GROUP BY owner_pubkey
) minted_tokens ON minted_tokens.pubkey = a.pubkey
LEFT JOIN (
  SELECT sender_pubkey AS pubkey, sum(amount) AS n
  FROM transfers
  GROUP BY sender_pubkey
) sent_transfers ON sent_transfers.pubkey = a.pubkey
LEFT JOIN (
  SELECT recipient_pubkey AS pubkey, sum(amount) AS n
  FROM transfers
  GROUP BY recipient_pubkey
) received_transfers ON received_transfers.pubkey = a.pubkey
ON CONFLICT (pubkey) DO UPDATE SET
  spendable_base_units = EXCLUDED.spendable_base_units,
  minted_base_units = EXCLUDED.minted_base_units,
  sent_base_units = EXCLUDED.sent_base_units,
  received_base_units = EXCLUDED.received_base_units,
  updated_at = now();

INSERT INTO ledger_stats(name, value)
VALUES
  ('circulating_supply', (SELECT COALESCE(sum(value), 0) FROM tokens WHERE state='VALID')),
  ('user_count', (SELECT count(*) FROM accounts))
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

INSERT INTO ledger_stat_shards(name, shard, value)
SELECT 'total_transferred', gs.shard::smallint,
       CASE WHEN gs.shard = 0 THEN (SELECT COALESCE(sum(amount), 0) FROM transfers) ELSE 0 END
FROM generate_series(0, 63) AS gs(shard)
ON CONFLICT (name, shard) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

INSERT INTO ledger_events(
  id,
  event_type,
  actor_pubkey,
  amount,
  server_sig,
  created_at
)
SELECT
  id,
  'MINT',
  owner_pubkey,
  value,
  server_sig,
  issued_at
FROM tokens
WHERE parent_token_id IS NULL
ON CONFLICT (id) DO NOTHING;

INSERT INTO ledger_events(
  id,
  event_type,
  actor_pubkey,
  counterparty_pubkey,
  amount,
  idempotency_key,
  client_signature_base58,
  created_at
)
SELECT
  id,
  'TRANSFER',
  sender_pubkey,
  recipient_pubkey,
  amount,
  idempotency_key,
  client_signature_base58,
  created_at
FROM transfers
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE VIEW ledger_accounting_reconciliation AS
WITH balance_totals AS (
  SELECT
    COALESCE(sum(spendable_base_units), 0)::bigint AS spendable_base_units,
    COALESCE(sum(minted_base_units), 0)::bigint AS minted_base_units,
    COALESCE(sum(sent_base_units), 0)::bigint AS sent_base_units,
    COALESCE(sum(received_base_units), 0)::bigint AS received_base_units,
    count(*)::bigint AS balance_row_count
  FROM account_balances
),
stats AS (
  SELECT
    COALESCE((SELECT value FROM app_counters WHERE name='minted_supply'), 0)::bigint AS minted_supply_counter,
    COALESCE((SELECT value FROM ledger_stats WHERE name='circulating_supply'), 0)::bigint AS circulating_supply,
    COALESCE((SELECT value FROM ledger_stats WHERE name='user_count'), 0)::bigint AS user_count,
    COALESCE((SELECT sum(value) FROM ledger_stat_shards WHERE name='total_transferred'), 0)::bigint AS total_transferred
)
SELECT
  stats.minted_supply_counter,
  balance_totals.minted_base_units,
  stats.circulating_supply,
  balance_totals.spendable_base_units,
  stats.total_transferred,
  balance_totals.sent_base_units,
  balance_totals.received_base_units,
  stats.user_count,
  balance_totals.balance_row_count,
  (stats.minted_supply_counter = balance_totals.minted_base_units) AS minted_matches_balances,
  (stats.circulating_supply = balance_totals.spendable_base_units) AS circulating_matches_balances,
  (stats.total_transferred = balance_totals.sent_base_units) AS transferred_matches_sent,
  (stats.total_transferred = balance_totals.received_base_units) AS transferred_matches_received,
  (stats.user_count = balance_totals.balance_row_count) AS user_count_matches_balances
FROM stats, balance_totals;

-- Remove bridge-only state from the active schema.
UPDATE tokens
SET state='INVALIDATED', invalidated_at=COALESCE(invalidated_at, now()), wrap_event_id=NULL
WHERE state IN ('LOCKED_FOR_BRIDGE','WRAPPED');

ALTER TABLE tokens DROP CONSTRAINT IF EXISTS tokens_state_check;
ALTER TABLE tokens ADD CONSTRAINT tokens_state_check
  CHECK (state IN ('VALID','INVALIDATED'));

ALTER TABLE tokens DROP COLUMN IF EXISTS wrap_event_id;
DROP TABLE IF EXISTS srpow_wrap_events CASCADE;
