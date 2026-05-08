# 07 · Ops & Deploy

This doc is a high-level pointer into the deploy and ops surface. The
authoritative operator handbook is [`docs/RUNBOOK.md`](../RUNBOOK.md). Read
this for orientation, then RUNBOOK for the actual commands.

## Hosting summary

| Layer | Where | Notes |
|---|---|---|
| Web SPA | Netlify (static) | Built from `main`. SPA fallback redirects in `netlify.toml`. `/stats` serves a standalone HTML stats page. |
| API | OVH VPS at `15.204.254.192`, Ubuntu 25.04 | Node 22 + Fastify under systemd; nginx + Let's Encrypt for TLS. |
| DB | Postgres 17 on the same VPS | Unix-socket-only (`/var/run/postgresql`). |
| Email | Resend (default) | Postmark + SMTP fallbacks compiled in; selected via `MAILER` env. |
| Solana | Helius/QuickNode/Triton | Configured via `SOLANA_RPC_URL`. |
| DNS / TLS | Cloudflare DNS, certbot DNS-01 | `api.rpow2.com` is DNS-only (proxy off). |
| Backups | restic → Backblaze B2 | Nightly at 03:00 UTC, 5% read-data integrity check. |

The repo also still contains `fly.toml` and `apps/server/Dockerfile` from
the legacy Fly.io + Neon deployment — kept for reference and as a fallback
target. The live deployment as of 2026-05-08 is the OVH path.

## File layout on the VPS

```
/opt/rpow/
└── repo/                          # git clone of this repo
    ├── apps/server/dist/          # tsc build output (run by systemd)
    ├── apps/server/migrations/    # idempotent migration SQL
    └── node_modules/

/etc/rpow/
└── server.env                     # mode 0640, owner root:rpow
                                   # contains DATABASE_URL, RESEND_API_KEY,
                                   # SESSION_SECRET, RPOW_SIGNING_*, SRPOW_*, etc.

/etc/systemd/system/
├── rpow-server.service            # main process (Restart=always)
├── rpow-healthcheck.{service,timer}  # 90s probe of /health; restarts after 2 fails
└── rpow-backup.{service,timer}    # nightly restic snapshot

/etc/nginx/sites-enabled/
└── api.rpow2.com.conf             # reverse proxy → 127.0.0.1:8080
```

The on-disk surface mirrors the [`ops/`](../../ops) folder in the repo, so
diffs are inspectable in version control.

## Required env (production)

