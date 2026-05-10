# rpow3 vs ours — efficiency audit

Reference fork: `/var/www/labs/rpow/rpow3` (a sibling fork of the same upstream).
Audit date: 2026-05-09.

The rpow3 author claims their fork "fixed a lot of the issues by running parallel
minting" — replacing a hot-row UPDATE counter with a Postgres SEQUENCE so concurrent
mints don't serialize behind a single tuple lock. This document captures everything
we found when diffing the two trees, sorted by whether it's portable to ours.

---

## TL;DR

Two things worth porting:

1. **`idle_in_transaction_session_timeout = 10s`** in the DB pool config. Drop-in
   one-liner. Postgres-side safeguard against zombie transactions holding locks
   when the app crashes mid-tx.
2. **Sequence-based mint counter** (the rpow3 headline). Not a drop-in — our schedule
   is more complex (halving reward + block-height-driven difficulty) — but the *idea*
   eliminates the global advisory lock + dual-counter UPDATE on the mint hot path.
   Needs a small refactor and a migration.

Everything else rpow3 changed is either:
- already done in our fork (signup IPs, transfer indexes, transactional retry, compression),
- inferior to what we have (smaller pool, simpler caching, magic-link auth model),
- or dead code in rpow3 itself (the `request_metrics` table — their own comment
  admits it's misleading and unread).

---

## Schema-level diff (migrations)

| rpow3 file                          | ours                       | Notes |
| ----------------------------------- | -------------------------- | --- |
| `001_init.sql`                      | `001_init.sql`             | Identical baseline. |
| `002_magic_link_ip.sql`             | `002_magic_link_ip.sql`    | Identical. |
| `003_magic_link_token_hash_idx.sql` | `003_magic_link_token_hash_idx.sql` | Identical. |
| `004_pending_transfers.sql`         | `004_pending_transfers.sql` | Identical. |
| `005_minted_supply_counter.sql`     | `005_minted_supply_counter.sql` | Identical — both forks added the maintained counter row to replace `count(*) FROM tokens`. |
| `006_user_signup_ips.sql`           | covered by our `002`       | rpow3 adds signup IPs as a separate migration; we already capture this in `002_magic_link_ip.sql`. **Already done.** |
| `007_transfer_indexes.sql`          | covered by our `011_pubkey_identity.sql` | rpow3 adds `transfers_sender_*` / `transfers_recipient_*` indexes. We already created equivalents during the pubkey identity refactor. **Already done.** |
| `008_minted_supply_sequence.sql`    | **(no analog)**            | **The headline rpow3 change.** Replaces the `app_counters.minted_supply` row with a Postgres SEQUENCE so `nextval()` is contention-free. See "Hot path: /mint" below. |
| `009_request_metrics.sql`           | **(no analog)**            | rpow3 added a `request_metrics` table (per-endpoint, per-IP-/16, per-client UA counts). **Dead in rpow3** — their own `routes/stats.ts:14-22` says the counters were yanked because at viral traffic levels they take days to converge and looked misleading. Schema is left unread. **Skip.** |
| `010_tokens_valid_partial_index.sql`| **(no analog needed)**     | rpow3 added `CREATE INDEX … ON tokens(owner_email) WHERE state='VALID'` to make /stats's `count(*)` and leaderboard `GROUP BY` cheap. Not applicable to us — migrations `013_scalable_ledger.sql` and `015_billion_row_ledger.sql` removed the `tokens` table. Our /stats reads `account_balances` with indexes from `018_stats_counters.sql` and `019_blocks_mined_per_account.sql`. **Already better.** |
| (none past 010)                     | `006`–`024` (ours)         | Our fork diverges heavily after their 010: email unsubscribes, srpow wrap, base units, scalable ledger, pubkey identity, display name, billion-row ledger, perf cleanups, block-height counter, stats counters, blocks-mined-per-account, send fees, faucet claims, trollbox, claim tokens, send-fee waiver. None of this is in rpow3. |

---

## Hot path: `/mint`

### rpow3 (`apps/server/src/routes/mint.ts`)

```sql
-- No advisory lock. Cap enforcement is one atomic op:
SELECT nextval('minted_supply_seq')::text AS v;
-- if v > cap → SUPPLY_EXHAUSTED (slot is "burned" but harmless)
```

- Single round-trip cap check. `nextval` uses Postgres's separate in-memory
  sequence lock manager, doesn't dirty data pages, and doesn't participate in MVCC.
  Concurrent callers never block each other.
- Mints `tokens(...)` row directly — they're still on the per-token model.
- Migration 008's commit message is gold; read it for the full failure mode rationale
  (statement timeouts, WAL bloat, 80–170s checkpoints under viral load).

### Ours (`apps/server/src/routes/mint.ts:82-138`)

```ts
// Global serialization point — every mint queues here:
await c.query(`SELECT pg_advisory_xact_lock(hashtext('rpow_mint_supply'))`);

// Read both counters:
const { rows } = await c.query(`SELECT name, value::text FROM app_counters
                                WHERE name IN ('minted_supply','block_height')`);

// Compute reward from block_height (halving), validate difficulty, then:
const supplyResult = await c.query(`
  UPDATE app_counters SET value = value + (CASE
    WHEN name='minted_supply' THEN $1::bigint ELSE 1::bigint END)
  WHERE name IN ('minted_supply','block_height')
    AND (SELECT value FROM app_counters WHERE name='minted_supply') + $1::bigint <= $2::bigint
`, [reward, capBaseUnits]);
```

Two serialization mechanisms layered on top of each other:
- **Advisory lock**: explicit FIFO across all concurrent mints.
- **Row-level UPDATE on the same two rows**: implicit serialization even
  if the advisory lock were removed.

### Why we can't just drop in rpow3's solution

`nextval` returns a uniform `+1` increment. We need:

- `block_height` — must advance exactly once per accepted mint (drives halving and
  difficulty in `schedule.ts`).
- `minted_supply` (in **base units**) — varies per block because of halving
  (50 RPOW → 25 → 12.5 → …).

A single sequence can model `block_height`, but not a halving-aware base-unit
counter.

### Sketch of a portable adaptation

1. Add `block_height_seq` (sequence), seed from current `app_counters.block_height`
   value, drop the row.
2. In `/mint`, replace the advisory lock + UPDATE block with `nextval('block_height_seq')`.
   That value *is* the block height for this mint.
3. Compute `reward = currentRewardForBlock(blockHeight)`. Cap is self-enforced:
   `schedule.ts:111` floors reward to 0 when supply is exhausted, so the 21M cap
   check becomes "reward > 0" — pure function of block height, no row update.
4. `minted_supply` no longer needs to live on the hot path. If we want a
   running total for `/stats`, derive it from `ledger_stats.circulating_supply`
   (we already update that in the same tx) or compute on demand.
5. Per-account advisory locks (`'rpow_account_balance' + pubkey-hash`) stay —
   those distribute across users, only serialize one user's own ops.

Trade-off (same as rpow3 acknowledges): an aborted mint tx burns a `block_height`
slot. Across 21M blocks, with rare aborts, this is invisible.

---

## Connection pool / `db.ts`

| Setting                               | rpow3                                | ours                                 |
| ------------------------------------- | ------------------------------------ | ------------------------------------ |
| `max`                                 | `process.env.DB_POOL_MAX ?? 15`      | `30` (configurable via opts)         |
| `statement_timeout`                   | `5_000`                              | `5_000` (configurable)               |
| `connectionTimeoutMillis`             | `5_000`                              | `2_000`                              |
| `idleTimeoutMillis`                   | `30_000`                             | `30_000`                             |
| **`idle_in_transaction_session_timeout`** | **`10_000`**                     | **(not set)**                        |
| `withTxRetry` w/ exponential backoff  | (none — bare `withTx`)               | **yes** (`db.ts:92`, retries 40001/40P01) |
| Pool error listener                   | (default)                            | `attachPoolErrorLogger()` for structured logs |

**Action item:** add `idle_in_transaction_session_timeout: 10_000` to our
`createPool()` Pool constructor at `apps/server/src/db.ts:25`. Postgres-side
guardrail — if the app crashes or hangs while holding a transaction open, the
session is closed and locks released after 10s rather than rotting forever.
Directly addresses the "unexpected EOF on client connection with an open
transaction" log spam pattern.

Other defaults: ours are better. `max=30` vs rpow3's `15` (rpow3 is constrained
by hobby-tier `max_connections`; ours can afford more headroom). `connectionTimeoutMillis=2_000`
vs rpow3's `5_000` — fail-fast is preferable. We have `withTxRetry` for serialization
failures and deadlocks; rpow3 doesn't.

