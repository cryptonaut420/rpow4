# 06 · API Reference

Quick reference for every endpoint exposed by `apps/server`. Wire shapes
are declared in
[`packages/shared/src/protocol.ts`](../../packages/shared/src/protocol.ts).
All bodies are JSON; auth uses the `rpow_session` cookie unless noted.

> Convention: **base units** = BIGINT, where 10⁹ base units = 1 RPOW.
> Numeric amounts on the wire are *strings* (to safely carry bigints in
> JSON). Field names ending in `_base_units` always use this convention.

## Auth & session

### `POST /auth/request`

```json
{ "email": "user@example.com" }
```

→ 200 `{ "ok": true, "cooldown_seconds": 30 }`
→ 400 `BAD_REQUEST` (invalid email)
→ 429 `RATE_LIMITED` `{ "retry_after": <seconds> }`

Limits: 30s cooldown per email; 30 issuances/hour per email; 1000/hour per
IP. Sends a magic-link email with a 15-minute, single-use token.

### `GET /auth/verify?token=…`

Browser-followed redirect. Validates the token, marks it used, upserts the
user, sets `rpow_session` cookie (httpOnly, sameSite=lax, 30d), and
302-redirects to `${WEB_ORIGIN}/#/wallet`.

→ 400 `BAD_REQUEST` if the token is missing, used, or expired.

### `POST /auth/logout`

Clears the `rpow_session` cookie. Always returns `{ "ok": true }`.

### `GET /me` 🔒

```json
{
  "email": "user@example.com",
  "balance_base_units": "1234567890",
  "minted_base_units":  "1234567890",
  "sent_base_units":    "0",
  "received_base_units": "0",
  "wrap_allowed": false,
  "solana_wallet": null,
  "srpow_supply_owned_base_units": "0"
}
```

`balance_base_units` sums `state='VALID'` tokens. `minted_base_units` sums
all root tokens (`parent_token_id IS NULL`). `srpow_supply_owned_base_units`
sums `state='WRAPPED'` tokens — i.e. how much the user has wrapped to
Solana through this account.

## Mining

### `POST /challenge` 🔒

→ 200
```json
{
  "challenge_id": "<uuid>",
  "nonce_prefix": "<32 hex chars = 16 bytes>",
  "difficulty_bits": 24,
  "expires_at": "2026-05-08T22:05:00.000Z"
}
```
→ 410 `SUPPLY_EXHAUSTED` (cap reached).

The challenge is good for 5 minutes. The supply check is cached for 5s and
only advisory; the authoritative cap check is on `/mint`.

### `POST /mint` 🔒

```json
{ "challenge_id": "<uuid>", "solution_nonce": "<decimal u64>" }
```

→ 200 `{ "token": { "id": "<uuid>", "value_base_units": "7812500", "issued_at": "…" } }`
→ 400 `BAD_REQUEST` (unknown challenge or invalid body)
→ 400 `INVALID_SOLUTION`
→ 400 `CHALLENGE_ALREADY_CLAIMED`
→ 410 `CHALLENGE_EXPIRED`
→ 410 `SUPPLY_EXHAUSTED`

Hash is `SHA-256(nonce_prefix ‖ u64_LE(solution_nonce))`. Solution is
valid if it has ≥ `difficulty_bits` trailing zero bits.

## Transfer

### `POST /send` 🔒

```json
{
  "recipient_email": "friend@example.com",
  "amount_base_units": "7812500",
  "idempotency_key": "<8..80 chars>"
}
```

→ 200, recipient exists:
```json
{ "ok": true, "transferred_base_units": "7812500",
  "recipient_email": "friend@example.com", "transfer_id": "<uuid>" }
```
→ 200, recipient is new (pending claim email sent):
```json
{ "ok": true, "pending": true, "transferred_base_units": "7812500",
  "recipient_email": "friend@example.com", "transfer_id": "<pending-uuid>" }
```
→ 400 `INSUFFICIENT_BALANCE`
→ 400 `EXACT_SUM_REQUIRED` — your token denominations don't combine to the requested amount
→ 400 `BAD_REQUEST` (cannot send to self; or invalid body)
→ 400 `RECIPIENT_UNSUBSCRIBED` — recipient has unsubscribed and is not a user
→ 409 `BAD_REQUEST` — `idempotency_key` reused with different params

Replays of the same key with the same params return the original outcome.

### `GET /claim?token=…`

Browser-followed redirect. Validates a pending-transfer claim token,
mints a fresh RPOW token to the recipient, increments the cap counter,
records the completed transfer, sets a session for the recipient, and
302-redirects to `${WEB_ORIGIN}/#/wallet`.

→ 400 `INVALID_CLAIM`
→ 400 `ALREADY_CLAIMED`
→ 410 `CLAIM_EXPIRED`

## Read views

### `GET /activity` 🔒

→ 200 array of up to 100 entries newest first:
```json
[
  { "type": "mint",    "amount_base_units": "7812500", "at": "…" },
  { "type": "send",    "amount_base_units": "7812500", "counterparty_email": "friend@example.com", "at": "…" },
  { "type": "receive", "amount_base_units": "7812500", "counterparty_email": "another@example.com", "at": "…" }
]
```

### `GET /ledger`

Public; cached 5s.

