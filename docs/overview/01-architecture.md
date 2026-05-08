# 01 · Architecture

This doc describes the deployed topology, the repo layout, and the runtime
shape of each component.

## Deployment topology

```
        Browser
          │
          ▼
  rpow2.com (Netlify CDN)                          api.rpow2.com (OVH VPS)
  ─────────────────────────                        ──────────────────────────
  apps/web (React + Vite)            HTTPS         nginx :443  (Let's Encrypt)
  HashRouter SPA                  ─────────►       │
  miner.worker.ts (WASM SHA-256)                   ▼
                                                   rpow-server.service
                                                   ▼ Node 22 + Fastify on :8080
                                                   ▼
                                                   PostgreSQL 17 (Unix socket)
                                                   /var/run/postgresql
                                                   ▼ outbound
                                                   Resend / Postmark / SMTP
                                                   Solana mainnet (Helius/etc.)
```

Concretely, as of 2026-05-08:

- **Web** — Netlify, deployed from `main`; static SPA, hash-router. Build is
  `npm ci --workspaces … && npm run build --workspace @rpow/shared && npm run build --workspace @rpow/web`. See [`netlify.toml`](../../netlify.toml).
- **API** — OVH VPS (Ubuntu 25.04, kernel 6.14, ~4–8 GB RAM) at
  `15.204.254.192`. Single Node 22 process under systemd
  ([`rpow-server.service`](../../ops/systemd/rpow-server.service)) behind
  nginx ([`api.rpow2.com.conf`](../../ops/nginx/api.rpow2.com.conf)).
- **DB** — PostgreSQL 17 on the same VPS. Unix-socket only. App pool size 30
  (see [`db.ts`](../../apps/server/src/db.ts)).
- **DNS / TLS** — Cloudflare DNS (DNS-only for `api.*`, proxied for apex).
  Certbot via DNS-01 (Cloudflare API token), auto-renewing.
- **Email** — Resend in prod (with throttling, see below), Postmark and SMTP
  fallbacks compiled in. `FakeMailer` is used in dev when
  `RPOW_TEST_INBOX=true` and prints magic links to stdout.
- **Backups** — restic → Backblaze B2, nightly via
  [`rpow-backup.timer`](../../ops/systemd/rpow-backup.timer).
- **SRPOW** — Optional. Lit up only when `SOLANA_RPC_URL`,
  `SRPOW_MINT_ADDRESS`, and `BRIDGE_KEYPAIR_BASE58` are all set.

A `fly.toml` and `apps/server/Dockerfile` still exist from the previous
Fly.io + Neon deployment but are no longer the production target. The
migration is documented in [`docs/superpowers/specs/2026-05-07-fly-to-vps-migration-design.md`](../superpowers/specs/2026-05-07-fly-to-vps-migration-design.md).

## Repo layout (npm workspaces monorepo)

