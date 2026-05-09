-- 022_trollbox.sql
--
-- Trollbox: a public, append-only message board where each post burns a
-- fixed fee to the treasury. Posts are ordered newest-first by `seq`,
-- which is BIGSERIAL so reads use the primary-key index in reverse order
-- without a separate sort step.
--
-- Each trollbox row also references the underlying TRANSFER ledger event
-- (fee_event_id) so the explorer can link from a post to the on-ledger
-- fee that paid for it. The fee transfer itself is a normal TRANSFER
-- event with memo='trollbox post' so it shows up in the author's
-- /activity feed exactly like any other send.

CREATE TABLE IF NOT EXISTS trollbox_messages (
  -- Strictly increasing global ordering. Used as the pagination cursor:
  -- `WHERE seq < $cursor ORDER BY seq DESC` is a tiny PK range scan.
  seq BIGSERIAL PRIMARY KEY,
  -- Public identifier exposed in API responses; UUID so it doesn't leak
  -- the seq counter to clients.
  id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  author_pubkey TEXT NOT NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 280),
  fee_base_units BIGINT NOT NULL CHECK (fee_base_units >= 0),
  -- The TRANSFER ledger event id that paid for this post. Links the
  -- trollbox row back into the canonical ledger.
  fee_event_id UUID NOT NULL,
  -- Idempotency token from the client so a network retry of the same
  -- POST returns the same row instead of duplicating the post and the
  -- fee. Bound to the (author, body) pair via the unique index below.
  idempotency_key TEXT NOT NULL,
  -- Detached Ed25519 signature over canonicalMessage('trollbox.post',
  -- { body, idempotency_key }). Persisted so the public feed exposes
  -- verifiable per-post sigs, mirroring how /send works.
  client_signature_base58 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency is scoped to (author, key): two different authors should
-- be able to use the same client-generated UUID without colliding, and
-- one author retrying their own POST must hit the same row.
CREATE UNIQUE INDEX IF NOT EXISTS trollbox_messages_author_idem_idx
  ON trollbox_messages(author_pubkey, idempotency_key);

-- O(1) lifetime message count for the stats page. Backfilled below from
-- whatever rows already exist (zero on a fresh DB), then incremented
-- transactionally inside the post route's CTE.
INSERT INTO app_counters(name, value)
SELECT 'trollbox_message_count', (SELECT count(*) FROM trollbox_messages)
ON CONFLICT (name) DO NOTHING;