```json
{
  "total_minted_base_units": "<bigint>",          // sum of all root token values
  "total_transferred_base_units": "<bigint>",     // sum of all transfers.amount
  "circulating_supply_base_units": "<bigint>",    // sum of state='VALID' tokens
  "minted_supply_counter_base_units": "<bigint>", // app_counters.minted_supply
  "max_supply_base_units": "<bigint>",            // mintMaxSupply * 10^9
  "base_units_per_rpow": "1000000000",
  "current_difficulty_bits": 24,
  "current_reward_base_units": "7812500",
  "next_reward_base_units": "3906250",
  "next_halving_at_base_units": "1000000000000000",  // 1M RPOW in base units
  "base_units_to_next_halving": "<bigint>",
  "halving_index": 0,
  "is_capped": false,
  "user_count": 4321
}
```

## Solana wallet binding

### `POST /phantom/challenge` 🔒

→ 200 `{ "nonce": "<uuid>", "message": "rpow2.com bind: <nonce>", "expires_at": "…" }`

The user must sign the *literal* `message` string (UTF-8 bytes) with their
Phantom wallet's `signMessage` API. Nonce is good for 5 minutes,
single-use.

### `POST /phantom/bind` 🔒

```json
{
  "nonce": "<uuid from /phantom/challenge>",
  "wallet_address": "<base58 32-byte ed25519 pubkey>",
  "signature_base58": "<base58 64-byte signature>"
}
```

→ 200 `{ "ok": true, "solana_wallet": "<base58>" }`
→ 400 `NONCE_INVALID` (unknown nonce, or for a different user)
→ 400 `NONCE_EXPIRED`
→ 400 `NONCE_INVALID` "nonce already used" — except idempotent re-bind of
  the same wallet, which still returns 200.
→ 400 `BAD_SIGNATURE`
→ 400 `WALLET_TAKEN` — that wallet is already bound to another email.

## SRPOW (Solana wrap)

### `POST /srpow/wrap` 🔒 (allowlist-gated)

```json
{ "amount_base_units": "1000000000", "idempotency_key": "<8..80>" }
```

→ 200 (success):
```json
{ "ok": true, "event_id": "<uuid>", "status": "CONFIRMED",
  "solana_signature": "<base58>" }
```
→ 202 (replay of an in-flight request):
```json
{ "event_id": "<uuid>", "status": "PENDING",
  "message": "wrap in progress, retry shortly" }
```
→ 400 `BAD_REQUEST` (invalid body, or `idempotency_key` reused with different
  params, or replay of a previously failed wrap returned to caller — see below)
→ 400 `INSUFFICIENT_BALANCE`
→ 400 `EXACT_SUM_REQUIRED`
→ 400 `NO_WALLET_BOUND`
→ 403 `FORBIDDEN` — email is not in `WRAP_ALLOWED_EMAILS`.
→ 409 `BAD_REQUEST` — `idempotency_key` reused with different params.
→ 503 `BRIDGE_FAILED`:
```json
{ "error": "BRIDGE_FAILED", "event_id": "<uuid>",
  "status": "REFUNDED", "failure_reason": "<string>" }
```

The request blocks until Solana confirms (typically a few seconds at
`confirmed` commitment) or the wrap times out (default 60s, env
`SRPOW_WRAP_TIMEOUT_MS`).

### `GET /srpow/events` 🔒

→ 200, array of `WrapEvent` (see protocol types), newest first, max 100.

### `GET /srpow/events/:id` 🔒

→ 200 single `WrapEvent` for the logged-in user.
→ 404 `NOT_FOUND` if the id doesn't exist or belongs to another user.

## Email & misc

### `POST /unsubscribe?token=…`

RFC 8058 one-click unsubscribe. Hit by ESPs from the
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` header.

→ 200 `{ "ok": true }`
→ 400 `BAD_TOKEN`

### `GET /unsubscribe?token=…`

Human-friendly browser GET; returns a small HTML confirmation page on
success.

### `GET /.well-known/rpow-pubkey.pem`

Returns the server's Ed25519 public key as PEM-wrapped SPKI. Used by
external code to verify token `server_sig`s without round-tripping through
the server.

### `GET /health`

→ 200 `{ "ok": true }`. Used by the systemd healthcheck timer and any
external uptime monitor.

## Test-only

### `GET /test/last-link/:email`

Available **only** when `RPOW_TEST_INBOX=true`. Returns a 302 redirect to
the most recent magic link for `:email`, or `?json=1` to get
`{ "link": "…" }`. Used by Playwright and integration tests.

→ 404 `NO_LINK` if no magic link has been mailed to that address.

## Error envelope

All non-2xx JSON responses share this shape:

```ts
interface ApiError {
  error: 'RECIPIENT_NOT_FOUND' | 'INSUFFICIENT_BALANCE' | 'INVALID_SOLUTION'
       | 'CHALLENGE_EXPIRED' | 'CHALLENGE_ALREADY_CLAIMED' | 'RATE_LIMITED'
       | 'UNAUTHORIZED' | 'BAD_REQUEST' | 'INTERNAL'
       | string;       // SRPOW-only codes layered on top
  message: string;
  retry_after?: number;
}
```

(Newer SRPOW codes — `BRIDGE_FAILED`, `NO_WALLET_BOUND`, `WALLET_TAKEN`,
`EXACT_SUM_REQUIRED`, `RECIPIENT_UNSUBSCRIBED`, `SUPPLY_EXHAUSTED` — aren't
in the union literal in `protocol.ts` but are standard strings on the
wire.)

## CORS / cookies

- `Access-Control-Allow-Origin` echoes `WEB_ORIGIN` only; `Access-Control-Allow-Credentials: true`.
- All session-bearing requests must use `credentials: 'include'` (see
  [`apps/web/src/api.ts`](../../apps/web/src/api.ts)).
- The cookie is `httpOnly; sameSite=lax; secure` (in production), so the
  SPA cannot read it but can include it on cross-origin XHRs back to
  `api.rpow2.com`.
