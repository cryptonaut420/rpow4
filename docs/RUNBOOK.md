# Operator Runbook

## Where things live

- **Host**: Ubuntu AWS EC2. Replace `<ec2-host>` below with your SSH target (for example `ubuntu@<ip>`).
- **Stack**: Docker Compose from `ops/aws-ec2/compose.prod.yaml`.
- **Web SPA**: Built into an nginx container and served at `https://rpow4.com`.
- **API**: Fastify/Node container served through `nginx-proxy` at `https://api.rpow4.com`.
- **DB**: PostgreSQL 17 container on an internal Docker network; data persists in the Compose `pg-data` volume.
- **TLS**: `nginxproxy/acme-companion` issues and renews Let's Encrypt certs.
- **Secrets**: `ops/aws-ec2/prod.env` on the server. This file is gitignored; back it up securely.

## One-page health check

```bash
ssh <ec2-host> 'cd /path/to/rpow && docker compose --env-file ops/aws-ec2/prod.env -f ops/aws-ec2/compose.prod.yaml ps'
curl -fsS https://api.rpow4.com/health
```

## Service recovery

Three layers (every layer has been tested):

| Failure mode | Recovery |
|---|---|
| node process crashes / clean exit | Docker restarts the `server` container (`restart: unless-stopped`) |
| nginx proxy / Postgres crash | Docker restarts the affected container (`restart: unless-stopped`) |
| EC2 reboot | Docker is enabled by the deploy script; containers with `restart: unless-stopped` come back after daemon start |
| TLS cert expiry | `acme-companion` renews Let's Encrypt certificates automatically |
| DB volume loss | Restore from a logical `pg_dump` backup |

**Recommended addition (not yet wired)**: an external uptime monitor (e.g. UptimeRobot or healthchecks.io) hitting `https://api.rpow4.com/health` every minute, paging when 3+ consecutive failures. The VPS-internal watchdog can't help if the whole box is dead — only an off-box monitor can.

To inspect the watchdog's recent activity:
```bash
ssh <ec2-host> 'cd /path/to/rpow && ./deploy-aws-ec2.sh --logs'
```

## Logs

```bash
ssh <ec2-host> 'cd /path/to/rpow && ./deploy-aws-ec2.sh --logs'
ssh <ec2-host> 'cd /path/to/rpow && docker compose --env-file ops/aws-ec2/prod.env -f ops/aws-ec2/compose.prod.yaml logs -f acme-companion'
```

## Deploys

```bash
ssh <ec2-host> '
  cd /path/to/rpow && \
  git pull origin main && \
  ./deploy-aws-ec2.sh'
```

## Secrets / config files

| File | Mode | Owner | Purpose |
|---|---|---|---|
| `ops/aws-ec2/prod.env` | 0600 recommended | deploy user | App env, DB password, signing keys, TLS email |

After editing `prod.env`: `./deploy-aws-ec2.sh`.

## Tokenomics knobs

The RPOW4 schedule is parameterized by env so the operator can adjust dev/staging without code changes. **In production these defaults match the published 21M / 50-RPOW / 210k-block schedule and should not be changed without an explicit version bump.**

| Env var | Default | Effect |
|---|---|---|
| `DIFFICULTY_BITS` | 24 | Initial trailing-zero-bit difficulty. The schedule starts here at block 0 and steps up over time. |
| `DIFFICULTY_STEP_BLOCKS` | 50000 | Blocks between +1-bit difficulty steps. |
| `DIFFICULTY_MAX_BITS` | 50 | Hard ceiling on stamped difficulty. |
| `MINT_BASE_REWARD_BASE_UNITS` | 50000000000 | Initial reward per accepted PoW (= 50 RPOW × 10⁹). |
| `HALVING_INTERVAL_BLOCKS` | 210000 | Blocks between reward halvings. |
| `MINT_MAX_SUPPLY` | 21000000 | Hard cap in whole RPOW. |
| `SIGNUP_DIFFICULTY_BITS` | 18 | Anti-spam PoW for `/signup`. |

Lower difficulty for a hands-on test session:

```bash
ssh <ec2-host> '
  cd /path/to/rpow && \
  sed -i "s/^DIFFICULTY_BITS=.*/DIFFICULTY_BITS=20/" ops/aws-ec2/prod.env && \
  ./deploy-aws-ec2.sh'
```

## Backup operations

Keep logical dumps somewhere off the instance:

```bash
ssh <ec2-host> 'cd /path/to/rpow && docker compose --env-file ops/aws-ec2/prod.env -f ops/aws-ec2/compose.prod.yaml exec -T db pg_dump -U rpow rpow' \
  > rpow4-$(date +%F).sql
```

Run restore drills regularly against a scratch Postgres database. Do not rely on
the Docker volume as the only backup.

## TLS renewals

Auto-renewing via `nginxproxy/acme-companion`. No human action needed when DNS
still points at the EC2 instance and ports `80`/`443` are reachable.

```bash
ssh <ec2-host> 'cd /path/to/rpow && docker compose --env-file ops/aws-ec2/prod.env -f ops/aws-ec2/compose.prod.yaml logs -f acme-companion'
```

## Rotating the signing key

Edit `RPOW_SIGNING_PRIVATE_KEY_HEX` and `RPOW_SIGNING_PUBLIC_KEY_HEX` in
`ops/aws-ec2/prod.env`, then run `./deploy-aws-ec2.sh`. Existing minted tokens
become unverifiable if the private key changes, so coordinate carefully.

## Database access

```bash
ssh <ec2-host> 'cd /path/to/rpow && docker compose --env-file ops/aws-ec2/prod.env -f ops/aws-ec2/compose.prod.yaml exec db psql -U rpow rpow'
```

## DNS Records

Point both records at the EC2 public IP before first deploy:

| Host | Type | Value |
|---|---|---|
| `rpow4.com` | `A` / `AAAA` | EC2 public IP |
| `api.rpow4.com` | `A` / `AAAA` | EC2 public IP |

## Incident: EC2 Down Or Compromised

- DNS will not auto-failover.
- Provision a new EC2 instance, clone the repo, restore `ops/aws-ec2/prod.env`,
  restore the latest Postgres dump, then point DNS at the new public IP.
- Certificates can be reissued by `acme-companion` once DNS and ports are live.
