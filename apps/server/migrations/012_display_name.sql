-- 012_display_name.sql
--
-- Optional, unique-per-account human-friendly handle. Purely a display
-- and lookup convenience: it does NOT replace the pubkey, it does not
-- authenticate anything, and it does not bind the account to anything
-- off-system. Senders can resolve a handle to a pubkey via /lookup/:name.
--
-- Uniqueness is case-insensitive (`alice` and `Alice` collide) but the
-- original casing is preserved on storage for nicer display. Validation
-- (length 3..32, charset [a-z0-9._\-@]) is enforced at the route layer.

ALTER TABLE accounts
  ADD COLUMN display_name TEXT NULL,
  ADD COLUMN display_name_set_at TIMESTAMPTZ,
  ADD COLUMN display_name_signature_base58 TEXT;

CREATE UNIQUE INDEX accounts_display_name_lower_unique
  ON accounts (lower(display_name))
  WHERE display_name IS NOT NULL;
