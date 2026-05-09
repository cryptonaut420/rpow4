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

Auth is purely wallet-based — there are no email magic links to chase
down. Open <http://localhost:5173/#/login> and either:

- **Create new wallet** — generates a 12-word BIP-39 mnemonic in the
  browser. Write it down, click "I've saved it", optionally set a
  passphrase to encrypt it to IndexedDB so it survives a tab close.
- **Import mnemonic** — paste an existing 12/15/18/21/24-word phrase.
- **Import private key** — paste a base58-encoded 64-byte secret key
  (the same format Solana CLI's `id.json` uses, just base58'd).

The browser derives a SLIP-0010 Ed25519 keypair at `m/44'/501'/0'/0'`
(the Solana derivation path) and signs the `/auth/session` envelope with
it; the server only ever sees your public key and signatures.

## What's where

```
up.sh                     One-command bootstrap (./up.sh, ./up.sh --down, --wipe, --rebuild)
compose.yaml              Service graph at the repo root
docker/
├── dev.Dockerfile        Node 22 + bash + postgresql-client base image
├── dev.env               Committed dev env defaults (do not put secrets here)
├── dev.env.local         (gitignored, optional) per-user secrets
├── install.sh            One-shot: npm ci + build @rpow/shared
├── server-entrypoint.sh  wait for db → ensure signing keys → tsx watch
├── web-entrypoint.sh     vite --host 0.0.0.0
├── gen-keys.mjs          generate Ed25519 keypair (mirrors signing.ts)
└── README.md             this file
```

## Where do secrets go?

The committed `docker/dev.env` only holds **non-secret** dev defaults
(`NODE_ENV`, dummy keys). Put local-only overrides in
`docker/dev.env.local`; compose loads it as an optional second env layer
(see `compose.yaml`) and overrides anything in `dev.env`. It's gitignored.

```dotenv
# docker/dev.env.local — gitignored, optional, second-layer override

# Example override:
PORT=8081
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
   └─► populates rpow-node-modules and dist/ for @rpow/shared
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
The web SPA, however, imports the **built** entry of `@rpow/shared`. After
editing that package, rebuild it:

```bash
docker compose exec server npm run build --workspace @rpow/shared
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

## Troubleshooting

**HMR not picking up file edits** — the env already sets
`CHOKIDAR_USEPOLLING=true` for macOS/WSL2 reliability. If you're still
not seeing updates, increase the poll interval (`CHOKIDAR_INTERVAL=1000`)
or — more aggressively — drop the bind mount and rely on container-side
edits via `docker compose exec`.

**Server logs `invalid env: …`** — env validation runs first thing in
`apps/server/src/server.ts`. Check `apps/server/src/env.ts` for the
authoritative list of required vars; the committed `docker/dev.env`
should already cover all of them.

**`/auth/session` returns `BAD_SIGNATURE`** — the canonical message
serializer is keyed by `CANONICAL_VERSION` in
`packages/shared/src/canonical.ts`. After editing `@rpow/shared` you
must rebuild it (see "Rebuild `@rpow/shared` after editing it" above) so
the served bundle matches what the server expects.

**`WalletProvider` shows the wrong host** — if you ran compose on a
remote VM and your browser hits a different origin than `WEB_ORIGIN`,
the server CORS layer rejects you. Override `WEB_ORIGIN` in
`docker/dev.env.local` to match the host you actually browse from.

**Permission errors on `node_modules` after switching from host `npm install`** —
your host wrote files as your UID; the container writes as `root` (the
`node` image's default for shells). Either run `chown` on the host, or
nuke and start fresh:

```bash
docker compose down -v
rm -rf node_modules packages/*/dist apps/*/dist
docker compose up
```
