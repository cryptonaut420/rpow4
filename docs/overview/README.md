# rpow2 — System Documentation

> A modern tribute to Hal Finney's [Reusable Proofs of Work (RPOW, 2004)](https://nakamotoinstitute.org/finney/rpow/).
> Live at **[rpow2.com](https://rpow2.com/#/activity)**, API at `api.rpow2.com`.

This folder is a top-down tour of the rpow2 codebase. It complements the
operator-facing [`docs/RUNBOOK.md`](../RUNBOOK.md) and the canonical design
specs in [`docs/superpowers/specs/`](../superpowers/specs).

## What rpow2 is

A faithful, deliberately centralized re-creation of Finney's RPOW protocol,
modernized:

- **Identity** is a base58-encoded Ed25519 public key derived in the
  browser from a BIP-39 mnemonic (SLIP-0010 path `m/44'/501'/0'/0'`, the
  same Solana derivation path). The server never sees the private key,
  the mnemonic, or any email — auth is a stateless challenge → signed
  envelope → cookie handshake.
- **Per-action signatures.** Every state-changing call (`/auth/session`,
  `/mint`, `/send`) is signed by the user's keypair over
  a domain-separated, sorted-key canonical message and the signature is
  persisted alongside the resulting ledger row.
- **Mining** is hashcash on `SHA-256(nonce_prefix ‖ solution_nonce_LE)`,
  targeting a configurable number of trailing zero bits (currently 24).
  ~30 s for one solution on a modern laptop.
- **Balances** live in compact Postgres `account_balances` rows. Accepted
  proofs and transfers append `ledger_events` for auditability, while hot
  reads never scan per-coin history.
- **Transfers** debit and credit account balances directly. The sender names
  the recipient by their RPOW pubkey (no email, no claim links).
- **Issuance** follows a Bitcoin-style halving curve (no difficulty change,
  reward halves every 1,000,000 RPOW minted) up to a hard cap of
  **21,000,000 RPOW** total supply.

## Reading order

| # | Doc | What it covers |
|---|---|---|
| 1 | [`01-architecture.md`](./01-architecture.md) | Topology, services, deploy targets, repo layout |
| 2 | [`02-protocol.md`](./02-protocol.md) | End-to-end flows: wallet → challenge → mine → mint → send |
| 3 | [`03-mining-and-halving.md`](./03-mining-and-halving.md) | PoW spec, difficulty, halving schedule, 21M cap, base units |
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
            │  api.rpow2.com  (OVH VPS, nginx → :8080)                    │
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
                └────────────────────────────────────────┘
```

## Key source-of-truth files

- Server entry: [`apps/server/src/server.ts`](../../apps/server/src/server.ts)
- App wiring: [`apps/server/src/buildApp.ts`](../../apps/server/src/buildApp.ts)
- PoW verifier: [`apps/server/src/pow.ts`](../../apps/server/src/pow.ts)
- Halving schedule: [`apps/server/src/schedule.ts`](../../apps/server/src/schedule.ts)
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
- **Halving, not difficulty bumps.** The original spec proposed +1 difficulty
  bit per 1,000,000 RPOW. The shipped behavior (since the 008 base-units
  migration) holds difficulty constant at 24 trailing-zero bits and instead
  halves the *reward* every 1M RPOW minted. The Ledger UI copy still
  references "stepped difficulty" in one paragraph — that paragraph is
  outdated; `schedule.ts` is the source of truth.
- **Base units everywhere.** Internal accounting is BIGINT base units where
  10⁹ base units = 1 RPOW. All amount-bearing fields on the wire use the
  `_base_units` suffix.
- **Balance rows, not spendable token rows.** `/send` uses a conditional debit
  against `account_balances`, so arbitrary base-unit amounts work and hot
  paths do not scan a user's historical token set.
- **Self-hosted.** As of 2026-05-08 the API runs on a single OVH VPS with
  Postgres 17 over a Unix socket, after migrating off Fly.io + Neon. See
  [`docs/RUNBOOK.md`](../RUNBOOK.md) and the migration spec.
