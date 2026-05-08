# 02 · Protocol

End-to-end flows. Each section has a sequence sketch and a pointer to the
authoritative source file.

## 1. Authentication: magic link

```
client                        server                            mailer
  │                              │                                 │
  │  POST /auth/request          │                                 │
  │  { email }                   │                                 │
  │ ───────────────────────────► │                                 │
  │                              │  cooldown / per-email / per-IP  │
  │                              │  rate-limit checks              │
  │                              │                                 │
  │                              │  random 32B → token             │
  │                              │  store sha256(token) in         │
  │                              │  magic_links{expires=now+15min} │
  │                              │  send email with                │
  │                              │  /auth/verify?token=…  ────────►│
  │ ◄─────────────  { ok, cooldown_seconds: 30 }                    │
  │                                                                 │
  │  user clicks email link                                         │
  │  GET /auth/verify?token=…    │                                  │
  │ ───────────────────────────► │                                  │
  │                              │  hash(token) → look up row,      │
  │                              │  expires_at>now, used_at IS NULL │
  │                              │  UPDATE used_at=now              │
  │                              │  UPSERT users(email)             │
  │                              │  set rpow_session cookie (30d)   │
  │                              │  302 → ${WEB_ORIGIN}/#/wallet    │
  │ ◄─────────────────────────── │                                  │
```

- 30s cooldown per email, 30/hour per email, 1000/hour per IP (per-IP cap is
  generous; the per-email cap is the real anti-spam lever — see comments in
  [`routes/auth.ts`](../../apps/server/src/routes/auth.ts)).
- Token is base64url(`randomBytes(32)`) and stored as SHA-256 hash only
  (`magic.ts`).
- `verify` returns 400 for any expired / used / unknown token.
- Magic link emails carry `List-Unsubscribe` headers (RFC 8058) backed by
  HMAC-signed unsubscribe tokens (`unsub.ts`).
- Sessions are HMAC-signed `email|exp` cookies; the only cryptographic
  artifact required to act as a user. There is no refresh-token dance, no
  CSRF token (the SPA is on a different origin and CORS-locked, cookie is
  `sameSite=lax`).

## 2. Mining: hashcash + halving

```
client                                server
  │  POST /challenge                       │
  │ ──────────────────────────────────────►│
  │                                        │  read minted_supply (cached 5s)
  │                                        │  if minted >= 21M → 410 SUPPLY_EXHAUSTED
  │                                        │  difficulty = max(floor, scheduled)
  │                                        │  INSERT challenges(uuid, prefix=16B,
  │                                        │    difficulty, expires=now+5m)
  │ ◄────────  { challenge_id, nonce_prefix(hex), difficulty_bits, expires_at }
  │                                        │
  │  Web Worker (miner.worker.ts):         │
  │    while (!aborted) {                  │
  │      h = SHA256(prefix ‖ nonce_LE_8B)  │
  │      if trailing_zero_bits(h) ≥ d → submit
  │    }                                   │
  │                                        │
  │  POST /mint                            │
  │  { challenge_id, solution_nonce }      │
  │ ──────────────────────────────────────►│
  │                                        │  BEGIN
  │                                        │  pg_advisory_xact_lock('rpow_mint_supply')
  │                                        │  SELECT challenge FOR UPDATE
  │                                        │  reject if claimed/expired
  │                                        │  verifySolution(prefix, nonce, bits)
  │                                        │  reward = currentRewardBaseUnits(supply)
  │                                        │  UPDATE app_counters
  │                                        │      SET value = value + reward
  │                                        │      WHERE name='minted_supply' AND value+reward<=cap
  │                                        │    (rowCount=0 → 410 SUPPLY_EXHAUSTED)
  │                                        │  UPDATE challenges SET claimed_at=now()
  │                                        │  sign payload {id, hash(email), value, issued_at}
  │                                        │  INSERT tokens(id, owner, value, VALID, sig)
  │                                        │  COMMIT
  │ ◄────────  { token: { id, value_base_units, issued_at } }
```

Authoritative files:
[`routes/challenge.ts`](../../apps/server/src/routes/challenge.ts),
[`routes/mint.ts`](../../apps/server/src/routes/mint.ts),
[`pow.ts`](../../apps/server/src/pow.ts),
[`schedule.ts`](../../apps/server/src/schedule.ts),
[`signing.ts`](../../apps/server/src/signing.ts),
[`apps/web/src/miner.worker.ts`](../../apps/web/src/miner.worker.ts).

The full math (difficulty, halving, base units, supply oracle) is in
[`03-mining-and-halving.md`](./03-mining-and-halving.md).

## 3. Transfer to an existing user

`POST /send` invalidates the sender's tokens and reissues fresh ones to the
recipient with the **same per-token denominations**. There is no in-place
balance update — the ledger is append-only-ish (rows are mutated to set
`state='INVALIDATED'` and `invalidated_at`, never deleted).

```
BEGIN
  -- idempotency: same key in transfers OR pending_transfers? return original outcome
  -- pull sender's VALID tokens FOR UPDATE SKIP LOCKED, ordered by (value DESC, id ASC)
  -- greedy exact-sum subset selection
  IF sum != target → 'EXACT_SUM_REQUIRED' (or 'INSUFFICIENT_BALANCE' if total<target)
  IF recipient ∈ users:
    FOR each picked token:
      UPDATE picked → INVALIDATED
      INSERT new tokens row owned by recipient, value=picked.value,
             parent_token_id=picked.id, server_sig=ed25519(payload)
    INSERT transfers(idempotency_key, …)
  ELSE:
    -- pending claim path (see §4)
    …
COMMIT
```

