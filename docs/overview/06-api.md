# 06 · API

All state-changing requests are signed by the user's Ed25519 keypair using `canonicalMessage(action, body)`.

## Account

`GET /me` returns `pubkey`, `display_name`, `balance_base_units`, `minted_base_units`, `sent_base_units`, and `received_base_units` from `account_balances`.

## Mining

`POST /challenge` returns a stateless mining challenge: `challenge_id`, `nonce_prefix`, `difficulty_bits`, `issued_at`, `expires_at`, and `challenge_mac`.

`POST /mint` accepts those challenge fields plus `solution_nonce` and `client_signature_base58`. The client signs `{ challenge_id, solution_nonce }`. On success, the server increments the cap counter, credits `account_balances`, and appends a `MINT` event.

## Transfer

`POST /send` verifies the `transfer` signature, conditionally debits the sender balance, credits the recipient, and appends a `TRANSFER` event. Arbitrary base-unit amounts are supported.

## Ledger

`GET /ledger` returns maintained counters and halving info without scanning history.

`GET /ledger/events?cursor=&limit=` returns paginated append-only public events, newest first.

`GET /activity` returns the newest 100 mint/send/receive events involving the authenticated account.