---

## Hot path: `/stats`

### rpow3 (`apps/server/src/routes/stats.ts`)

- 6 parallel queries against the `tokens` table (count, sum, group-by-owner, etc.).
- 60s cache + in-flight Promise coalescing.
- Heaviest query is `GROUP BY owner_email` over millions of token rows; mitigated
  by migration 010's partial index.

### Ours (`apps/server/src/routes/stats.ts`)

- Reads from `account_balances` (one row per pubkey) and pre-aggregated
  `ledger_stats` counters.
- Per-account leaderboard already comes pre-sorted via the index from
  `019_blocks_mined_per_account.sql`.
- Significantly less work per cache miss.

**No port needed.** Our ledger refactor obsoletes the rpow3 stats path entirely.

---

## Other routes

### `/challenge`
- **rpow3**: persists each challenge to a `challenges` table (`INSERT … RETURNING`),
  caches `mintedSupply` count for 5s.
- **Ours**: stateless MAC'd envelope (no DB write per challenge). **Already better.**

### `/auth`
- **rpow3**: email + magic-link flow; per-email + per-IP rate limits via DB lookups
  on every login attempt; `INSERT INTO magic_links` per request.
- **Ours**: pubkey-based auth (sign challenge with private key). No magic-link table,
  no per-login DB writes on the happy path. **Different paradigms — not portable, ours has fewer round-trips.**

