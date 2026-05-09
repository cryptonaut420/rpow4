# Operator Runbook

## Where things live

- **Server**: VPS (Ubuntu, kernel 6.x). Replace `<vps-host>` below with your SSH target (e.g. `ubuntu@<ip>`).
- **Web SPA**: Netlify, deployed automatically from `main`.
- **DB**: PostgreSQL 17 on the same VPS, Unix-socket-only at `/var/run/postgresql`.
- **DNS**: Cloudflare, zone `rpow4.com`. `api.rpow4.com` is DNS-only (proxy off, TTL 60); apex and `www` stay proxied.
- **Backups**: restic → Backblaze B2 bucket (configured in `/etc/rpow/restic.env`), nightly at 03:00 UTC.

## One-page health check

```bash
ssh <vps-host> 'sudo /usr/local/bin/rpow-status'
```

## Service recovery

Three layers (every layer has been tested):

| Failure mode | Recovery |
|---|---|
| node process crashes / clean exit | systemd restarts in ~2s (`Restart=always`, `RestartSec=2`, up to 10 starts per 5min before pause) |
| node process hung but alive (deadlock, infinite loop) | `rpow-healthcheck.timer` probes `/health` every 90s; after 2 consecutive failures, runs `systemctl restart rpow-server`. Logs to `journalctl -t rpow-healthcheck` |
| nginx / Postgres crash | distro systemd units auto-restart |
| VPS reboot | all rpow services + nginx + postgresql + ufw + fail2ban + certbot.timer + rpow-backup.timer + rpow-healthcheck.timer are `enabled` — they come back on boot |
| TLS cert expiry | `certbot.timer` renews 30 days before expiry, fully unattended via Cloudflare DNS-01 |
| Backup repo corruption | restic does a 5% read-data integrity check on every nightly run; restore drill documented below |

**Recommended addition (not yet wired)**: an external uptime monitor (e.g. UptimeRobot or healthchecks.io) hitting `https://api.rpow4.com/health` every minute, paging when 3+ consecutive failures. The VPS-internal watchdog can't help if the whole box is dead — only an off-box monitor can.

To inspect the watchdog's recent activity:
```bash
ssh <vps-host> 'sudo journalctl -t rpow-healthcheck --since "1 hour ago"'
```

## Logs

```bash
ssh <vps-host> 'sudo journalctl -u rpow-server -f'
ssh <vps-host> 'sudo tail -f /var/log/nginx/api.rpow4.com.access.log'
ssh <vps-host> 'sudo tail -f /var/log/nginx/api.rpow4.com.error.log'
ssh <vps-host> 'sudo tail -f /var/log/postgresql/postgresql-17-main.log'
```

## Deploys

```bash
ssh <vps-host> '
  sudo -u rpow bash -c "cd /opt/rpow/repo && \
    git pull origin main && \
    npm ci --workspaces --include-workspace-root --ignore-scripts && \
    npm run build --workspace @rpow/shared && \
    npm run build --workspace @rpow/server" && \
  sudo systemctl restart rpow-server'
```

## Secrets / config files

| File | Mode | Owner | Purpose |
|---|---|---|---|
| `/etc/rpow/server.env` | 0640 | root:rpow | App env (DATABASE_URL, signing keys, etc.) |
| `/etc/rpow/restic.env` | 0600 | root:root | B2 creds + restic password |
| `/etc/letsencrypt/cloudflare.ini` | 0600 | root:root | Cloudflare API token for DNS-01 |

After editing `server.env`: `sudo systemctl restart rpow-server`.

## Tokenomics knobs

The RPOW4 schedule is parameterized by env so the operator can adjust dev/staging without code changes. **In production these defaults match the published 21M / 50-RPOW / 210k-block schedule and should not be changed without an explicit version bump.**

| Env var | Default | Effect |
|---|---|---|
| `DIFFICULTY_BITS` | 24 | Initial trailing-zero-bit difficulty. The schedule starts here at block 0 and steps up over time. |
| `DIFFICULTY_STEP_BLOCKS` | 164062 | Blocks between +1-bit difficulty steps. |
| `DIFFICULTY_MAX_BITS` | 50 | Hard ceiling on stamped difficulty. |
| `MINT_BASE_REWARD_BASE_UNITS` | 50000000000 | Initial reward per accepted PoW (= 50 RPOW × 10⁹). |
| `HALVING_INTERVAL_BLOCKS` | 210000 | Blocks between reward halvings. |
| `MINT_MAX_SUPPLY` | 21000000 | Hard cap in whole RPOW. |
| `SIGNUP_DIFFICULTY_BITS` | 18 | Anti-spam PoW for `/signup`. |

Lower difficulty for a hands-on test session:

```bash
ssh <vps-host> '
  sudo sed -i "s/^DIFFICULTY_BITS=.*/DIFFICULTY_BITS=20/" /etc/rpow/server.env && \
  sudo systemctl restart rpow-server'
```

## Backup operations

- **Nightly**: `rpow-backup.timer` at 03:00 UTC (with up to 5min jitter).
- **Manual**: `ssh <vps-host> 'sudo /usr/local/bin/rpow-backup'`
- **Restore drill**: `ssh <vps-host> 'sudo /usr/local/bin/rpow-restore-test'` — restores latest snapshot into a scratch DB and prints row counts. Run weekly to keep restic + creds healthy.
- **List snapshots**: `ssh <vps-host> 'sudo bash -c "set -a; . /etc/rpow/restic.env; set +a; restic snapshots"'`
- **Retention**: 7 daily, 4 weekly, 6 monthly. 5% read-data integrity check on each backup.

## TLS renewals

Auto-renewing via certbot's systemd timer. No human action needed.

```bash
ssh <vps-host> 'systemctl list-timers certbot.timer'
ssh <vps-host> 'sudo certbot renew --dry-run'   # exercise the flow
```

## Rotating the signing key

Edit `RPOW_SIGNING_PRIVATE_KEY_HEX` and `RPOW_SIGNING_PUBLIC_KEY_HEX` in `/etc/rpow/server.env`, then `sudo systemctl restart rpow-server`. Existing minted tokens become unverifiable if the private key changes — coordinate carefully.

## Database access

```bash
# Read-only inspection as ubuntu
ssh <vps-host> 'sudo -u postgres psql rpow'

# As the rpow_app role over Unix socket (password from .env.vps locally)
DBPW=$(grep '^RPOW_DB_PASSWORD=' .env.vps | cut -d= -f2-)
ssh <vps-host> "PGPASSWORD='$DBPW' psql -h /var/run/postgresql -U rpow_app -d rpow"
```

## Cloudflare DNS records

The operational scripts (`ops/dns-flip.sh`, `ops/cutover.sh`) take zone + record IDs from env. Populate them when you provision the rpow4 zone:

```bash
export ZONE_ID=<rpow4 zone id>
export A_REC_ID=<api.rpow4.com A record id>
export AAAA_REC_ID=<api.rpow4.com AAAA record id>   # or set to a dummy + drop AAAA via VPS_IPV6=NONE
```

## Incident: VPS down or compromised

- Cloudflare DNS will not auto-failover. Existing backups are in B2.
- Recovery sequence: provision new VPS, replay the host setup steps, then `restic restore` the latest snapshot into a fresh `rpow` DB, then flip DNS A/AAAA via the Cloudflare API.
- Cert can be re-issued in minutes via DNS-01 (token already in CF; just put it back at `/etc/letsencrypt/cloudflare.ini`).
