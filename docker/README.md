# Local dev with Docker Compose

The whole rpow2 stack — Postgres, the API server, the web SPA — boots from
**one** command:

```bash
./up.sh
```

`up.sh` checks Docker is available, finds free host ports (so it Just
Works even if you already have a Postgres or another Vite project
running), brings the stack up with `docker compose up -d --build`, and
waits until the API is responding before printing a banner with all the
URLs. You can also call compose directly with `docker compose up` if you
prefer — the wrapper is purely for convenience.

First boot runs `npm ci` and builds the workspace packages inside the
container; subsequent boots are fast (skipped via a sentinel file). With
defaults, when the dust settles you'll have:

| Service | URL | Notes |
|---|---|---|
| Web SPA | <http://localhost:5173> | Vite dev server, full HMR |
| API | <http://localhost:8080> | Fastify with `tsx watch` hot reload |
| Postgres | `postgres://rpow:rpow_dev@localhost:55432/rpow` | Exposed on host port 55432 |

If those host ports are taken, `up.sh` walks forward (8080 → 8081 → …)
and writes the choices to a gitignored `.env` at the repo root that
compose interpolates into the service definitions. To force specific
ports, export them before running:

```bash
RPOW_API_PORT=9000 RPOW_WEB_PORT=9001 RPOW_DB_PORT=9002 ./up.sh
```

## up.sh subcommands

```bash
./up.sh             # build + up + wait for /health + print banner
./up.sh --rebuild   # nuke node_modules volume, rebuild dev images, then up
./up.sh --down      # docker compose down (volumes preserved)
./up.sh --wipe      # docker compose down -v (full reset)
./up.sh --help      # show inline help
```

Magic links and pending-claim links print to the server logs because
`RPOW_TEST_INBOX=true`. Tail them with:

```bash
docker compose logs -f server
```

Or fetch the latest magic link for an email by hitting the dev-only
endpoint the server exposes when `RPOW_TEST_INBOX=true`:

```bash
curl -i http://localhost:8080/test/last-link/me@example.com
# or as JSON:
curl -s 'http://localhost:8080/test/last-link/me@example.com?json=1'
```

## What's where

```
up.sh                     One-command bootstrap (./up.sh, ./up.sh --down, --wipe, --rebuild)
compose.yaml              Service graph at the repo root
docker/
├── dev.Dockerfile        Node 22 + bash + postgresql-client base image
├── dev.env               Committed dev env defaults (do not put secrets here)
├── dev.env.local         (gitignored, optional) per-user secrets — Resend, Solana
├── install.sh            One-shot: npm ci + build @rpow/shared and @rpow/solana-bridge
├── server-entrypoint.sh  wait for db → ensure signing keys → tsx watch
├── web-entrypoint.sh     vite --host 0.0.0.0
├── gen-keys.mjs          generate Ed25519 keypair (mirrors signing.ts)
└── README.md             this file
```

## Where do secrets go?

The committed `docker/dev.env` only holds **non-secret** dev defaults
(`NODE_ENV`, `RPOW_TEST_INBOX=true`, dummy keys). For real external
services drop a `docker/dev.env.local` file alongside it — compose loads
it as an optional second env layer (see `compose.yaml`) and overrides
anything in `dev.env`. It's gitignored, so this is the safe place to put:

```dotenv
# docker/dev.env.local — gitignored, optional, second-layer override
RESEND_API_KEY=re_live_yourkey
EMAIL_FROM=no-reply@yourdomain.com

# SRPOW (Solana wrap) — see docs/RUNBOOK.md "SRPOW + halving rollout"
SOLANA_RPC_URL=https://api.devnet.solana.com
SRPOW_MINT_ADDRESS=...
BRIDGE_KEYPAIR_BASE58=...
WRAP_ALLOWED_EMAILS=you@example.com
```

After editing, just `./up.sh` again — compose picks up env-file changes
on the next `up`.

## Service graph

```
db ──────────────────► server ──────────► web
   (healthcheck)         (depends on        (depends on
                          install +          install +
                          db healthy)        server)

install (one-shot)
   └─► populates rpow-node-modules and dist/ for @rpow/shared, @rpow/solana-bridge
```