Reference: [`apps/server/src/env.ts`](../../apps/server/src/env.ts).

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes (`production`) | Switches `secureCookies` on. |
| `PORT` | default 8080 | nginx upstream. |
| `DATABASE_URL` | yes | `postgres://…` or socket-style URL. |
| `MAILER` | default `resend` | One of `resend`, `postmark`, `smtp`. |
| `RESEND_API_KEY` | conditional | Required if `MAILER=resend`. |
| `POSTMARK_TOKEN` | conditional | Required if `MAILER=postmark`. |
| `SMTP_HOST/PORT/USER/PASS` | conditional | Required if `MAILER=smtp`. |
| `EMAIL_FROM` | yes | Either `addr@domain` or `Name <addr@domain>`. |
| `SESSION_SECRET` | yes (≥32 chars) | HMAC key for the `rpow_session` cookie. |
| `MAGIC_LINK_BASE_URL` | yes | Origin used to construct `/auth/verify` and `/claim` URLs in emails. |
| `RPOW_SIGNING_PRIVATE_KEY_HEX` | yes (64 hex chars) | Raw 32-byte ed25519 private key. |
| `RPOW_SIGNING_PUBLIC_KEY_HEX`  | yes (64 hex chars) | Matching public key. |
| `DIFFICULTY_BITS` | default 28 | Floor for stamped difficulty (max'd against schedule). |
| `DIFFICULTY_FLOOR` | default 20 | Hard floor — `max(floor, scheduled)`. |
| `MINT_MAX_SUPPLY` | default 21_000_000 | Cap counter ceiling, in whole RPOW. **Production sets 19_900_000** to make room for the 1.1M satoshi allocation. |
| `WEB_ORIGIN` | default `http://localhost:5173` | Strict CORS origin and post-auth redirect target. |
| `MAIL_THROTTLE_RPS` | default 4 | `ThrottledMailer` outbound rate. |
| `MAIL_THROTTLE_MAX_QUEUE` | default 200 | Above this, `send()` throws 429. |
| `SOLANA_RPC_URL` | optional | Lights up `/srpow/*` and the boot reconciler. |
| `SRPOW_MINT_ADDRESS` | optional | Base58 SPL mint pubkey. |
| `BRIDGE_KEYPAIR_BASE58` | optional | 64-byte ed25519 secret in base58. |
| `WRAP_ALLOWED_EMAILS` | default `""` | CSV of emails that may call `/srpow/wrap`. |
| `SRPOW_COMMITMENT` | default `confirmed` | Or `finalized` (~13s). |
| `SRPOW_WRAP_TIMEOUT_MS` | default 60_000 | Wall-clock budget for one wrap. |
| `RPOW_TEST_INBOX` | unset in prod | When `true`, swaps in `FakeMailer` and exposes `/test/last-link/:email`. |

## Deploy

End-to-end deploy is one shell snippet (canonical version in the runbook):

```bash
ssh ubuntu@15.204.254.192 '
  sudo -u rpow bash -c "cd /opt/rpow/repo && \
    git pull origin main && \
    npm ci --workspaces --include-workspace-root --ignore-scripts && \
    npm run build --workspace @rpow/shared && \
    npm run build --workspace @rpow/server" && \
  sudo systemctl restart rpow-server'
```

Migrations apply on startup automatically (idempotent, locked via
`schema_migrations`). The reconcile worker also runs once on startup if
SRPOW envs are present.

The web SPA deploys independently when Netlify sees a new `main` push. It
reads `VITE_API_BASE_URL=https://api.rpow2.com` from `netlify.toml`.

## Recovery layers

| Failure | Recovery |
|---|---|
| Node process crash | systemd `Restart=always`, `RestartSec=2`, up to 10 starts/5min then pause |
| Process hang | `rpow-healthcheck.timer` probes `/health` every 90s, restarts after 2 consecutive fails |
| Postgres / nginx crash | Distro systemd units |
| VPS reboot | All `enabled` units come back |
| TLS expiry | `certbot.timer` (DNS-01 via Cloudflare) |
| In-flight wrap, server died | Boot-time `reconcilePendingWraps()` — see [`05-srpow-bridge.md`](./05-srpow-bridge.md) |
| DB corruption / box loss | Restore from restic + B2; documented sequence in RUNBOOK §"Incident: VPS down or compromised" |

External off-box uptime monitoring is a documented gap (only an external
monitor can catch a fully dead VPS).

## Backups

- `rpow-backup.timer` runs nightly at 03:00 UTC (with up to 5min jitter).
- `restic` snapshots a `pg_dump` to a Backblaze B2 bucket; encryption +
  retention configured in [`ops/backup.sh`](../../ops/backup.sh) and
  [`ops/restore-test.sh`](../../ops/restore-test.sh).
- Retention: 7 daily, 4 weekly, 6 monthly. 5% read-data integrity check
  per run.
- Restore drill (`/usr/local/bin/rpow-restore-test`) restores the latest
  snapshot into a scratch DB and prints row counts. Run weekly to keep
  restic + B2 creds healthy.

## Secrets

| File | Mode | Owner | Contents |
|---|---|---|---|
| `/etc/rpow/server.env` | 0640 | root:rpow | App env: `DATABASE_URL`, signing keys, Resend key, SRPOW vars |
| `/etc/rpow/restic.env` | 0600 | root:root | B2 creds + restic password |
| `/etc/letsencrypt/cloudflare.ini` | 0600 | root:root | Cloudflare API token for DNS-01 |

Rotating the signing key invalidates verifiability of *previously minted*
tokens: existing rows' `server_sig` will no longer verify under the new
public key. The runbook flags this and recommends coordination if a
rotation ever happens.

## Solana operations (high level)

Detailed in [`05-srpow-bridge.md`](./05-srpow-bridge.md) and §"SRPOW +
halving rollout" in the RUNBOOK. Three one-shot scripts under
`apps/server/scripts/`:

- `create-srpow-mint.ts` — `--init-keys` mode generates a bridge keypair;
  default mode creates the SPL mint.
- `mint-satoshi-allocation.ts` — mints the 1.1M founder allocation;
  refuses to run if supply is non-zero.
- `set-srpow-metadata.ts` — Metaplex on-chain metadata account.

The bridge keypair is the operator's single most sensitive Solana-side
secret. It is the SPL mint authority and the SOL fee payer for every
wrap. Funding flows in from the operator's personal wallet (≈0.01 SOL
sustains many thousands of wraps).

## Not (yet) wired

- External off-box uptime monitor.
- Bridge SOL low-balance alarm.
- SRPOW supply parity alarm (`SRPOW supply == 1.1M + count(WRAPPED rpow)`).
- Renouncing `updateAuthority` on the Metaplex metadata account
  (`isMutable: true` was retained on purpose to allow URI fixes).
- Unwrap (`SRPOW → rpow`).

These are documented as future work in the design specs and the runbook;
the v1 scope was deliberately minimal.
