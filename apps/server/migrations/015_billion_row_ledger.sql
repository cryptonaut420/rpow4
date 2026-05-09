-- 015_billion_row_ledger.sql
--
-- Make ledger history comfortable at billion-row scale.
--
-- The durable event log becomes RANGE-partitioned by event_seq. The common
-- read paths get tiny bounded "hot" tables:
--
--   ledger_recent_events  - last N global events for /ledger/events
--   account_recent_events - last N per-account activity rows for /activity
--
-- Partitioning keeps historical indexes/table files bounded. The hot tables
-- keep API latency independent of total historical row count.

CREATE TABLE IF NOT EXISTS ledger_event_ids (
  id UUID PRIMARY KEY,
  event_seq BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_mint_claims (
  challenge_id UUID PRIMARY KEY,
  event_id UUID NOT NULL,
  event_seq BIGINT,
  actor_pubkey TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_transfer_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  event_id UUID NOT NULL,
  event_seq BIGINT,
  sender_pubkey TEXT NOT NULL,
  recipient_pubkey TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Populate the sidecar uniqueness tables before converting ledger_events.
INSERT INTO ledger_event_ids(id, event_seq)
SELECT id, event_seq FROM ledger_events
ON CONFLICT (id) DO NOTHING;

INSERT INTO ledger_mint_claims(challenge_id, event_id, event_seq, actor_pubkey, claimed_at)
SELECT challenge_id, id, event_seq, actor_pubkey, created_at
FROM ledger_events
WHERE event_type='MINT' AND challenge_id IS NOT NULL
ON CONFLICT (challenge_id) DO NOTHING;

INSERT INTO ledger_transfer_idempotency(
  idempotency_key, event_id, event_seq, sender_pubkey, recipient_pubkey, amount, created_at
)
SELECT idempotency_key, id, event_seq, actor_pubkey, counterparty_pubkey, amount, created_at
FROM ledger_events
WHERE event_type='TRANSFER'
  AND idempotency_key IS NOT NULL
  AND counterparty_pubkey IS NOT NULL
ON CONFLICT (idempotency_key) DO NOTHING;

-- Convert the existing heap table into a partitioned table when needed.
-- This branch should normally run on a still-small in-progress database. For
-- a live database with massive historical rows, do the same shape with a
-- shadow table/backfill job instead of one monolithic migration.
DO $$
DECLARE
  is_partitioned boolean;
BEGIN
  SELECT c.relkind = 'p'
  INTO is_partitioned
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relname = 'ledger_events';

  IF NOT is_partitioned THEN
    ALTER TABLE ledger_events RENAME TO ledger_events_unpartitioned_015;

    CREATE TABLE ledger_events (
      event_seq BIGINT NOT NULL DEFAULT nextval('ledger_events_event_seq_seq'::regclass),
      id UUID NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('MINT','TRANSFER')),
      actor_pubkey TEXT NOT NULL,
      counterparty_pubkey TEXT,
      amount BIGINT NOT NULL CHECK (amount > 0),
      challenge_id UUID,
      solution_nonce TEXT,
      idempotency_key TEXT,
      client_signature_base58 TEXT,
      server_sig BYTEA,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (event_seq)
    ) PARTITION BY RANGE (event_seq);
  END IF;
END $$;

-- 128 partitions * 100M rows = 12.8B event_seq slots before the default
-- catch-all partition is touched. Operationally, add more partitions well
-- before then; the default exists to keep inserts alive if that job is missed.
DO $$
DECLARE
  partition_count int := 128;
  partition_size bigint := 100000000;
  i int;
  from_seq bigint;
  to_seq bigint;
  partition_name text;
BEGIN
  FOR i IN 0..(partition_count - 1) LOOP
    from_seq := 1 + (i::bigint * partition_size);
    to_seq := 1 + ((i::bigint + 1) * partition_size);
    partition_name := 'ledger_events_p' || lpad(i::text, 3, '0');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF ledger_events FOR VALUES FROM (%s) TO (%s)',
      partition_name,
      from_seq,
      to_seq
    );
  END LOOP;

  CREATE TABLE IF NOT EXISTS ledger_events_p_default
    PARTITION OF ledger_events DEFAULT;
END $$;

-- Parent indexes create matching local indexes on each partition. Keep the
-- index footprint intentionally small: latest feed uses event_seq, per-user
-- history uses actor/counterparty + event_seq. Global uniqueness is handled
-- by the sidecar tables above because Postgres cannot enforce a partitioned
-- unique index unless it includes event_seq.
CREATE INDEX IF NOT EXISTS ledger_events_actor_seq_idx
  ON ledger_events(actor_pubkey, event_seq DESC);
