# rpow4

> A tribute to the original RPOW by Hal Finney.

A faithful modern recreation of Hal Finney's [Reusable Proofs of Work](https://nakamotoinstitute.org/finney/rpow/) (2004), Bitcoin-flavored. BIP-39 / SLIP-0010 wallet auth (no email), hashcash mining, maintained balance rows, per-action client signatures persisted on the ledger, public statistics. **50 RPOW initial reward, halving every 210,000 blocks, hard 21,000,000 cap, no founder allocation.**

## Lineage

Standing on the shoulders of the projects that came before:

- **[rpow2.com](https://rpow2.com)** — the original community revival of Hal Finney's RPOW concept.
- **[rpow3.com](https://rpow3.com)** — the next iteration that kept the torch lit.
- **[github.com/frkrueger/rpow](https://github.com/frkrueger/rpow)** — Frederik Krueger's open-source reference implementation, an invaluable starting point.

### What's different / new in rpow4

- **Wallet-native auth.** Username/password + BIP-39 mnemonic + classic public/private keypair, with a PoW challenge gating sign-in. No email, no magic links, no SMTP server to babysit.
- **Bitcoin-style tokenomics.** No premine, no founder allocation, no team wallet. 50 RPOW initial reward, halving every 210,000 blocks, 21,000,000 hard cap. Difficulty steps up automatically and is capped at 50 bits so the simulation can't be wedged.
- **Refreshed UI/UX.** Modern design system, responsive layout, in-browser miner with live visualizer, and 6 color themes (default, amber, green, ice, rose, violet).
- **Claim tokens.** Bearer claim tokens for true off-platform / offline sends — closer in spirit to Hal Finney's original "reusable" PoW where the token itself was the artifact you handed over.
- **Transaction fees.** Send fee that halves alongside the block reward, paid into a treasury pubkey on-ledger.
- **Decimal sends.** 9 decimal places (10⁹ base units per RPOW), so you can send fractional amounts.
- **Memo field** on sends and claims, persisted on the ledger.
- **Faucet** — bootstraps new wallets so new users can try sends/claims without mining first.
- **Trollbox** — signed public chat module, because what's a coin community without one.
- **Block explorer** — browse blocks, transfers, claims, and account histories.
- **Leaderboards** — richest accounts and top miners, refreshed live on the Stats page.
- **Public API docs** — every route documented in-app, signing rules included.
- **In-app History tab** — Hal Finney's RPOW writings, the cypherpunk manifestos, the Bitcoin white paper, and other primary sources, all read-along inside the SPA. Worth your time.
- **Improvements across every other module** the predecessors shipped — mining loop, ledger consistency, observability, deploy story (one-shot AWS EC2 script + Let's Encrypt).
- **Much more to come.**

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
DIFFICULTY_BITS=14 \
$(node -e 'import("./apps/server/dist/signing.js").then(({generateKeypair})=>{const k=generateKeypair(); console.log("RPOW_SIGNING_PRIVATE_KEY_HEX="+k.privateHex+" RPOW_SIGNING_PUBLIC_KEY_HEX="+k.publicHex);})') \
npm --workspace @rpow/server run dev

# In another terminal
npm --workspace @rpow/web run dev
```

## Tokenomics

RPOW4 mirrors Bitcoin's issuance curve, sped up by removing the 10-minute block-time enforcement. The simulation runs as fast as the network can mine; difficulty is the only governor.

| Parameter                      | Value                                  |
|--------------------------------|----------------------------------------|
| Hard supply cap                | 21,000,000 RPOW                        |
| Initial block reward           | 50 RPOW (= 50 × 10⁹ base units)        |
| Reward halving cadence         | every 210,000 blocks                   |
| Initial difficulty             | 24 trailing-zero bits (`DIFFICULTY_BITS`) |
| Difficulty step                | +1 bit every 50,000 blocks                |
| Difficulty ceiling             | 50 bits                                |
| Founder allocation / premine   | **none**                                |

1 successful PoW = 1 block. The reward and difficulty schedules are pure functions of the global `block_height` counter (a sibling of `minted_supply` in `app_counters`), so the curve is fully deterministic and queryable from `/ledger`.

## Deploy

For a fresh Ubuntu AWS EC2 server:

```bash
git clone <this repo>
cd rpow
./deploy-aws-ec2.sh
```

That brings up Postgres, the API, the built SPA, `nginx-proxy`, and automatic
Let's Encrypt certificates for `rpow4.com` and `api.rpow4.com`. See
[`ops/aws-ec2/README.md`](./ops/aws-ec2/README.md) and
[`docs/RUNBOOK.md`](./docs/RUNBOOK.md) for operator instructions.

## Documentation

- High-level system docs: [`docs/overview/`](./docs/overview/README.md) — architecture, protocol, data model, mining/halving, API reference, ops.
- Operator runbook: [`docs/RUNBOOK.md`](./docs/RUNBOOK.md).
- Canonical design specs: [`docs/superpowers/specs/`](./docs/superpowers/specs).
