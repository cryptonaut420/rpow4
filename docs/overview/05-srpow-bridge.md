# 05 · SRPOW Bridge (Solana wrap)

`SRPOW` is a Solana SPL token (9 decimals, freeze authority renounced) that
serves as a 1:1 wrapper for `WRAPPED` rpow rows. The canonical design lives
in [`docs/superpowers/specs/2026-05-08-srpow-wrap-design.md`](../superpowers/specs/2026-05-08-srpow-wrap-design.md);
this doc is the implementation tour.

## Components

```
apps/server/src/routes/srpow.ts         /srpow/wrap, /srpow/events, /srpow/events/:id
apps/server/src/routes/phantom.ts       /phantom/challenge, /phantom/bind
apps/server/src/srpow-reconcile.ts      boot-time PENDING-event scanner
apps/server/src/wrap-allowlist.ts       parse WRAP_ALLOWED_EMAILS
apps/server/src/bridge-keys.ts          decode BRIDGE_KEYPAIR_BASE58 → Keypair
apps/server/scripts/create-srpow-mint.ts        one-shot: createMint
apps/server/scripts/mint-satoshi-allocation.ts  one-shot: 1.1M satoshi mint
apps/server/scripts/set-srpow-metadata.ts       one-shot: Metaplex metadata account

packages/solana-bridge/src/bridge-client.ts     SolanaBridgeClient + FakeBridgeClient
packages/solana-bridge/src/wallet-verify.ts     verifyPhantomSignature (ed25519)
packages/solana-bridge/src/constants.ts         SRPOW_DECIMALS=9, base-units constant

apps/web/src/pages/WrapPage.tsx                 page (gated on me.wrap_allowed)
apps/web/src/components/{ConnectPhantom,WrapForm,WrapHistory}.tsx
apps/web/src/hooks/{usePhantom,useSrpow}.ts
```

## Token model

| Property | Value |
|---|---|
| Name | `rpow2 SRPOW` |
| Symbol | `SRPOW` |
| Mint program | SPL Token |
| Decimals | 9 (10⁹ base units = 1 SRPOW = 1 RPOW) |
| Mint authority | Bridge keypair (operator-held; loaded at boot from `BRIDGE_KEYPAIR_BASE58`) |
| Freeze authority | **null** — renounced. Operator cannot freeze SRPOW. Credibility anchor. |
| Metadata | Metaplex `mpl-token-metadata` account, `isMutable: true`. URI points at an Arweave JSON pointing at an Arweave logo PNG. |

The bridge keypair is the single Solana-side trust root. It is the mint
authority, the tx fee payer, and the satoshi-allocation payer. Operator
guidance is to store it in a password manager and rotate only via a
fully-coordinated migration.

## Bootstrap (one-time, by the operator)

Sequence (see [`docs/RUNBOOK.md`](../RUNBOOK.md) §SRPOW + halving rollout):

1. `npm run create-srpow-mint --workspace @rpow/server -- --init-keys`
   → prints `BRIDGE_PUBKEY` and `BRIDGE_KEYPAIR_BASE58`.
2. Operator funds `BRIDGE_PUBKEY` with ~0.05 SOL from a personal wallet.
3. `npm run create-srpow-mint --workspace @rpow/server` (with
   `BRIDGE_KEYPAIR_BASE58` + `SOLANA_RPC_URL` in env) creates the SPL mint
   with `decimals=9`, `freezeAuthority=null`. Prints `SRPOW_MINT_ADDRESS`.
4. `npm run mint-satoshi-allocation --workspace @rpow/server` mints
   1,100,000 SRPOW to the founder wallet (`SATOSHI_RECIPIENT_PUBKEY`),
   refusing to run if on-chain supply is already non-zero.
5. Operator creates a 1-year linear-vesting Streamflow stream of the 1.1M
   tokens. (Manual step, not scripted; the Streamflow SDK is not imported.)
6. Operator uploads `apps/web/public/srpow-logo.png` to Arweave (e.g. via
   `irys` paid by the bridge keypair), then uploads a derived JSON file
   pointing at the image, then runs `npm run set-srpow-metadata` to attach
   that JSON URL to the mint via Metaplex.
7. The VPS env file gets `SOLANA_RPC_URL`, `SRPOW_MINT_ADDRESS`,
   `BRIDGE_KEYPAIR_BASE58`, `WRAP_ALLOWED_EMAILS=…`, and
   `MINT_MAX_SUPPLY=19900000` (= 21M − 1.1M satoshi).

After this, all `/srpow/wrap` minting is mechanical and bound to that
single keypair.

## Phantom binding (per user, one-time)