`install` runs as a one-shot and exits 0; `server` and `web` wait on
`service_completed_successfully` so they only start after deps are ready.

## Persistent state

| Volume | Used for |
|---|---|
| `rpow2-dev_rpow-pg-data` | Postgres cluster data files |
| `rpow2-dev_rpow-node-modules` | Hoisted `node_modules` shared by all services |
| `rpow2-dev_rpow-runtime` | `signing-keys.env` so token sigs survive restarts |

To wipe all state and start clean:

```bash
./up.sh --wipe   # equivalent to: docker compose down -v && rm -f .env
./up.sh
```

That regenerates the signing keypair on next boot, so tokens minted in
the previous session will no longer verify.

## Common tasks

### Reach the API or DB from the host

```bash
curl http://localhost:8080/health
curl http://localhost:8080/ledger
PGPASSWORD=rpow_dev psql -h localhost -p 55432 -U rpow rpow
```

### Force a clean reinstall of dependencies

```bash
docker compose run --rm install rm -f node_modules/.dev-installed
docker compose up install        # or simply `docker compose up`
```

### Rebuild `@rpow/shared` after editing it

The `tsx watch` server picks up edits inside `apps/server/src/**` and
`packages/shared/src/**` directly (because tsx loads `.ts` from sources).
The web SPA, however, imports the **built** entry of `@rpow/shared` and
`@rpow/solana-bridge`. After editing either package, rebuild it:

```bash
docker compose exec server npm run build --workspace @rpow/shared
docker compose exec server npm run build --workspace @rpow/solana-bridge
```

(Vite will auto-reload the SPA after the dist files change.)

### Run the test suite

```bash
docker compose run --rm install bash -c "npm test"
```

Or scoped to one workspace:

```bash
docker compose run --rm install bash -c "npm --workspace @rpow/server test"
```

### Try the SRPOW wrap in dev

SRPOW is intentionally **disabled** in the default dev env so the server
falls back to the in-process `FakeBridgeClient`. To exercise the real wrap
flow you need a Solana keypair, an RPC URL, and an SPL mint:

1. Generate a bridge keypair and create an SRPOW mint on Solana **devnet**
   following the runbook (`docs/RUNBOOK.md` §SRPOW + halving rollout).
2. Drop the relevant `SOLANA_RPC_URL`, `SRPOW_MINT_ADDRESS`,
   `BRIDGE_KEYPAIR_BASE58`, and `WRAP_ALLOWED_EMAILS=<your-dev-email>`
   into `docker/dev.env.local` (gitignored). Compose already loads it as
   an optional override layer — no edits to `compose.yaml` needed.
3. `./up.sh` (or `docker compose up server`) to pick up the new env.

## Troubleshooting

**HMR not picking up file edits** — the env already sets
`CHOKIDAR_USEPOLLING=true` for macOS/WSL2 reliability. If you're still
not seeing updates, increase the poll interval (`CHOKIDAR_INTERVAL=1000`)
or — more aggressively — drop the bind mount and rely on container-side
edits via `docker compose exec`.

**Server logs `invalid env: …`** — env validation runs first thing in
`apps/server/src/server.ts`. The most common dev cause is editing
`docker/dev.env` and forgetting that `MAILER=resend` requires
`RESEND_API_KEY` to be set (the dummy `re_dev_dummy_*` value is fine, the
key just has to exist).

**Magic link doesn't redirect properly** — the magic link uses
`MAGIC_LINK_BASE_URL`, which is `http://localhost:8080` in this stack. If
you click the link from a browser running on a different host (e.g. you
ran compose on a remote VM), override `MAGIC_LINK_BASE_URL` and
`WEB_ORIGIN` in `docker/dev.env.local` to match the host you actually
browse from.

**Permission errors on `node_modules` after switching from host `npm install`** —
your host wrote files as your UID; the container writes as `root` (the
`node` image's default for shells). Either run `chown` on the host, or
nuke and start fresh:

```bash
docker compose down -v
rm -rf node_modules packages/*/dist apps/*/dist
docker compose up
```
