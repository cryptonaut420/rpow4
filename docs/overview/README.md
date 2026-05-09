# rpow4 — System Documentation

> A modern tribute to Hal Finney's [Reusable Proofs of Work (RPOW, 2004)](https://nakamotoinstitute.org/finney/rpow/).
> Bitcoin-flavored: 50 RPOW initial reward, halving every 210,000 blocks, hard 21,000,000 cap, no founder allocation.

This folder is a top-down tour of the rpow4 codebase. It complements the
operator-facing [`docs/RUNBOOK.md`](../RUNBOOK.md) and the historical
design specs in [`docs/superpowers/specs/`](../superpowers/specs).

## What rpow4 is

A faithful, deliberately centralized re-creation of Finney's RPOW protocol,
modernized:

- **Identity** is a base58-encoded Ed25519 public key derived in the
  browser from a BIP-39 mnemonic (SLIP-0010 path `m/44'/501'/0'/0'`). The
  server never sees the private key, the mnemonic, or any email — auth
  is a stateless challenge → signed envelope → cookie handshake.
- **Per-action signatures.** Every state-changing call (`/auth/session`,
  `/mint`, `/send`) is signed by the user's keypair over
  a domain-separated, sorted-key canonical message and the signature is
  persisted alongside the resulting ledger row.
- **Mining** is hashcash on `SHA-256(nonce_prefix ‖ solution_nonce_LE)`,
  targeting a configurable number of trailing zero bits. The schedule
  starts at 24 bits and steps up +1 every 164,062 blocks (≈ 21M / 128),
  capped at 50 bits so it stays mineable on commodity hardware forever.
- **Balances** live in compact Postgres `account_balances` rows. Accepted
  proofs and transfers append `ledger_events` for auditability, while hot
  reads never scan per-coin history.
- **Transfers** debit and credit account balances directly. The sender names
  the recipient by their RPOW pubkey (no email, no claim links).
- **Issuance** is Bitcoin-style block-based halving. 1 accepted proof =
  1 "block". Reward starts at **50 RPOW**, halves every **210,000
  blocks**, geometric sum closes at exactly **21,000,000 RPOW**. **No
  founder allocation, no premine, no operator-held wallet.**

## Reading order

| # | Doc | What it covers |
|---|---|---|
| 1 | [`01-architecture.md`](./01-architecture.md) | Topology, services, deploy targets, repo layout |
| 2 | [`02-protocol.md`](./02-protocol.md) | End-to-end flows: wallet → challenge → mine → mint → send |
| 3 | [`03-mining-and-halving.md`](./03-mining-and-halving.md) | PoW spec, difficulty curve, halving schedule, 21M cap, base units |
| 4 | [`04-data-model.md`](./04-data-model.md) | Postgres schema (post 011_pubkey_identity), state machines, key invariants |
| 5 | [`06-api.md`](./06-api.md) | HTTP endpoint reference |
| 6 | [`07-ops-and-deploy.md`](./07-ops-and-deploy.md) | Hosting, secrets, backups, recovery (pointer-heavy) |

## One-screen mental model

```
                                    ┌────────────────────────────┐
                                    │   apps/web (Netlify)       │
                                    │   React + Vite SPA         │
                                    │   miner.worker.ts          │
                                    │   WalletProvider:          │
                                    │     BIP-39 mnemonic        │
                                    │     SLIP-0010 Ed25519      │
                                    │     PBKDF2+AES-GCM in IDB  │
                                    └────────────┬───────────────┘
                                                 │ HTTPS, cookie auth
                                                 │ + Ed25519 sig per action
                                                 ▼
            ┌─────────────────────────────────────────────────────────────┐
            │  api.rpow4.com  (OVH VPS, nginx → :8080)                    │
            │                                                              │
            │  apps/server  (Fastify, Node 22, TypeScript)                 │
            │  ├─ /auth/{challenge,session,logout}  pubkey handshake       │
            │  ├─ /challenge, /mint                 stateless hashcash     │
            │  ├─ /send                             signed balance move    │
            │  ├─ /me, /activity, /ledger           views                  │
            │  └─ /.well-known/rpow-pubkey.pem      token-issuer key       │
            │                                                              │
            │  Postgres 17 (Unix-socket only)                              │
            └────────────┬───────────────────────────────┬─────────────────┘
                         │                               │
                         │ maintained balances + append-only events
                         ▼
                ┌────────────────────────────────────────┐
                │  Postgres ledger                       │
                │  account_balances, ledger_events,      │
                │  ledger_stats, app_counters            │
                │  (minted_supply + block_height)        │
                └────────────────────────────────────────┘
```

## Key source-of-truth files

- Server entry: [`apps/server/src/server.ts`](../../apps/server/src/server.ts)
- App wiring: [`apps/server/src/buildApp.ts`](../../apps/server/src/buildApp.ts)
- PoW verifier: [`apps/server/src/pow.ts`](../../apps/server/src/pow.ts)
- Issuance schedule (block-based halving + difficulty ramp): [`apps/server/src/schedule.ts`](../../apps/server/src/schedule.ts)
- Token signing (server): [`apps/server/src/signing.ts`](../../apps/server/src/signing.ts)
- Session HMAC: [`apps/server/src/session.ts`](../../apps/server/src/session.ts)
- Migrations: [`apps/server/migrations/`](../../apps/server/migrations)
- Routes: [`apps/server/src/routes/`](../../apps/server/src/routes)
- Wallet (client): [`apps/web/src/wallet/WalletProvider.tsx`](../../apps/web/src/wallet/WalletProvider.tsx)
- Web miner: [`apps/web/src/miner.worker.ts`](../../apps/web/src/miner.worker.ts)
- Wire types: [`packages/shared/src/protocol.ts`](../../packages/shared/src/protocol.ts)
- Canonical JSON + sign/verify: [`packages/shared/src/canonical.ts`](../../packages/shared/src/canonical.ts), [`wallet.ts`](../../packages/shared/src/wallet.ts)

## Design decisions worth knowing up front

- **Centralized by design.** The Postgres ledger is the source of truth; the
  Ed25519-signed token payloads are for third-party verifiability, not
  consensus. This is documented prominently in the About panel and accepted
  as the cost of being a tribute rather than a chain.
- **Block-based halving + difficulty ramp.** RPOW4's schedule is a pure
  function of the global `block_height` counter (incremented atomically
  on every successful `/mint`). 50 RPOW × 210,000 blocks/halving ×
  geometric sum = **21,000,000 RPOW exact**. Difficulty starts at 24
  trailing-zero bits and steps +1 every 164,062 blocks (capped at 50).
  Source of truth: [`schedule.ts`](../../apps/server/src/schedule.ts).
- **No founder allocation.** Every RPOW in circulation was earned by an
  accepted PoW. No premine, no insider mint, no operator wallet.
- **Base units everywhere.** Internal accounting is BIGINT base units where
  10⁹ base units = 1 RPOW. All amount-bearing fields on the wire use the
  `_base_units` suffix.
- **Balance rows, not spendable token rows.** `/send` uses a conditional debit
  against `account_balances`, so arbitrary base-unit amounts work and hot
  paths do not scan a user's historical token set.
- **Self-hosted.** The API runs on a single OVH VPS with Postgres 17 over
  a Unix socket. See [`docs/RUNBOOK.md`](../RUNBOOK.md) and the migration
  spec.
