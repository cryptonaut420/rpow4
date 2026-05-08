# rpow2

> A tribute to the original RPOW by Hal Finney.

A faithful modern recreation of Hal Finney's [Reusable Proofs of Work](https://nakamotoinstitute.org/finney/rpow/) (2004). Magic-link auth, hashcash mining (~30s on a modern MacBook), Ed25519-signed tokens, email-keyed transfers, public ledger.

## Quickstart

You need Docker (with the Compose plugin) and bash. That's it.

```bash
git clone <this repo>
cd rpow
./up.sh
```

`up.sh` checks Docker is running, finds free host ports if 8080/5173/55432 are taken, brings up Postgres + the API server (with hot reload) + the web SPA, waits for the API to be healthy, and prints a banner with the URLs. By default:

- Web SPA: <http://localhost:5173>
- API: <http://localhost:8080>
- Postgres: `postgres://rpow:rpow_dev@localhost:55432/rpow`

Magic links print to the server logs (`docker compose logs -f server`) so you can sign in without configuring an email provider. SRPOW (the optional Solana wrap) is disabled by default — the server boots with the in-process fake bridge client.

```bash
./up.sh --down     # stop everything (volumes preserved)
./up.sh --wipe     # full reset: down + wipe all volumes
./up.sh --rebuild  # nuke the npm-deps volume and rebuild dev images
./up.sh --help     # inline usage
```

To light up real external services (Resend for email delivery, Solana RPC for SRPOW wrap), drop a `docker/dev.env.local` (gitignored) and re-run `./up.sh`. See [`docker/README.md`](./docker/README.md) for the full reference: service graph, secret layering, hot-reload notes, and SRPOW dev setup.

## Local dev (without Docker)

Requires Node 22 and Docker (for the Postgres container).

```bash
docker run --rm -d --name rpow-pg -e POSTGRES_PASSWORD=p -p 55432:5432 postgres:16
npm install
npm run build --workspace @rpow/shared
npm test
```

To run the stack with low difficulty for hands-on testing:

```bash
# In one terminal
DATABASE_URL=postgres://postgres:p@localhost:55432/postgres \
RESEND_API_KEY=re_test EMAIL_FROM='rpow2 <no-reply@rpow2.com>' \
SESSION_SECRET=$(openssl rand -hex 32) \
MAGIC_LINK_BASE_URL=http://localhost:8080 WEB_ORIGIN=http://localhost:5173 \
DIFFICULTY_BITS=20 DIFFICULTY_FLOOR=8 \
RPOW_TEST_INBOX=true \
$(node -e 'import("./apps/server/dist/signing.js").then(({generateKeypair})=>{const k=generateKeypair(); console.log("RPOW_SIGNING_PRIVATE_KEY_HEX="+k.privateHex+" RPOW_SIGNING_PUBLIC_KEY_HEX="+k.publicHex);})') \
npm --workspace @rpow/server run dev

# In another terminal
npm --workspace @rpow/web run dev
```

## Deploy

- Server: Fly.io (`api.rpow2.com`)
- Web: Netlify (`rpow2.com`)
- DB: Neon Postgres (serverless)
- Email: Resend
- DNS: GoDaddy (registrar)

See `docs/RUNBOOK.md` for operator instructions.

## Documentation

- High-level system docs: [`docs/overview/`](./docs/overview/README.md) — architecture, protocol, data model, mining/halving, SRPOW bridge, API reference, ops.
- Operator runbook: [`docs/RUNBOOK.md`](./docs/RUNBOOK.md).
- Canonical design specs: [`docs/superpowers/specs/`](./docs/superpowers/specs).
