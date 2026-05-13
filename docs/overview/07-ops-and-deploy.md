# 07 · Ops And Deploy

The app is designed to run on infrastructure controlled by the operator:
Fastify/Node, Postgres, nginx or another self-hosted reverse proxy, and local
backup/archive storage. No CDN or third-party runtime dependency is required
for ledger correctness.

The simplest production path is the Docker-based AWS EC2 deploy:

```bash
./deploy-aws-ec2.sh
```

That script installs Docker when needed, creates `ops/aws-ec2/prod.env` on first
run, appends any missing default env vars on later runs without overwriting
secrets, builds the API and SPA images, starts Postgres, publishes ports `80`
and `443` through `nginxproxy/nginx-proxy`, and uses
`nginxproxy/acme-companion` for Let's Encrypt certificates. The default hosts
are `rpow4.com` and `api.rpow4.com`.

## Required Env

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `SESSION_SECRET` | HMAC secret for sessions and stateless envelopes |
| `RPOW_SIGNING_PRIVATE_KEY_HEX` | Server Ed25519 token/event signing key |
| `RPOW_SIGNING_PUBLIC_KEY_HEX` | Published verification key |
| `DIFFICULTY_BITS` | Mining difficulty ceiling/default |
| `DIFFICULTY_STEP_BLOCKS` | Blocks between +1-bit difficulty steps |
| `DIFFICULTY_MAX_BITS` | Maximum mining difficulty |
| `SIGNUP_DIFFICULTY_BITS` | Anti-spam signup PoW |
| `MINT_MAX_SUPPLY` | Cap counter ceiling in whole RPOW |
| `WEB_ORIGIN` | CORS origin for the SPA |
| `WEB_HOST` | Public SPA hostname used by the production proxy |
| `API_HOST` | Public API hostname used by the production proxy |
| `LETSENCRYPT_EMAIL` | Contact email for certificate issuance |

## RPOW2 Bridge Runbook

RPOW2 deposits and withdrawals are optional. To enable them, create or choose a
dedicated banker account on RPOW2, log in manually, and copy the full browser
cookie value into `RPOW2_SESSION_COOKIE` without committing it to git.

| Var | Purpose |
|---|---|
| `RPOW2_API_BASE_URL` | RPOW2 API origin, default `https://api.rpow2.com` |
| `RPOW2_BANKER_EMAIL` | Email address users send deposits to, default `rpow4bank@gmail.com` |
| `RPOW2_SESSION_COOKIE` | Full banker session cookie, e.g. `rpow_session=...` |
| `RPOW2_DEPOSIT_POLL_ENABLED` | Enables the background deposit poller |

Operational flow:

- Users send RPOW2 to the banker email with their RPOW4 pubkey in the memo.
- The server polls RPOW2 `/activity?since=...` and credits matching deposits.
- Unknown memos remain `unattributed` for an admin to assign manually.
- Withdrawals lock internal RPOW2 immediately and require admin approval.
- On first setup, confirm `external_sync_state.cursor_at` is earlier than any
  banker deposits you expect to import. The migration defaults it to setup time
  so old banker history is not imported accidentally.
- If RPOW2 returns `401`, assume the browser session expired. Rotate
  `RPOW2_SESSION_COOKIE`, restart the API, use the admin RPOW2 panel to
  resume sync, then trigger a manual sync.
- The DB config flags `external_asset_configs.deposit_enabled` and
  `external_asset_configs.withdrawal_enabled` can temporarily pause deposits or
  new withdrawal requests without removing the market.

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
