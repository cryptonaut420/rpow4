# 06 · API Reference

Public REST API for **rpow4**. Everything you can do in the web UI you can
do over HTTP — read network state, mine, send, manage your wallet, explore
accounts and transactions.

> **Live, browsable version:** open the `/docs` page in the web app
> (e.g. https://rpow4.com/#/docs) for the same content with copy-paste
> code blocks and section anchors.

---

## Conventions

**Base URL.** Production: `https://rpow4.com`. Local dev: `http://localhost:8081`.

**Content type.** `application/json` in both directions, except
`/.well-known/rpow-pubkey.pem` (text/plain).

**Base units.** All amounts are integers in *base units* serialized as
decimal strings. `1 RPOW = 10⁹ base units`.

**Pubkeys.** 32-byte Ed25519 public keys, base58-encoded (43–44 chars).

**Sessions.** Endpoints marked *session* require an HMAC-signed `HttpOnly`
cookie called `rpow4_session` (TTL 7 days). Get one by completing
`/auth/session` (existing wallet) or `/signup` (new wallet). With `fetch`
set `credentials: 'include'`; with `curl` use `-c cookies.txt -b cookies.txt`.

**Caching.** Read endpoints emit `ETag` and short `Cache-Control` headers.
Repeat polls with `If-None-Match` get a cheap `304 Not Modified`.

**Errors.** Non-2xx responses have a JSON body
`{ "error": "CODE", "message": "human readable" }`. Full code reference
at the [end of this doc](#error-codes).

---

## Signing requests

State-changing endpoints require an Ed25519 signature over a *canonical
message*:

1. Take the request body, but **exclude the signature field itself**.
2. Sort object keys alphabetically at every depth.
3. BigInts and bigint-typed numbers serialize as decimal strings.
4. Prepend the domain prefix `"rpow4." + action + ".v1\n"`.
5. UTF-8 encode, sign with Ed25519, base58-encode the signature.

The shared package `@rpow/shared` exports `canonicalMessage`,
`canonicalJson`, `signCanonical`, and `verifyCanonical`. Action names
are an enum: `'auth.session'`, `'mint'`, `'transfer'`,
`'account.set_display_name'`, `'account.signup'`.

```js
import { signCanonical } from '@rpow/shared';

const body = {
  recipient_pubkey: 'Bz7K...',
  amount_base_units: '1000000000',
  idempotency_key: crypto.randomUUID(),
  memo: 'lunch',
};
const client_signature_base58 = signCanonical('transfer', body, secretKey);
const wire = { ...body, client_signature_base58 };
```

The full canonical-json algorithm fits in <30 lines — see
`packages/shared/src/canonical.ts`.

---

## Endpoint index

| Group | Endpoint | Auth |
|---|---|---|
| [Network state](#network-state) | `GET /health` | public |
| | `GET /ledger` | public |
| | `GET /ledger/events` | public |
| | `GET /explorer/feed` | public |
| | `GET /explorer/tx/:id` | public |
| | `GET /explorer/account/:pubkey` | public |
| | `GET /lookup/:name` | public |
| | `GET /stats/leaderboard` | public |
| | `GET /faucet` | public |
| | `GET /.well-known/rpow-pubkey.pem` | public |
| [Account creation](#account-creation) | `POST /signup/challenge` | public |
| | `POST /signup` | PoW + sig |
| [Sign-in](#sign-in) | `POST /auth/challenge` | public |
| | `POST /auth/session` | sig |
| | `POST /auth/logout` | public |
| [Your account](#your-account) | `GET /me` | session |
| | `POST /me/display_name` | session + sig |
| [Mining](#mining) | `POST /challenge` | session |
| | `POST /mint` | session + sig |
| [Sending](#sending) | `POST /send` | session + sig |
| | `POST /faucet/claim` | session |
| [Activity](#activity) | `GET /activity` | session |

---

## Network state

Read-only counters and the public event feed. No authentication.

### `GET /ledger`

Network counters: minted supply, block height, halving info, current
difficulty and reward. Computed from maintained counters — never scans
the event log.

**Response 200**

```json
{
  "total_minted_base_units": "104500000000",
  "total_transferred_base_units": "0",
  "circulating_supply_base_units": "104500000000",
  "max_supply_base_units": "21000000000000000",
  "base_units_per_rpow": "1000000000",
  "block_height": "11",
  "transfer_count": "0",
  "treasury_balance_base_units": "0",
  "current_fee_base_units": "10000000",
  "current_difficulty_bits": 22,
  "next_difficulty_bits": 22,
  "next_difficulty_at_block": "1024",
  "current_reward_base_units": "9500000000",
  "next_reward_base_units": "9500000000",
  "next_halving_at_block": "1048576",
  "halving_index": 0,
  "is_capped": false,
  "user_count": 4
}
```

```bash
curl https://rpow4.com/ledger
```

`/ledger/stats` is an alias of `/ledger`.

### `GET /ledger/events?cursor=&limit=`

Paginated public event log, newest first. Cursor pagination — pass the
previous response's `next_cursor` to read older events. Default `limit`
50, max 100.

**Response 200**

```json
{
  "events": [
    {
      "id": "ad6c0c0e-d4c1-4f26-9e66-...",
      "type": "mint",
      "actor_pubkey": "9aXt...",
      "amount_base_units": "9500000000",
      "challenge_id": "8b7c...",
      "client_signature_base58": "5J7q...",
      "at": "2026-05-08T22:04:11.123Z"
    }
  ],
  "next_cursor": "eyJldmVudF9zZXEiOiI3In0"
}
```

### `GET /explorer/feed?cursor=&limit=`

Like `/ledger/events`, plus `actor_display_name` and
`counterparty_display_name` when set. Best for building a public
activity timeline UI.

### `GET /explorer/tx/:id`

Look up a single transaction by its UUID. Once recorded, content never
changes — cached as `immutable` for an hour.

**Errors**

| Status | Code | When |
|---|---|---|
| 404 | `BAD_REQUEST` | no transaction with that UUID, or malformed UUID |

### `GET /explorer/account/:pubkey?cursor=&limit=`

Public account view: balance, lifetime stats, and event history.

**Response 200**

```json
{
  "pubkey": "9aXt...",
  "display_name": "alice",
  "spendable_base_units": "8500000000",
  "minted_base_units": "9500000000",
  "sent_base_units": "1000000000",
  "received_base_units": "0",
  "blocks_mined": "1",
  "total_count": 2,
  "items": [
    { "type": "send", "event_seq": "12", "amount_base_units": "1000000000",
      "fee_base_units": "10000000", "memo": "lunch",
      "counterparty_pubkey": "Bz7K...", "counterparty_display_name": "bob",
      "at": "2026-05-08T22:05:22Z" },
    { "type": "mint", "event_seq": "11", "amount_base_units": "9500000000",
      "at": "2026-05-08T22:04:11Z" }
  ]
}
```

### `GET /lookup/:name`

Resolve a display name (handle) to a pubkey. Case-insensitive.

```bash
curl https://rpow4.com/lookup/alice
# { "pubkey": "9aXt...", "display_name": "alice" }
```

**Errors**

| Status | Code | When |
|---|---|---|
| 400 | `BAD_REQUEST` | name is empty or > 64 chars |
| 404 | `NAME_NOT_FOUND` | no account with that display name |

### `GET /stats/leaderboard?sort=balance|minted`

Top-100 accounts by balance (default) or by lifetime minted. Cached
for 10s.

### `GET /faucet`

Faucet config + your eligibility (when signed in). Anonymous callers
see global config plus their IP cooldown; signed-in callers also see
their per-pubkey cooldown.

### `GET /.well-known/rpow-pubkey.pem`

The server's Ed25519 signing public key, in PEM form. Use it to verify
`server_sig` on tokens minted by this instance.

---

## Account creation

New accounts are gated by a small browser-side proof-of-work (default
22 bits, ~5–10 seconds on a modern CPU) — anti-spam friction, **not**
the mining difficulty.

### `POST /signup/challenge`

Receive a stateless, MAC'd PoW envelope tied to your handle and pubkey.
The handle is checked for availability before the envelope is issued,
but no DB row is reserved.

**Body**

```json
{
  "handle": "alice",
  "pubkey": "9aXt..."
}
```

**Response 200**

```json
{
  "envelope": {
    "handle": "alice",
    "pubkey": "9aXt...",
    "nonce": "f2c1d4...",
    "difficulty_bits": 22,
    "issued_at": "2026-05-08T22:05:22Z",
    "expires_at": "2026-05-08T23:05:22Z",
    "domain": "rpow4.signup"
  },
  "envelope_mac": "ab12...",
  "pow_prefix_hex": "7369676e75701f..."
}
```

**Errors**

| Status | Code | When |
|---|---|---|
| 400 | `BAD_REQUEST` | handle fails validation (charset, length, reserved name) |
| 409 | `NAME_TAKEN` | handle is already registered |

### `POST /signup`

Submit a solved PoW + Ed25519 signature; on success the account is
created and a session cookie is set.

PoW target: find `solution_nonce` such that
`SHA-256(prefix_bytes || u64le(solution_nonce))` has at least
`difficulty_bits` trailing zero bits. The signature is over canonical
message `'account.signup'` with body `{ handle, pubkey, nonce }`.

**Body**

```json
{
  "envelope": { "...": "from /signup/challenge" },
  "envelope_mac": "ab12...",
  "solution_nonce": "412384",
  "client_signature_base58": "5J7q..."
}
```

**Response 200**

```json
{ "ok": true, "pubkey": "9aXt...", "display_name": "alice" }
```

**Errors**

| Status | Code | When |
|---|---|---|
| 400 | `BAD_REQUEST` | envelope mac mismatch, malformed handle/pubkey, domain mismatch |
| 400 | `INVALID_SOLUTION` | solution_nonce does not meet difficulty_bits |
| 401 | `INVALID_SIGNATURE` | signature does not verify against envelope.pubkey |
| 409 | `NAME_TAKEN` | handle was claimed between challenge and submit |
| 409 | `SIGNUP_EXPIRED` | envelope expired, or server difficulty changed |

---

## Sign-in

For wallets that already exist (created here or imported from a seed
phrase / private key).

### `POST /auth/challenge`

```json
{ "pubkey": "9aXt..." }
```

Returns an envelope and MAC; expires in 5 minutes. No DB writes.

### `POST /auth/session`

Exchange a signed envelope for a session cookie. Sign with
`canonicalMessage('auth.session', envelope)`.

**Body**

```json
{
  "envelope": { "...": "from /auth/challenge" },
  "envelope_mac": "ab12...",
  "signature_base58": "5J7q..."
}
```

**Response 200**

```json
{ "ok": true, "pubkey": "9aXt..." }
```

Sets `rpow4_session` cookie (`HttpOnly`, `SameSite=Lax`, 7-day TTL).

### `POST /auth/logout`

Clears the session cookie. Always returns `{ "ok": true }`.

---

## Your account

### `GET /me` *(session)*

```json
{
  "pubkey": "9aXt...",
  "display_name": "alice",
  "balance_base_units": "8500000000",
  "minted_base_units": "9500000000",
  "sent_base_units": "1000000000",
  "received_base_units": "0"
}
```

### `POST /me/display_name` *(session + sig)*

Set or clear your handle. Must be unique (case-insensitive). Sign the
canonical body for action `'account.set_display_name'`.

**Body**

```json
{
  "display_name": "alice",
  "client_signature_base58": "5J7q..."
}
```

To clear: `display_name: null`.

**Errors**

| Status | Code | When |
|---|---|---|
| 400 | `BAD_REQUEST` | name fails validation |
| 401 | `INVALID_SIGNATURE` | signature does not verify |
| 409 | `NAME_TAKEN` | someone else holds that handle |

---

## Mining

Mining issues currency. Two-step: get a challenge, find a SHA-256
nonce that meets the current difficulty, then submit a signed mint.
Reward halves on a Bitcoin-like schedule; supply hard-capped at
21 M RPOW.

### `POST /challenge` *(session)*

Empty body. Returns:

```json
{
  "challenge_id": "8b7c0c0e-...",
  "nonce_prefix": "f2c1d4...",
  "difficulty_bits": 22,
  "issued_at": "2026-05-08T22:05:22Z",
  "expires_at": "2026-05-08T22:10:22Z",
  "challenge_mac": "ab12..."
}
```

**Errors**

| Status | Code | When |
|---|---|---|
| 410 | `SUPPLY_EXHAUSTED` | 21M cap reached |

### `POST /mint` *(session + sig)*

PoW target: find `solution_nonce` such that
`SHA-256(nonce_prefix_bytes || u64le(solution_nonce))` has at least
`difficulty_bits` trailing zero bits. Sign canonical body for action
`'mint'`: `{ challenge_id, solution_nonce }`.

**Body**

```json
{
  "challenge_id": "8b7c...",
  "nonce_prefix": "f2c1d4...",
  "difficulty_bits": 22,
  "issued_at": "...",
  "expires_at": "...",
  "challenge_mac": "ab12...",
  "solution_nonce": "412384",
  "client_signature_base58": "..."
}
```

**Response 200**

```json
{
  "token": {
    "id": "ad6c0c0e-...",
    "value_base_units": "9500000000",
    "issued_at": "2026-05-08T22:05:22.456Z"
  }
}
```

**Errors**

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_SOLUTION` | hash does not meet difficulty |
| 400 | `CHALLENGE_ALREADY_CLAIMED` | this challenge_id was already claimed |
| 401 | `INVALID_SIGNATURE` | mint signature does not verify |
| 410 | `CHALLENGE_EXPIRED` | expired, or difficulty advanced under you |
| 410 | `SUPPLY_EXHAUSTED` | cap hit during commit |

```js
// minimal end-to-end mint
const ch = await fetch(`${API}/challenge`, {
  method: 'POST', credentials: 'include',
}).then(r => r.json());

const prefix = hexToBytes(ch.nonce_prefix);
const solutionNonce = await mine(prefix, ch.difficulty_bits);

const sig = signCanonical('mint', {
  challenge_id: ch.challenge_id,
  solution_nonce: solutionNonce.toString(),
}, secretKey);

const r = await fetch(`${API}/mint`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    ...ch,
    solution_nonce: solutionNonce.toString(),
    client_signature_base58: sig,
  }),
}).then(r => r.json());
```

---

## Sending

### `POST /send` *(session + sig)*

Idempotent transfer. Sign canonical body for action `'transfer'`:
`{ recipient_pubkey, amount_base_units, idempotency_key }` (plus
`memo` when present).

**Body**

```json
{
  "recipient_pubkey": "Bz7K...",
  "amount_base_units": "1000000000",
  "idempotency_key": "client-abc-...",
  "client_signature_base58": "...",
  "memo": "lunch"
}
```

**Response 200**

```json
{
  "ok": true,
  "transfer_id": "0a48c5b4-...",
  "transferred_base_units": "1000000000",
  "fee_base_units": "10000000",
  "recipient_pubkey": "Bz7K..."
}
```

**Errors**

| Status | Code | When |
|---|---|---|
| 400 | `BAD_REQUEST` | invalid recipient/amount, or sending to yourself |
| 400 | `INSUFFICIENT_BALANCE` | not enough tokens (incl. fee) |
| 401 | `INVALID_SIGNATURE` | transfer signature does not verify |
| 409 | `BAD_REQUEST` | idempotency_key reused with different parameters |

### `POST /faucet/claim` *(session)*

Claim a small treasury drip (dev / testnet). No body. Cooldown
enforced per-pubkey AND per-IP.

**Response 200**

```json
{
  "ok": true,
  "amount_base_units": "100000000",
  "transfer_id": "0a48c5b4-...",
  "claimed_at": "2026-05-08T22:05:22Z",
  "next_claim_at": "2026-05-09T22:05:22Z"
}
```

**Errors**

| Status | Code | When |
|---|---|---|
| 403 | `BAD_REQUEST` | faucet is disabled |
| 429 | `COOLDOWN_ACTIVE` | within cooldown for this pubkey or IP |
| 503 | `TREASURY_DRY` | treasury balance < claim amount |

---

## Activity

### `GET /activity?cursor=&limit=&type=` *(session)*

Mints, sends, and receives that involve your pubkey, newest first.
`type` ∈ `{mint, send, receive, all}` (default `all`).

**Response 200**

```json
{
  "balance_base_units": "8500000000",
  "total_count": 2,
  "items": [
    { "type": "send", "event_seq": "12", "amount_base_units": "1000000000",
      "fee_base_units": "10000000", "memo": "lunch",
      "counterparty_pubkey": "Bz7K...", "counterparty_display_name": "bob",
      "client_signature_base58": "...",
      "at": "2026-05-08T22:05:22Z" }
  ],
  "next_cursor": "11"
}
```

---

## Error codes

| Status | Code | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | malformed body, query, or param |
| 400 | `INVALID_SOLUTION` | PoW does not meet difficulty |
| 400 | `INSUFFICIENT_BALANCE` | sender has < (amount + fee) |
| 400 | `CHALLENGE_ALREADY_CLAIMED` | mint challenge_id was already used |
| 401 | `UNAUTHORIZED` | session required and missing/expired |
| 401 | `INVALID_SIGNATURE` | Ed25519 signature does not verify |
| 403 | `BAD_REQUEST` | feature disabled (e.g. faucet off) |
| 404 | `NOT_FOUND` | resource not found |
| 404 | `NAME_NOT_FOUND` | `/lookup/:name` resolves to no account |
| 409 | `NAME_TAKEN` | handle is already in use |
| 409 | `BAD_REQUEST` | idempotency_key reused with different parameters |
| 409 | `SIGNUP_EXPIRED` | signup envelope expired or difficulty changed |
| 410 | `CHALLENGE_EXPIRED` | mining challenge expired or difficulty advanced |
| 410 | `SUPPLY_EXHAUSTED` | 21M cap reached |
| 429 | `COOLDOWN_ACTIVE` | faucet cooldown for this pubkey or IP |
| 503 | `TREASURY_DRY` | treasury cannot fund a faucet claim |