Key properties:

- **Exact-sum required.** Tokens are not splittable. If the user has only
  {7,812,500} base units and tries to send 1,000,000 base units, the
  request fails with `EXACT_SUM_REQUIRED`. The greedy walk (largest first,
  skip overshoots) is sound for this case because token denominations are
  always halving-schedule rewards (each is a power-of-two fraction of
  10⁹), but the implementation does not pretend to solve the general subset
  sum — it just reports `EXACT_SUM_REQUIRED` if the greedy pick doesn't hit.
- **`FOR UPDATE SKIP LOCKED`** so concurrent `/send` and `/srpow/wrap` calls
  by the same user don't race over the same rows.
- **Audit chain.** `parent_token_id` lets anyone walk a token back to its
  mint event by following the chain.
- **Idempotency** is mandatory (`idempotency_key` is a required field).
  Replays return the original result. A reused key with different
  parameters returns 409.

Source: [`routes/send.ts`](../../apps/server/src/routes/send.ts).

## 4. Send to a non-user → pending claim

If `recipient_email` has no `users` row, the sender's tokens are still
**invalidated immediately** (so the same balance can't be sent twice), but
no new tokens exist yet. Instead a `pending_transfers` row is created and a
claim email is sent with a one-time URL.

```
client (sender)            server                              recipient inbox
   │  POST /send                │                                  │
   │ ──────────────────────────►│  recipient ∉ users               │
   │                            │  if recipient ∈ email_unsubscribes
   │                            │      → 400 RECIPIENT_UNSUBSCRIBED
   │                            │      (sender's tokens untouched) │
   │                            │  else:                            │
   │                            │    UPDATE picked → INVALIDATED   │
   │                            │    rand 32B → claim_token         │
   │                            │    INSERT pending_transfers(      │
   │                            │      sha256(claim_token),         │
   │                            │      expires=now+30d, …)         │
   │                            │    send claim email ─────────────►│
   │                            │      with /claim?token=…          │
   │ ◄─────  { ok, pending: true, transferred_base_units, transfer_id }
   │                            │
   │                            │  ── recipient clicks link ──     │
   │                            │  GET /claim?token=…              │
   │                            │  hash → row FOR UPDATE           │
   │                            │  reject if claimed_at OR expired │
   │                            │  UPSERT users(recipient)          │
   │                            │  INSERT new VALID token           │
   │                            │      (parent_token_id IS NULL,    │
   │                            │       counts as minted supply)    │
   │                            │  UPDATE app_counters             │
   │                            │      minted_supply += amount     │
   │                            │  INSERT transfers(idem='claim:'…)│
   │                            │  UPDATE pending_transfers claimed_at
   │                            │  set rpow_session cookie         │
   │                            │  302 → /#/wallet                  │
```

Notes:

- Claim links are 30 days, single-use. The token is hashed at rest exactly
  like a magic link (`pending_transfers.claim_token_hash` is `BYTEA`).
- Claim mints a **single new token** of value=amount. The original parent
  chain is broken at the invalidation step — the new token has
  `parent_token_id IS NULL`, so it counts as "minted supply" for `/me`'s
  `minted_base_units` and `/ledger`'s `total_minted_base_units`. This is a
  known modeling quirk noted as a follow-up in the SRPOW spec; cap math
  stays conservative because the source tokens were already counted when
  originally mined.
- The `/claim` GET also creates a session for the recipient — claim is the
  fastest user-onboarding path.

Source: [`routes/claim.ts`](../../apps/server/src/routes/claim.ts).

## 5. SRPOW wrap (Solana)

Detailed in [`05-srpow-bridge.md`](./05-srpow-bridge.md). One-line summary:
allowlisted users bind a Phantom wallet via `signMessage`, then `/srpow/wrap`
locks rpow tokens (`VALID → LOCKED_FOR_BRIDGE`), submits an SPL `mintTo` for
the same base-unit amount, and on confirmation flips the rows to `WRAPPED`.
On failure or timeout the rows revert to `VALID` and the request returns 503.

## 6. Read-only views

- `/me` — current user's email, balances (`balance_base_units`,
  `minted_base_units`, `sent_base_units`, `received_base_units`,
  `srpow_supply_owned_base_units`), `wrap_allowed`, bound `solana_wallet`.
- `/activity` — last 100 mint/send/receive entries for the logged-in user
  (UNION over `tokens` mints, `transfers` sends, `transfers` receives,
  ordered by `at DESC`).
- `/ledger` — public; aggregate stats and live halving info. Cached 5s.
- `/srpow/events` and `/srpow/events/:id` — owner-scoped wrap event history.
- `/.well-known/rpow-pubkey.pem` — server's Ed25519 public key in PEM SPKI
  form. Anyone can verify a token's `server_sig` against this key.
- `/health` — `{ ok: true }` for the systemd healthcheck timer and external
  monitors.

Sources: [`routes/me.ts`](../../apps/server/src/routes/me.ts),
[`routes/activity.ts`](../../apps/server/src/routes/activity.ts),
[`routes/ledger.ts`](../../apps/server/src/routes/ledger.ts).

## 7. Test-mode helpers

Set `RPOW_TEST_INBOX=true` and the server uses an in-memory `FakeMailer`:

- Magic links are printed to the server's stdout when emitted.
- `GET /test/last-link/:email` returns a 302 to the most recent magic link
  for that email, or `?json=1` to get `{ link }` JSON. This is what
  Playwright (`apps/web/e2e/happy-path.spec.ts`) and integration tests use
  to skip the inbox round-trip.

Source: bottom of [`buildApp.ts`](../../apps/server/src/buildApp.ts).