```
client                           server                       Phantom
  │  POST /phantom/challenge          │                         │
  │ ────────────────────────────────► │                         │
  │ ◄── { nonce: <uuid>,              │                         │
  │       message: "rpow2.com bind: <nonce>",                   │
  │       expires_at }                                          │
  │  user clicks Connect Phantom                                │
  │  window.solana.connect()  ───────────────────────────────► │
  │ ◄── { publicKey: <base58> }                                │
  │  signMessage(message)  ──────────────────────────────────► │
  │ ◄── { signature: <bytes> }                                 │
  │  POST /phantom/bind               │                         │
  │  { nonce, wallet_address,         │                         │
  │    signature_base58 }             │                         │
  │ ────────────────────────────────► │                         │
  │                                   │  SELECT … FOR UPDATE,    │
  │                                   │  expires/used checks,    │
  │                                   │  verifyPhantomSignature  │
  │                                   │  (nacl ed25519 over UTF-8)│
  │                                   │  idempotent re-bind of    │
  │                                   │  same wallet → no-op OK   │
  │                                   │  UPDATE users SET         │
  │                                   │    solana_wallet=$wallet  │
  │                                   │  UPDATE phantom_challenges│
  │                                   │    SET used_at=now()      │
  │ ◄────  { ok: true, solana_wallet }                          │
```

- Nonce TTL: 5 minutes. Single-use (`used_at`).
- The signed message is *literally* `rpow2.com bind: ${nonce}` — UTF-8
  bytes, no envelope. Phantom's `signMessage` returns a 64-byte ed25519
  signature, base58-encoded by the SPA via `bs58`.
- Server verifies via `nacl.sign.detached.verify(msgBytes, sig, pub)`
  (see [`wallet-verify.ts`](../../packages/solana-bridge/src/wallet-verify.ts)).
  Returns `false` for any failure — wrong sig, malformed base58, wrong
  byte lengths.
- `users.solana_wallet` is `UNIQUE`, so a second user trying to bind the
  same wallet gets a 400 `WALLET_TAKEN`.
- Re-binding the **same** wallet by the same user is idempotent (no DB
  change, returns success). Re-binding a *different* wallet is not
  supported in v1; would require manual DB intervention.

## Wrap flow (`POST /srpow/wrap`)

The wrap is a **synchronous** two-phase commit. The HTTP request blocks
until Solana confirms or the bridge times out and refunds.

### Phase 1 — DB lock (single tx)

```
BEGIN
  -- idempotency: row exists with same key?
  --   same params → return existing event (replay)
  --   different params → 409 BAD_REQUEST
  -- 'NO_WALLET_BOUND' if users.solana_wallet IS NULL
  pg_advisory_xact_lock(hashtext('rpow_srpow_wrap'), hashtext(email))   -- per-user serializer
  -- pull tokens FOR UPDATE SKIP LOCKED, ORDER BY value DESC, id ASC
  -- greedy exact-sum: walk largest-first, skip rows that would overshoot
  IF total != target → 'INSUFFICIENT_BALANCE' or 'EXACT_SUM_REQUIRED'
  INSERT srpow_wrap_events(
    id, user_email, solana_wallet, amount, direction='WRAP',
    status='PENDING', idempotency_key
  )
  UPDATE tokens
     SET state='LOCKED_FOR_BRIDGE', wrap_event_id=$event_id
   WHERE id = ANY(picked_ids)
COMMIT
```

After Phase 1 the user's rpow balance has gone down by `target` (the locked
rows aren't `VALID` anymore). If anything goes wrong from here on, Phase 2
either succeeds (rows go to `WRAPPED`) or refunds (rows go back to `VALID`).

### Phase 2 — Solana mintTo (outside DB tx, ≤60s)

Inside `SolanaBridgeClient.mintTo`:

1. Look up the recipient's Associated Token Account (ATA) for the SRPOW
   mint. If it doesn't exist, prepend a `createAssociatedTokenAccount`
   instruction (paid by the bridge).
2. Add a `createMintToInstruction(mint, ata, mintAuthority=bridge,
   amount=amountBaseUnits)`.
3. Fetch a recent blockhash, sign the tx locally with the bridge keypair.
   Compute the ed25519 signature deterministically from the signed
   message.
4. Call `onSignaturePrepared(signature)` — the route handler uses this
   callback to `UPDATE srpow_wrap_events SET solana_signature=$sig` **before
   the raw tx is submitted to the cluster**. This is the crash-recovery
   anchor: even if the server dies between submit and confirm, the
   reconcile worker has the signature on hand.
5. `connection.sendRawTransaction(tx.serialize())`.
6. `connection.confirmTransaction({signature, blockhash, lastValidBlockHeight}, commitment)`,
   raced against a `setTimeout` reject for `SRPOW_WRAP_TIMEOUT_MS` (60s
   default). On timeout, the route returns a structured failure with the
   signature still populated — the next reconcile pass can resolve the
   real on-chain outcome.

Back in [`routes/srpow.ts`](../../apps/server/src/routes/srpow.ts):

- **Success path** (`{status:'confirmed', signature}`):
  ```sql
  BEGIN
    UPDATE srpow_wrap_events SET status='CONFIRMED', solana_signature=$sig
     WHERE id=$event_id;
    UPDATE tokens SET state='WRAPPED' WHERE id = ANY($ids);
  COMMIT
  ```
  Returns 200 `{ ok: true, event_id, status: 'CONFIRMED', solana_signature }`.