```
rpow/
├── apps/
│   ├── server/                    @rpow/server — Fastify API
│   │   ├── src/
│   │   │   ├── server.ts          process entry: env → pool → migrations → mailer → bridge → app.listen
│   │   │   ├── buildApp.ts        Fastify wiring + decorators + plugin registration
│   │   │   ├── env.ts             zod schema for the env, refined by mailer choice
│   │   │   ├── db.ts              pg Pool factory, withTx/withClient helpers, runMigrations
│   │   │   ├── magic.ts           magic-link issue + sha256 hashing
│   │   │   ├── session.ts         HMAC-signed `email|exp` cookie
│   │   │   ├── pow.ts             trailing-zero-bits SHA-256 verifier
│   │   │   ├── schedule.ts        halving math, BASE_UNITS_PER_RPOW, supply-aware reward
│   │   │   ├── signing.ts         Ed25519 token sign/verify (raw 32-byte keys)
│   │   │   ├── mailer.ts          Resend/Postmark/SMTP/Throttled/Fake mailers
│   │   │   ├── unsub.ts           HMAC unsubscribe tokens + email_unsubscribes table I/O
│   │   │   ├── bridge-keys.ts     decode BRIDGE_KEYPAIR_BASE58 → Keypair
│   │   │   ├── srpow-reconcile.ts boot-time scan of PENDING wrap events
│   │   │   ├── wrap-allowlist.ts  parse WRAP_ALLOWED_EMAILS CSV
│   │   │   └── routes/
│   │   │       ├── auth.ts        /auth/{request,verify,logout}
│   │   │       ├── me.ts          /me (balances + wrap state)
│   │   │       ├── challenge.ts   /challenge (with cached supply read)
│   │   │       ├── mint.ts        /mint (advisory-locked supply increment)
│   │   │       ├── send.ts        /send (exact-sum reissuance + pending email path)
│   │   │       ├── claim.ts       /claim?token=…
│   │   │       ├── activity.ts    /activity (mint/send/receive feed)
│   │   │       ├── ledger.ts      /ledger (cached aggregates + halving info)
│   │   │       ├── phantom.ts     /phantom/{challenge,bind}
│   │   │       ├── srpow.ts       /srpow/{wrap,events,events/:id}
│   │   │       └── unsubscribe.ts /unsubscribe (RFC 8058 one-click + GET)
│   │   ├── migrations/            001..010 — see 04-data-model.md
│   │   ├── scripts/               one-shot Solana scripts (mint, allocation, metadata)
│   │   └── tests/                 Vitest, real Postgres on :55432 in dev/CI
│   │
│   └── web/                       @rpow/web — Vite + React 18 + HashRouter SPA
│       ├── src/
│       │   ├── main.tsx, App.tsx  routes: /, /login, /mine, /send, /activity, /ledger, /wrap
│       │   ├── miner.worker.ts    WASM SHA-256 mining loop in a Web Worker
│       │   ├── api.ts             typed fetch wrapper, credentials: include
│       │   ├── pages/             one .tsx per route
│       │   ├── components/        Panel, ConnectPhantom, WrapForm, WrapHistory
│       │   ├── hooks/             useMe, usePhantom, useSrpow
│       │   ├── lib/format.ts      formatRpow / parseRpowToBaseUnits (9-decimal)
│       │   ├── theme.ts           amber/green/light themes
│       │   └── styles.css         retro-terminal CSS
│       ├── public/
│       │   ├── stats.html         standalone "live network stats" page (HashRouter-bypassed via netlify redirect /stats → /stats.html)
│       │   ├── srpow-logo.{png,svg}
│       │   └── srpow-token-metadata.template.json
│       └── e2e/happy-path.spec.ts Playwright
│
├── packages/
│   ├── shared/                    @rpow/shared — wire types + difficulty math
│   │   └── src/
│   │       ├── protocol.ts        all request/response interfaces (the wire schema)
│   │       └── difficulty.ts      trailingZeroBits, hex/u64 helpers (used by server + worker)
│   │
│   └── solana-bridge/             @rpow/solana-bridge — Solana SPL adapter
│       └── src/
│           ├── constants.ts       SRPOW_DECIMALS=9, SRPOW_BASE_UNITS_PER_RPOW=10^9
│           ├── wallet-verify.ts   nacl ed25519 verify of Phantom signMessage
│           ├── bridge-client.ts   SolanaBridgeClient (real) + FakeBridgeClient (test)
│           └── index.ts
│
├── ops/                           VPS-side ops surface
│   ├── nginx/api.rpow2.com.conf
│   ├── systemd/rpow-{server,backup,healthcheck}.{service,timer}
│   └── *.sh                       backup, dns-flip, smoke-test, parity-check, etc.
│
├── docs/
│   ├── RUNBOOK.md                 operator runbook
│   ├── overview/                  this folder
│   └── superpowers/{specs,plans}/ canonical design specs and implementation plans
│
├── fly.toml                       (legacy) Fly.io config
├── netlify.toml                   web SPA build + redirects
├── package.json                   workspaces root, npm scripts
└── README.md                      one-page README + dev quickstart
```

## Server boot sequence

`apps/server/src/server.ts`:

1. Parse env via [`env.ts`](../../apps/server/src/env.ts) (zod, fails fast on
   missing/invalid vars).
2. Create the pg pool (`max=30`).
3. Run migrations (idempotent, table-locked via
   `schema_migrations(filename PK)`; see [`db.ts`](../../apps/server/src/db.ts)).
