-- 025_pool_mining.sql
--
-- Pooled mining: a single global pool that splits each block reward
-- across active participants by share contribution.
--
-- Distribution rules at round close (see routes/pool.ts):
--   * 2% of gross reward → treasury (POOL_FEE_BPS)
--   * Of the remaining 98% (net):
--       - 25% (POOL_FINDER_BPS) → the miner whose share cleared network
--         difficulty (the "finder")
--       - 75% → split pro-rata across all NON-finder shares in the round
--
-- The finder explicitly does NOT participate in the 75% pro-rata pool —
-- they get the flat 25% only. Solo mining is unaffected by these tables;
-- a solo miner who finds a block still gets 100% of the reward via the
-- existing /mint path.

CREATE TABLE IF NOT EXISTS pool_rounds (
  id BIGSERIAL PRIMARY KEY,
  -- A round opens immediately after the previous round's closeout TX
  -- commits. ended_at IS NULL identifies the single open round.
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  -- The pubkey of the lucky miner whose share cleared network difficulty,
  -- and the MINT ledger event id created at closeout for explorer linkage.
  ended_by_pubkey TEXT,
  ended_by_event_id UUID,
  -- Cached aggregates so the explorer / stats page doesn't have to scan
  -- pool_shares / pool_payouts to render a closed round.
  total_shares BIGINT NOT NULL DEFAULT 0,
  participant_count INTEGER,
  reward_base_units BIGINT,
  treasury_cut_base_units BIGINT,
  finder_payout_base_units BIGINT,
  pro_rata_pool_base_units BIGINT
);

-- "Find the open round" is the hottest read on this table; an index
-- restricted to open rows keeps that lookup O(1).
CREATE INDEX IF NOT EXISTS pool_rounds_open_idx
  ON pool_rounds(id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS pool_rounds_ended_at_idx
  ON pool_rounds(ended_at DESC) WHERE ended_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS pool_shares (
  id BIGSERIAL PRIMARY KEY,
  round_id BIGINT NOT NULL REFERENCES pool_rounds(id),
  pubkey TEXT NOT NULL,
  challenge_id UUID NOT NULL,
  -- Nonces fit in u64 but are stringified through the wire (BigInts in
  -- JSON aren't standard); store as text to round-trip cleanly.
  nonce_text TEXT NOT NULL,
  zeros SMALLINT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Replay protection: the same (challenge_id, nonce) pair can be accepted
-- exactly once. Stops a worker from pumping the same share repeatedly.
CREATE UNIQUE INDEX IF NOT EXISTS pool_shares_uniq
  ON pool_shares(challenge_id, nonce_text);
CREATE INDEX IF NOT EXISTS pool_shares_round_pubkey_idx
  ON pool_shares(round_id, pubkey);
CREATE INDEX IF NOT EXISTS pool_shares_pubkey_recent_idx
  ON pool_shares(pubkey, submitted_at DESC);
CREATE INDEX IF NOT EXISTS pool_shares_recent_idx
  ON pool_shares(submitted_at DESC);

CREATE TABLE IF NOT EXISTS pool_payouts (
  round_id BIGINT NOT NULL REFERENCES pool_rounds(id),
  pubkey TEXT NOT NULL,
  share_count BIGINT NOT NULL,
  payout_base_units BIGINT NOT NULL CHECK (payout_base_units >= 0),
  is_finder BOOLEAN NOT NULL DEFAULT FALSE,
  -- The TRANSFER ledger event id created for this payout, so the activity
  -- feed and explorer can link the payout row to its on-ledger event.
  transfer_event_id UUID,
  PRIMARY KEY (round_id, pubkey)
);
CREATE INDEX IF NOT EXISTS pool_payouts_pubkey_idx
  ON pool_payouts(pubkey);

-- Seed an initial open round so the first share submission has somewhere
-- to land. Idempotent: only insert if no open round exists yet.
INSERT INTO pool_rounds (started_at)
SELECT now()
WHERE NOT EXISTS (SELECT 1 FROM pool_rounds WHERE ended_at IS NULL);