- **Failure path** (any non-confirmed result):
  ```sql
  BEGIN
    UPDATE srpow_wrap_events SET status='REFUNDED', failure_reason=$reason
     WHERE id=$event_id;
    UPDATE tokens SET state='VALID', wrap_event_id=NULL WHERE id = ANY($ids);
  COMMIT
  ```
  Returns 503 `{ error: 'BRIDGE_FAILED', event_id, status: 'REFUNDED', failure_reason }`.
  The signature is intentionally **not** nulled out — preserving it lets
  the user click through to Solscan and gives the reconciler a stable
  artifact for any future audit.

## Crash recovery: `reconcilePendingWraps`

Runs once at server boot, after migrations and before `app.listen`. See
[`srpow-reconcile.ts`](../../apps/server/src/srpow-reconcile.ts).

```
SELECT id, solana_signature
FROM srpow_wrap_events
WHERE status='PENDING';

For each row:
  if solana_signature IS NULL:
    -- tx never submitted before crash — safe to refund
    REFUND with reason='reconcile: no signature recorded'

  else:
    status = bridge.getSignatureStatus(signature)
    case status:
      'confirmed' → CONFIRM (UPDATE event + UPDATE tokens → WRAPPED)
      'pending'   → leave PENDING; next reboot will retry
      'failed' | 'not_found' → REFUND with reason='reconcile: signature <status>'
```

The `'pending'` vs `'not_found'` distinction is load-bearing: `pending`
means "Solana has the tx but it hasn't reached our commitment threshold
yet" (so refunding could double-resolve into a confirmed mint), while
`not_found` after the wrap timeout has elapsed means "the tx isn't on chain
and won't be" — safe to refund. `getSignatureStatus` queries with
`searchTransactionHistory: true` so older confirmed signatures aren't
mis-resolved as `not_found`.

## Allowlist gating

`/srpow/wrap` rejects with 403 `FORBIDDEN` if `me.email` is not in
`WRAP_ALLOWED_EMAILS` (parsed at boot in
[`wrap-allowlist.ts`](../../apps/server/src/wrap-allowlist.ts)). The
frontend hides the `[ wrap ]` nav link unless `/me` returns
`wrap_allowed: true`, but server-side gating is the actual guard.

The pilot allowlist initially contained one email
(`frk314@gmail.com`); broadening is an operational decision documented in
the runbook.

## Read endpoints

- `GET /srpow/events` — list of the logged-in user's wrap events, newest
  first, capped at 100.
- `GET /srpow/events/:id` — single event, owner-scoped (404 if it's
  another user's event).

Both serve the wire shape declared in
[`packages/shared/src/protocol.ts`](../../packages/shared/src/protocol.ts):

```ts
interface WrapEvent {
  event_id: string;
  direction: 'WRAP' | 'UNWRAP';     // UNWRAP reserved for future work
  amount_base_units: string;        // stringified bigint
  status: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REFUNDED';
  solana_signature: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}
```

## Frontend integration

`/wrap` is a HashRouter route (`/#/wrap`). It composes three panels:

1. **Bind** — `<ConnectPhantom>` shows the bound wallet abbreviated, or a
   Connect button if not yet bound. The button drives the
   challenge/signMessage/bind handshake via `usePhantom` +
   `api.phantomChallenge` + `api.phantomBind`.
2. **Wrap** — `<WrapForm>` — decimal RPOW input parsed with
   `parseRpowToBaseUnits` (9-decimal max), generates a client-side UUID
   `idempotency_key`, and POSTs `/srpow/wrap`. Disabled until a wallet is
   bound. On success it flashes a confirmation including the truncated
   tx signature.
3. **History** — `<WrapHistory>` — renders `/srpow/events` rows; the
   `CONFIRMED` rows link to `https://solscan.io/tx/<sig>`.

`useSrpow` is a thin hook around `api.srpowEvents()` and `api.srpowWrap()`.

## What is **not** in v1

- **Unwrap.** Burning SRPOW on Solana to flip a `WRAPPED` rpow row back to
  `VALID`. Not implemented — only the data-model field (`direction='UNWRAP'`)
  is reserved.
- **Multi-wallet rebinding.** A user can only bind once; changing wallets
  requires manual DB intervention.
- **Background bridge worker.** Recovery is one-shot at boot. No retry loop
  for transient RPC failures.
- **Bridge SOL alarm.** No automated check that the bridge has enough SOL
  for upcoming wrap fees. Documented as future work.
- **Periodic supply reconciliation alarm.** SRPOW Solana supply should
  equal `1,100,000 + R_wrapped`. No automated divergence check yet — the
  primary trust signal that the bridge keypair hasn't been compromised.

## Operator-side risk surface

- **Bridge keypair compromise.** Worst case, an attacker can mint
  unbacked SRPOW. Detection (when the alarm exists) is `SRPOW supply >
  expected`. Mitigation: keypair lives in `/etc/rpow/server.env`, mode
  0640, owner `root:rpow`. Same blast radius as the database itself.
- **VPS loss.** rpow ledger restores from the nightly restic backup;
  SRPOW on Solana is independent and survives a VPS-side incident on its
  own. The 1:1 invariant can drift if the rpow ledger is restored to a
  state that disagrees with on-chain SRPOW — a manual reconciliation
  script (not yet written) would be needed in that scenario.
