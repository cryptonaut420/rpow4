# rpow2

> A tribute to the original RPOW by Hal Finney.

A faithful modern recreation of Hal Finney's [Reusable Proofs of Work](https://nakamotoinstitute.org/finney/rpow/) (2004). BIP-39/SLIP-0010 wallet auth (no email), hashcash mining, maintained balance rows, per-action client signatures persisted on the ledger, public statistics.

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

Auth is purely wallet-based: open the SPA, hit `/login`, and choose **Create new wallet** to generate a fresh BIP-39 mnemonic (or paste an existing one / a raw private key). The browser holds the secret key; the server only ever sees your public key and your signatures. Optionally encrypt the wallet to IndexedDB with a passphrase if you want it to survive a tab close.

```bash
./up.sh --down     # stop everything (volumes preserved)
./up.sh --wipe     # full reset: down + wipe all volumes
./up.sh --rebuild  # nuke the npm-deps volume and rebuild dev images
./up.sh --help     # inline usage
```

See [`docker/README.md`](./docker/README.md) for the full reference: service graph, secret layering, and hot-reload notes.

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
SESSION_SECRET=$(openssl rand -hex 32) \
WEB_ORIGIN=http://localhost:5173 \
DIFFICULTY_BITS=20 DIFFICULTY_FLOOR=8 \
$(node -e 'import("./apps/server/dist/signing.js").then(({generateKeypair})=>{const k=generateKeypair(); console.log("RPOW_SIGNING_PRIVATE_KEY_HEX="+k.privateHex+" RPOW_SIGNING_PUBLIC_KEY_HEX="+k.publicHex);})') \
npm --workspace @rpow/server run dev

# In another terminal
npm --workspace @rpow/web run dev
```

## Deploy

- Server: OVH VPS (`api.rpow2.com`), systemd-managed Node 22 behind nginx
- Web: Netlify (`rpow2.com`)
- DB: Postgres 17 on the same VPS, Unix-socket only
- DNS: Cloudflare

See `docs/RUNBOOK.md` for operator instructions.

## Documentation

- High-level system docs: [`docs/overview/`](./docs/overview/README.md) — architecture, protocol, data model, mining/halving, API reference, ops.
- Operator runbook: [`docs/RUNBOOK.md`](./docs/RUNBOOK.md).
- Canonical design specs: [`docs/superpowers/specs/`](./docs/superpowers/specs).
