# rpow2 — System Documentation

> A modern tribute to Hal Finney's [Reusable Proofs of Work (RPOW, 2004)](https://nakamotoinstitute.org/finney/rpow/).
> Live at **[rpow2.com](https://rpow2.com/#/activity)**, API at `api.rpow2.com`.

This folder is a top-down tour of the rpow2 codebase. It complements the
operator-facing [`docs/RUNBOOK.md`](../RUNBOOK.md) and the canonical design
specs in [`docs/superpowers/specs/`](../superpowers/specs).

## What rpow2 is

A faithful, deliberately centralized re-creation of Finney's RPOW protocol,
modernized:

- **Identity** is an email address. Auth is a 15-minute single-use magic link.
- **Mining** is hashcash on `SHA-256(nonce_prefix ‖ solution_nonce_LE)`,
  targeting a configurable number of trailing zero bits (currently 24).
  ~30 s for one solution on a modern laptop.
- **Tokens** are rows in a Postgres ledger, signed by a server-side Ed25519
  key. The public key is published at `/.well-known/rpow-pubkey.pem`.
- **Transfers** invalidate the sender's tokens and reissue fresh ones to the
  recipient — Finney's "reissuance" pattern. Sends to non-users mint a
  one-time email-claim link.
- **Issuance** follows a Bitcoin-style halving curve (no difficulty change,
  reward halves every 1,000,000 RPOW minted) up to a hard cap of **21,000,000
  RPOW** total supply.
- **SRPOW** is an optional Solana SPL token (9 decimals) that allowlisted
  users can wrap into. Each wrapped rpow row locks 1:1 against on-chain
  SRPOW so the combined rpow + SRPOW supply never exceeds 21M.

## Reading order

| # | Doc | What it covers |
|---|---|---|
| 1 | [`01-architecture.md`](./01-architecture.md) | Topology, services, deploy targets, repo layout |
| 2 | [`02-protocol.md`](./02-protocol.md) | End-to-end flows: auth → mine → mint → send → claim |
| 3 | [`03-mining-and-halving.md`](./03-mining-and-halving.md) | PoW spec, difficulty, halving schedule, 21M cap, base units |
| 4 | [`04-data-model.md`](./04-data-model.md) | Postgres schema, state machines, key invariants |
| 5 | [`05-srpow-bridge.md`](./05-srpow-bridge.md) | Phantom binding, wrap flow, reconcile worker, bridge keypair |
| 6 | [`06-api.md`](./06-api.md) | HTTP endpoint reference |
| 7 | [`07-ops-and-deploy.md`](./07-ops-and-deploy.md) | Hosting, secrets, backups, recovery (pointer-heavy) |

## One-screen mental model

```
                                    ┌────────────────────────┐
                                    │   apps/web (Netlify)   │
                                    │   React + Vite SPA     │
                                    │   miner.worker.ts      │
                                    └───────────┬────────────┘
                                                │ HTTPS, cookie auth
                                                ▼
            ┌─────────────────────────────────────────────────────────────┐
            │  api.rpow2.com  (OVH VPS, nginx → :8080)                    │
            │                                                              │
            │  apps/server  (Fastify, Node 22, TypeScript)                 │
            │  ├─ /auth/{request,verify,logout}     magic-link auth        │
            │  ├─ /challenge, /mint                 hashcash + halving     │
            │  ├─ /send, /claim                     reissuance + email     │
            │  ├─ /me, /activity, /ledger           views                  │
            │  ├─ /phantom/{challenge,bind}         Solana wallet binding  │
            │  ├─ /srpow/{wrap,events,events/:id}   wrap to SPL token      │
            │  └─ /unsubscribe, /.well-known/...    misc                   │
            │                                                              │
            │  Postgres 17 (Unix-socket only)  │  Resend / Postmark / SMTP │
            └────────────┬───────────────────────────────┬─────────────────┘
                         │                               │
                         │ ed25519-signed                │ Solana mainnet
                         │ mintTo (SPL)                  │ getSignatureStatus
                         ▼                               ▼
                ┌────────────────────┐         ┌────────────────────┐
                │  SRPOW SPL mint     │         │  Phantom (user)    │
                │  decimals=9         │         │  signs bind nonce  │
                │  freeze auth=null   │         │  custodies SRPOW   │
                │  mint auth=bridge   │         └────────────────────┘
                └────────────────────┘
```

## Key source-of-truth files

- Server entry: [`apps/server/src/server.ts`](../../apps/server/src/server.ts)
- App wiring: [`apps/server/src/buildApp.ts`](../../apps/server/src/buildApp.ts)
- PoW verifier: [`apps/server/src/pow.ts`](../../apps/server/src/pow.ts)
- Halving schedule: [`apps/server/src/schedule.ts`](../../apps/server/src/schedule.ts)
- Token signing: [`apps/server/src/signing.ts`](../../apps/server/src/signing.ts)
- Migrations: [`apps/server/migrations/`](../../apps/server/migrations)
- Routes: [`apps/server/src/routes/`](../../apps/server/src/routes)
- Bridge client: [`packages/solana-bridge/src/bridge-client.ts`](../../packages/solana-bridge/src/bridge-client.ts)
- Web miner: [`apps/web/src/miner.worker.ts`](../../apps/web/src/miner.worker.ts)
- Wire types: [`packages/shared/src/protocol.ts`](../../packages/shared/src/protocol.ts)

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
  10⁹ base units = 1 RPOW (matching SRPOW's 9 decimals). All amount-bearing
  fields on the wire use the `_base_units` suffix.
- **Exact-sum spend.** Tokens are not splittable. `/send` and `/srpow/wrap`
  greedy-pick existing token rows whose values sum *exactly* to the target;
  if no exact-sum subset exists the request errors with `EXACT_SUM_REQUIRED`.
- **Synchronous wrap.** `/srpow/wrap` blocks until Solana confirms (or times
  out and refunds). No background workers. Crash recovery is a one-shot
  reconcile pass at server boot.
- **Self-hosted.** As of 2026-05-08 the API runs on a single OVH VPS with
  Postgres 17 over a Unix socket, after migrating off Fly.io + Neon. See
  [`docs/RUNBOOK.md`](../RUNBOOK.md) and the migration spec.
