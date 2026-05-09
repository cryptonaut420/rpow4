# 02 · Protocol

## Identity

Accounts are keyed by a base58 Ed25519 public key. The server never receives the user's mnemonic or private key. Authentication uses a stateless HMAC challenge envelope, a client signature over `auth.session`, and an HTTP-only session cookie.

## Signed Actions

| Endpoint | Action | Signed Body |
|---|---|---|
| `POST /auth/session` | `auth.session` | auth envelope |
| `POST /signup` | `account.signup` | `{ handle, pubkey, nonce }` |
| `POST /me/display_name` | `account.set_display_name` | `{ display_name }` |
| `POST /mint` | `mint` | `{ challenge_id, solution_nonce }` |
| `POST /send` | `transfer` | `{ recipient_pubkey, amount_base_units, idempotency_key }` |

## Mining

`POST /challenge` returns a stateless HMAC-protected challenge and does not write to Postgres. The client mines against `SHA256(nonce_prefix || u64le(solution_nonce))`, then submits `/mint` with the challenge fields, solution, challenge MAC, and `mint` signature.

`/mint` verifies the MAC, proof, signature, cap counter, and unique `challenge_id`, then credits `account_balances` and appends a `MINT` `ledger_events` row. Only accepted proofs write to the ledger.

## Transfers

`POST /send` performs a conditional balance debit and recipient credit in one transaction, then appends a `TRANSFER` `ledger_events` row. The transfer idempotency key is unique in `ledger_events`, so retries return the original result.

## Reads

`/me` reads `account_balances`. `/ledger` reads `app_counters` and `ledger_stats`. `/activity` and `/ledger/events` read bounded pages from `ledger_events`.
