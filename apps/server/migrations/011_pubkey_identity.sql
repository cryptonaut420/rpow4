-- 011_pubkey_identity.sql
--
-- Replace email-based identity with Ed25519 pubkey identity.
--
-- This is a destructive migration. The email-keyed columns can't be
-- recovered into pubkeys without a per-user attach step, and the project
-- chose a clean break. Existing tokens, transfers, challenges, wrap
-- events, and the supply counter are all wiped. Run on a fresh DB
-- (./up.sh --wipe).

-- 1. Drop tables specific to the email/magic-link/Phantom-binding world.
DROP TABLE IF EXISTS magic_links CASCADE;
DROP TABLE IF EXISTS pending_transfers CASCADE;
DROP TABLE IF EXISTS email_unsubscribes CASCADE;
DROP TABLE IF EXISTS phantom_challenges CASCADE;

-- 2. Wipe data from tables we're restructuring (every row references the
-- old identity model). CASCADE handles tokens.wrap_event_id ->
-- srpow_wrap_events.id.
TRUNCATE tokens, transfers, challenges, srpow_wrap_events, users CASCADE;
UPDATE app_counters SET value = 0 WHERE name = 'minted_supply';

-- 3. users -> accounts, with a base58 pubkey primary key.
ALTER TABLE users RENAME TO accounts;
ALTER TABLE accounts DROP CONSTRAINT users_pkey;
ALTER TABLE accounts DROP COLUMN email;
ALTER TABLE accounts DROP COLUMN solana_wallet;
ALTER TABLE accounts ADD COLUMN pubkey TEXT NOT NULL;
ALTER TABLE accounts ADD CONSTRAINT accounts_pkey PRIMARY KEY (pubkey);

-- 4. tokens: swap owner column.
DROP INDEX IF EXISTS tokens_owner_state_idx;
ALTER TABLE tokens DROP COLUMN owner_email;
ALTER TABLE tokens ADD COLUMN owner_pubkey TEXT NOT NULL;
CREATE INDEX tokens_owner_state_idx ON tokens(owner_pubkey, state);

-- 5. transfers: swap email columns + persist the sender's per-event
-- signature. Storing the canonical-signed signature alongside the row
-- makes /activity and /ledger expose verifiable transfer authorizations:
-- anyone can recompute canonicalMessage('transfer', body) and verify it
-- against sender_pubkey using only public information.
ALTER TABLE transfers DROP COLUMN sender_email;
ALTER TABLE transfers DROP COLUMN recipient_email;
ALTER TABLE transfers ADD COLUMN sender_pubkey TEXT NOT NULL;
ALTER TABLE transfers ADD COLUMN recipient_pubkey TEXT NOT NULL;
ALTER TABLE transfers ADD COLUMN client_signature_base58 TEXT NOT NULL;
CREATE INDEX transfers_sender_pubkey_idx ON transfers(sender_pubkey);
CREATE INDEX transfers_recipient_pubkey_idx ON transfers(recipient_pubkey);

-- 6. challenges: swap user column. The signature is filled in at /mint
-- time, so it's nullable until the challenge is claimed.
DROP INDEX IF EXISTS challenges_user_idx;
ALTER TABLE challenges DROP COLUMN user_email;
ALTER TABLE challenges ADD COLUMN user_pubkey TEXT NOT NULL;
ALTER TABLE challenges ADD COLUMN client_signature_base58 TEXT;
CREATE INDEX challenges_user_idx ON challenges(user_pubkey);

-- 7. srpow_wrap_events: drop the now-redundant solana_wallet column (the
-- account pubkey IS the Solana wallet, derived on the same SLIP-0010
-- m/44'/501'/0'/0' path Phantom uses), and persist the wrap auth sig.
DROP INDEX IF EXISTS srpow_wrap_events_user_idx;
ALTER TABLE srpow_wrap_events DROP COLUMN user_email;
ALTER TABLE srpow_wrap_events DROP COLUMN solana_wallet;
ALTER TABLE srpow_wrap_events ADD COLUMN user_pubkey TEXT NOT NULL;
ALTER TABLE srpow_wrap_events ADD COLUMN client_signature_base58 TEXT NOT NULL;
CREATE INDEX srpow_wrap_events_user_idx ON srpow_wrap_events(user_pubkey);
