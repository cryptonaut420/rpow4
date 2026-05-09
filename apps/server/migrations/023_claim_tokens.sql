-- 023_claim_tokens.sql
--
-- Bearer claim tokens — "offline transfers" inspired by Hal Finney's original RPOW.
--
-- The sender creates a one-time claim code (shareable as a URL / QR code).
-- Any authenticated account that presents the code can redeem it to flip the
-- funds to their own balance. The sender can also cancel an unclaimed token to
-- recover the locked funds.
--
-- State machine:
--   pending → redeemed  (by any authenticated user)
--   pending → cancelled (by the sender)
--
-- The claim ID is a client-generated UUID, allowing the sender to sign it
-- before the server ever sees it (same pattern as mining challenge_id).
--
-- No send fee is charged — claims are a bearer-instrument UX, not a spam
-- vector. The amount is debited from the sender's balance at creation time
-- so the claim is always fundable.

CREATE TABLE IF NOT EXISTS claim_tokens (
  id UUID PRIMARY KEY,                           -- client-generated; part of the signed body
  sender_pubkey TEXT NOT NULL,
  amount_base_units BIGINT NOT NULL CHECK (amount_base_units > 0),
  memo TEXT CHECK (char_length(memo) <= 64),
  -- Ed25519 signature over canonicalMessage('claim.create', { claim_id, amount_base_units, memo? })
  client_signature_base58 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'redeemed', 'cancelled')),
  -- Populated on redemption.
  redeemer_pubkey TEXT,
  -- The TRANSFER ledger event created when the claim is redeemed, so the
  -- event shows up in both parties' /activity feeds like any other send.
  transfer_event_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  redeemed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);

-- Sender's pending/historical claims; used by GET /claim?my=pending.
CREATE INDEX IF NOT EXISTS claim_tokens_sender_idx
  ON claim_tokens(sender_pubkey, created_at DESC);

-- Fast O(log n) scan for pending tokens (e.g. cancel eligibility checks).
CREATE INDEX IF NOT EXISTS claim_tokens_pending_idx
  ON claim_tokens(state) WHERE state = 'pending';