4. Choose a `BridgeClient`: real `SolanaBridgeClient` if `SOLANA_RPC_URL` +
   `SRPOW_MINT_ADDRESS` + `BRIDGE_KEYPAIR_BASE58` are all set, else
   `FakeBridgeClient` (wrap is effectively disabled).
5. Run [`reconcilePendingWraps`](../../apps/server/src/srpow-reconcile.ts)
   once — recover any wrap events that were `PENDING` when the previous
   process exited.
6. Choose a `Mailer`. In production it is wrapped in `ThrottledMailer`
   (default 4 req/s, queue cap 200) so we never blow Resend's per-second cap.
7. Build the Fastify app via `buildApp({ pool, mailer, bridgeClient, … })`
   and `app.listen({ host: '0.0.0.0', port: PORT })`.

`buildApp` decorates the Fastify instance with `pool`, `mailer`, `config`,
`bridgeClient`, and the parsed `wrapAllowlist`, registers `cookie`, `cors`
(`origin: WEB_ORIGIN`, `credentials: true`), then registers each route plugin.

## Trust & cookies

- Sessions are an HMAC-signed cookie (`rpow_session`) with 30-day TTL. Body
  is `{ email, exp }` base64url-encoded; signature is
  `HMAC-SHA256(SESSION_SECRET, body)`. See [`session.ts`](../../apps/server/src/session.ts).
- The cookie is `httpOnly`, `sameSite=lax`, `secure` in production, scoped
  to `/`. CORS is locked to a single `WEB_ORIGIN`.
- `trustProxy: '127.0.0.1'` — `req.ip` is taken from `X-Forwarded-For` only
  when the connection comes from nginx on localhost. This is what makes the
  per-IP rate limit on `/auth/request` actually meaningful behind the proxy.

## Cross-cutting concerns

| Concern | Where it lives |
|---|---|
| Migration runner | [`db.runMigrations`](../../apps/server/src/db.ts), invoked once on boot |
| Auth context | `readSession(req, secret)` in [`routes/auth.ts`](../../apps/server/src/routes/auth.ts), used by every protected route |
| Idempotency | UNIQUE indexes on `transfers.idempotency_key`, `pending_transfers.idempotency_key`, `srpow_wrap_events.idempotency_key`; route handlers detect 23505 conflicts and return the original outcome |
| Hot-path caching | `/challenge` caches `app_counters.minted_supply` for 5s; `/ledger` caches its full aggregate for 5s, with single-flight in-flight de-dup |
| Cap enforcement | `pg_advisory_xact_lock(hashtext('rpow_mint_supply'))` + atomic `UPDATE … WHERE value + reward <= cap` in [`mint.ts`](../../apps/server/src/routes/mint.ts) |
| Per-user wrap serialization | `pg_advisory_xact_lock(hashtext('rpow_srpow_wrap'), hashtext(email))` in [`srpow.ts`](../../apps/server/src/routes/srpow.ts) |
| Outbound mail throttle | `ThrottledMailer` in [`mailer.ts`](../../apps/server/src/mailer.ts) — monotonic-next-slot scheduler, throws `ThrottleQueueFullError` over `maxQueue` |
| Email unsubscribe | RFC 8058 one-click POST + GET at `/unsubscribe`, HMAC-signed token (no DB lookup); see [`unsub.ts`](../../apps/server/src/unsub.ts) |
| Public key | Served at `/.well-known/rpow-pubkey.pem` (DER → PEM-wrapped Ed25519 SubjectPublicKeyInfo) |

## Failure modes (high level)

| What dies | What recovers it |
|---|---|
| Node process | systemd `Restart=always`, `RestartSec=2`, up to 10 starts/5min |
| Process hung but alive | `rpow-healthcheck.timer` probes `/health` every 90s; restarts after 2 failures |
| nginx / Postgres | distro systemd units |
| Whole VPS | All units `enabled` — they come back on boot |
| TLS expiry | `certbot.timer` (DNS-01 via Cloudflare) |
| In-flight SRPOW wrap | `reconcilePendingWraps()` on next boot uses persisted `solana_signature` |
| Backup repo | Nightly 5% read-data integrity check; `rpow-restore-test` runs weekly |

External uptime monitoring is *not* yet wired (noted as a follow-up in the
runbook).
