# 07 · Ops And Deploy

The app is designed to run on infrastructure controlled by the operator:
Fastify/Node, Postgres, nginx or another self-hosted reverse proxy, and local
backup/archive storage. No CDN or third-party runtime dependency is required
for ledger correctness.

## Required Env

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `SESSION_SECRET` | HMAC secret for sessions and stateless envelopes |
| `RPOW_SIGNING_PRIVATE_KEY_HEX` | Server Ed25519 token/event signing key |
| `RPOW_SIGNING_PUBLIC_KEY_HEX` | Published verification key |
| `DIFFICULTY_BITS` | Mining difficulty ceiling/default |
| `DIFFICULTY_FLOOR` | Minimum accepted mining difficulty |
| `SIGNUP_DIFFICULTY_BITS` | Anti-spam signup PoW |
| `MINT_MAX_SUPPLY` | Cap counter ceiling in whole RPOW |
| `WEB_ORIGIN` | CORS origin for the SPA |

## Scaling Notes

- Keep current-state reads on `account_balances`, `ledger_stats`, and
  `app_counters`.
- Keep public history paginated through `ledger_events`.
- Use PgBouncer and self-hosted read replicas when one primary becomes a
  bottleneck.
- Cache public `/ledger` and `/ledger/events` responses in-process or through a
  self-hosted reverse proxy with short TTLs and stale responses under pressure.
- Archive old `ledger_events` partitions outside the hot database after
  publishing checkpoints.

## Operational Checks

- Monitor DB connection count, transaction time, lock waits, deadlocks, WAL
  volume, table/index bloat, and slow queries.
- Run restore drills, not just backups.
- Run production-volume load tests for `/challenge`, `/mint`, `/send`, `/me`,
  `/activity`, `/ledger`, and `/ledger/events`.
- Reconcile maintained counters outside request paths and alert on drift.
