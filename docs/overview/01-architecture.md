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
  BIP-39 wallet (browser)                          rpow-server.service
                                                   ▼ Node 22 + Fastify on :8080
                                                   ▼
                                                   PostgreSQL 17 (Unix socket)
                                                   /var/run/postgresql
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
- **No email.** Auth is purely wallet-based; the server never issues
  outbound email. The browser's `WalletProvider` holds the user's secret
  key (optionally encrypted via PBKDF2 → AES-GCM in IndexedDB), and every
  state-changing API call is signed by it. See `apps/web/src/wallet/`.
- **Backups** — restic → Backblaze B2, nightly via
  [`rpow-backup.timer`](../../ops/systemd/rpow-backup.timer).

A `fly.toml` and `apps/server/Dockerfile` still exist from the previous
Fly.io + Neon deployment but are no longer the production target. The
migration is documented in [`docs/superpowers/specs/2026-05-07-fly-to-vps-migration-design.md`](../superpowers/specs/2026-05-07-fly-to-vps-migration-design.md).

## Repo layout (npm workspaces monorepo)

```
rpow/
├── apps/
│   ├── server/                    @rpow/server — Fastify API
│   │   ├── src/
│   │   │   ├── server.ts          process entry: env → pool → migrations → app.listen
│   │   │   ├── buildApp.ts        Fastify wiring + decorators + plugin registration
│   │   │   ├── env.ts             zod schema for the env
│   │   │   ├── db.ts              pg Pool factory, withTx/withClient helpers, runMigrations
│   │   │   ├── session.ts         HMAC-signed `pubkey|exp` cookie
│   │   │   ├── pow.ts             trailing-zero-bits SHA-256 verifier
│   │   │   ├── schedule.ts        halving math, BASE_UNITS_PER_RPOW, supply-aware reward
│   │   │   ├── signing.ts         Ed25519 server token sign/verify
│   │   │   └── routes/
│   │   │       ├── auth.ts        /auth/{challenge,session,logout}
│   │   │       ├── me.ts          /me (maintained account balance row)
│   │   │       ├── challenge.ts   /challenge (stateless HMAC challenge)
│   │   │       ├── mint.ts        /mint (verifies sig + credits balance)
│   │   │       ├── send.ts        /send (signed conditional debit/credit)
│   │   │       ├── activity.ts    /activity (mint/send/receive feed)
│   │   │       └── ledger.ts      /ledger + /ledger/events
│   │   ├── migrations/            SQL migrations — see 04-data-model.md
│   │   └── tests/                 Vitest, real Postgres in dev/CI
│   │
│   └── web/                       @rpow/web — Vite + React 18 + HashRouter SPA
│       ├── src/
│       │   ├── main.tsx, App.tsx  routes: /, /login, /mine, /send, /activity, /ledger
│       │   ├── miner.worker.ts    WASM SHA-256 mining loop in a Web Worker
│       │   ├── api.ts             typed fetch wrapper, credentials: include
│       │   ├── wallet/            BIP-39 mnemonic + SLIP-0010 Ed25519 + IndexedDB store
│       │   │   ├── crypto.ts          PBKDF2 → AES-GCM helpers (WebCrypto)
│       │   │   ├── store.ts           encrypted-blob CRUD over IndexedDB
│       │   │   └── WalletProvider.tsx React context: status machine + sign/unlock/forget
│       │   ├── pages/             one .tsx per route
│       │   ├── components/        Panel and wallet/display helpers
│       │   ├── hooks/             useMe
│       │   ├── lib/format.ts      formatRpow / parseRpowToBaseUnits (9-decimal)
│       │   ├── theme.ts           amber/green/light themes
│       │   └── styles.css         retro-terminal CSS
│       └── public/
│           └── stats.html         standalone "live network stats" page
│
├── packages/
│   ├── shared/                    @rpow/shared — wire types + crypto + difficulty math
│   │   └── src/
│   │       ├── protocol.ts        all request/response interfaces (the wire schema)
│   │       ├── canonical.ts       domain-separated, sorted-key JSON for signed actions
│   │       ├── wallet.ts          BIP-39 + SLIP-0010 Ed25519 + signCanonical/verifyCanonical
│   │       └── difficulty.ts      trailingZeroBits, hex/u64 helpers (used by server + worker)
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
4. Build the Fastify app via `buildApp({ pool, config })` and
   `app.listen({ host: '0.0.0.0', port: PORT })`.

`buildApp` decorates the Fastify instance with `pool` and `config`, registers `cookie`, `cors`
(`origin: WEB_ORIGIN`, `credentials: true`), then registers each route plugin.

## Trust & cookies

- Sessions are an HMAC-signed cookie (`rpow_session`) with 30-day TTL. Body
  is `{ pubkey, exp }` base64url-encoded; signature is
  `HMAC-SHA256(SESSION_SECRET, body)`. See [`session.ts`](../../apps/server/src/session.ts).
- The cookie is `httpOnly`, `sameSite=lax`, `secure` in production, scoped
  to `/`. CORS is locked to a single `WEB_ORIGIN`.
- `trustProxy: '127.0.0.1'` — `req.ip` is taken from `X-Forwarded-For` only
  when the connection comes from nginx on localhost.
- `/auth/challenge` is stateless: the server returns an HMAC-MAC'd envelope
  containing `pubkey`, `nonce`, and `exp`; `/auth/session` then verifies the
  client's Ed25519 signature over the canonical envelope and sets the cookie.

## Cross-cutting concerns

| Concern | Where it lives |
|---|---|
| Migration runner | [`db.runMigrations`](../../apps/server/src/db.ts), invoked once on boot |
| Auth context | `readSession(req, secret)` in [`session.ts`](../../apps/server/src/session.ts), used by every protected route |
| Per-action signature verification | `verifyCanonical(action, body, pubkey, sig)` from `@rpow/shared`, called by `/mint` and `/send` |
| Idempotency | Partial UNIQUE index on `ledger_events.idempotency_key` for transfers; route handlers detect 23505 conflicts and return the original outcome |
| Hot-path caching | `/challenge` caches `app_counters.minted_supply` for 5s; `/ledger` reads maintained stats and caches the response for 5s |
| Cap enforcement | `pg_advisory_xact_lock(hashtext('rpow_mint_supply'))` + atomic `UPDATE … WHERE value + reward <= cap` in [`mint.ts`](../../apps/server/src/routes/mint.ts) |
| Public token-issuer key | Served at `/.well-known/rpow-pubkey.pem` (DER → PEM-wrapped Ed25519 SubjectPublicKeyInfo) |

## Failure modes (high level)

| What dies | What recovers it |
|---|---|
| Node process | systemd `Restart=always`, `RestartSec=2`, up to 10 starts/5min |
| Process hung but alive | `rpow-healthcheck.timer` probes `/health` every 90s; restarts after 2 failures |
| nginx / Postgres | distro systemd units |
| Whole VPS | All units `enabled` — they come back on boot |
| TLS expiry | `certbot.timer` (DNS-01 via Cloudflare) |
| Lost client wallet | Recovery is the user's responsibility — mnemonic must be backed up. The server cannot reset accounts. |
| Backup repo | Nightly 5% read-data integrity check; `rpow-restore-test` runs weekly |

External uptime monitoring is *not* yet wired (noted as a follow-up in the
runbook).