### `/send`
- **rpow3**: advisory locks on sender + recipient (consistent order to avoid deadlock);
  freezes sender tokens, mints fresh ones for recipient; per-token records.
- **Ours**: same lock pattern; `account_balances` upsert; `ledger_events` row inserted
  via single CTE round-trip; idempotency via `ledger_transfer_idempotency`; halving-aware
  fee. **Schema-incompatible with rpow3; ours scales for billion-row ledger.**

### `/claim`
- **rpow3**: simple `FOR UPDATE` lookup, credit recipient, mark redeemed.
- **Ours**: redeem + cancel flows, dual-balance lock pattern, supports claim-tokens
  feature added in `023_claim_tokens.sql`. **More featureful; nothing to port.**

### `/me`, `/activity`, `/ledger`
- **rpow3**: queries the `transfers` table — fixed under load by migration 007's
  indexes.
- **Ours**: single-row `account_balances` lookup, `ledger_events` reads via the
  hot-ledger mirror (`ledger-hot.ts`). **Already faster.**

---

## Server / middleware (`buildApp.ts`, `server.ts`)

| Concern                       | rpow3                              | ours                                |
| ----------------------------- | ---------------------------------- | ----------------------------------- |
| Request logging               | `disableRequestLogging: true`      | configurable                        |
| `trustProxy`                  | hardcoded `true`                   | configurable via env                |
| `@fastify/compress`           | not present                        | **present**                         |
| Cache layer                   | minimal in-process state + Promise coalescing | `TtlCache` with explicit per-key invalidation (`app.invalidateAccount(pubkey)`, `app.invalidateLedger()`) |
| Number of routes              | ~9                                 | 16+ (faucet, trollbox, explorer, signup, account, etc.) |

`disableRequestLogging` is a deployment-cost trade-off (Railway log ingest cap),
not a perf win — skip unless we're hitting log limits.

Nothing else here is portable; ours is broader and more sophisticated.

---

## Crypto / signing / session (`pow.ts`, `signing.ts`, `session.ts`)

Both forks use Ed25519 over `@noble/*` libraries via `@rpow/shared`. Same canonical
message layout, same session signing strategy. **No algorithmic differences.**

---

## Schedule / issuance (`schedule.ts`)

- **rpow3**: simple linear schedule, no halving, difficulty derived from
  current minted supply.
- **Ours**: Bitcoin-exact halving at 210k blocks, 50 RPOW base reward,
  difficulty steps every 50k blocks (start 24, max 50), 21M cap. Block-height
  driven (migration 017).

**Theirs is a strict subset of ours.** This is the *reason* a sequence isn't
a drop-in replacement for our mint counter — see the adaptation sketch above.

---

## Misc (`magic.ts`, `mailer.ts`)

rpow3-only files supporting their email/magic-link auth. We don't have
analogs because we don't have that auth model. Not applicable.

---

## Action items — when we revisit

| # | Item                                                      | Effort  | Risk    | Win |
| - | --------------------------------------------------------- | ------- | ------- | --- |
| 1 | Add `idle_in_transaction_session_timeout: 10_000` to `apps/server/src/db.ts:25` | 1 line  | Low     | Reliability — lock release on app crash |
| 2 | Replace global mint advisory lock + counter UPDATE with `block_height_seq` `nextval()` (see "Sketch of a portable adaptation" above). New migration + ~30 lines of `mint.ts` change. | Medium  | Medium  | Throughput — eliminates the only global serialization point on the mint path |

Items NOT to port (call this out so future-us doesn't relitigate):

- `request_metrics` table — rpow3 itself yanked it as misleading.
- Partial index on `tokens(owner_email)` — we no longer have a `tokens` table.
- Lower pool max (15) — we're not on a hobby-tier Postgres.
- Magic-link auth — we use pubkey signatures.
- rpow3's per-token send model — we use aggregated `account_balances` + a
  ledger-event log, which scales further.

---

## Files cross-referenced

rpow3:
- `apps/server/migrations/008_minted_supply_sequence.sql`
- `apps/server/migrations/010_tokens_valid_partial_index.sql`
- `apps/server/src/db.ts:8-44`
- `apps/server/src/routes/mint.ts`
- `apps/server/src/routes/stats.ts:14-22` (the request_metrics dead-code admission)

ours:
- `apps/server/src/db.ts:15-31` (pool config — missing `idle_in_transaction_session_timeout`)
- `apps/server/src/routes/mint.ts:82` (advisory lock)
- `apps/server/src/routes/mint.ts:126-138` (dual-counter UPDATE)
- `apps/server/src/schedule.ts:104-114` (halving — reason `nextval` isn't a one-liner)
- `apps/server/migrations/017_block_height_counter.sql` (current `block_height` source)