CREATE INDEX IF NOT EXISTS ledger_events_counterparty_seq_idx
  ON ledger_events(counterparty_pubkey, event_seq DESC)
  WHERE counterparty_pubkey IS NOT NULL;

INSERT INTO ledger_events(
  event_seq, id, event_type, actor_pubkey, counterparty_pubkey, amount,
  challenge_id, solution_nonce, idempotency_key, client_signature_base58,
  server_sig, created_at
)
SELECT
  event_seq, id, event_type, actor_pubkey, counterparty_pubkey, amount,
  challenge_id, solution_nonce, idempotency_key, client_signature_base58,
  server_sig, created_at
FROM ledger_events_unpartitioned_015
ON CONFLICT (event_seq) DO NOTHING;

SELECT setval(
  'ledger_events_event_seq_seq',
  GREATEST(
    COALESCE((SELECT max(event_seq) FROM ledger_events), 0),
    COALESCE((SELECT last_value FROM ledger_events_event_seq_seq), 1)
  ),
  true
);

ALTER SEQUENCE ledger_events_event_seq_seq OWNED BY ledger_events.event_seq;

DROP TABLE IF EXISTS ledger_events_unpartitioned_015;

CREATE TABLE IF NOT EXISTS ledger_recent_events (
  event_seq BIGINT PRIMARY KEY,
  id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('MINT','TRANSFER')),
  actor_pubkey TEXT NOT NULL,
  counterparty_pubkey TEXT,
  amount BIGINT NOT NULL CHECK (amount > 0),
  challenge_id UUID,
  solution_nonce TEXT,
  idempotency_key TEXT,
  client_signature_base58 TEXT,
  server_sig BYTEA,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS account_recent_events (
  pubkey TEXT NOT NULL,
  event_seq BIGINT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('mint','send','receive')),
  amount BIGINT NOT NULL CHECK (amount > 0),
  counterparty_pubkey TEXT,
  client_signature_base58 TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (pubkey, event_seq, type)
);

-- Seed the global hot feed from the durable log. This is intentionally
-- bounded; it never scans or copies the entire ledger.
INSERT INTO ledger_recent_events(
  event_seq, id, event_type, actor_pubkey, counterparty_pubkey, amount,
  challenge_id, solution_nonce, idempotency_key, client_signature_base58,
  server_sig, created_at
)
SELECT
  event_seq, id, event_type, actor_pubkey, counterparty_pubkey, amount,
  challenge_id, solution_nonce, idempotency_key, client_signature_base58,
  server_sig, created_at
FROM ledger_events
ORDER BY event_seq DESC
LIMIT 100000
ON CONFLICT (event_seq) DO NOTHING;

-- Seed per-account hot activity only from the bounded global hot feed. Older
-- account history remains available through the partitioned ledger fallback.
WITH expanded AS (
  SELECT actor_pubkey AS pubkey, event_seq, 'mint'::text AS type, amount,
         NULL::text AS counterparty_pubkey, client_signature_base58, created_at
  FROM ledger_recent_events
  WHERE event_type='MINT'
  UNION ALL
  SELECT actor_pubkey AS pubkey, event_seq, 'send'::text AS type, amount,
         counterparty_pubkey, client_signature_base58, created_at
  FROM ledger_recent_events
  WHERE event_type='TRANSFER'
  UNION ALL
  SELECT counterparty_pubkey AS pubkey, event_seq, 'receive'::text AS type, amount,
         actor_pubkey AS counterparty_pubkey, client_signature_base58, created_at
  FROM ledger_recent_events
  WHERE event_type='TRANSFER' AND counterparty_pubkey IS NOT NULL
),
ranked AS (
  SELECT *, row_number() OVER (PARTITION BY pubkey ORDER BY event_seq DESC) AS rn
  FROM expanded
)
INSERT INTO account_recent_events(
  pubkey, event_seq, type, amount, counterparty_pubkey, client_signature_base58, created_at
)
SELECT pubkey, event_seq, type, amount, counterparty_pubkey, client_signature_base58, created_at
FROM ranked
WHERE rn <= 200
ON CONFLICT (pubkey, event_seq, type) DO NOTHING;

ALTER TABLE ledger_recent_events SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

ALTER TABLE account_recent_events SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);
