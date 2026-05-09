# AWS EC2 Production Deploy

This is the simple production path for running RPOW4 on a fresh Ubuntu EC2
server with Docker, `nginx-proxy`, and automatic Let's Encrypt certificates.

## DNS

Point both records at the EC2 public IP before the first deploy:

| Host | Type | Value |
|---|---|---|
| `rpow4.com` | `A` / `AAAA` | EC2 public IP |
| `api.rpow4.com` | `A` / `AAAA` | EC2 public IP |

The EC2 security group must allow inbound TCP `80` and `443` for the site, plus
`22` for SSH.

## Deploy

From the repo root on the EC2 host:

```bash
./deploy-aws-ec2.sh
```

The script installs Docker on Ubuntu when needed, creates
`ops/aws-ec2/prod.env` on first run with fresh secrets/signing keys, builds the
app images, starts Postgres, the API, the SPA, `nginx-proxy`, and the ACME
companion.

It never overwrites existing secrets in `prod.env`. On redeploy, it also appends
any newly introduced default env vars that are missing, then rebuilds and
restarts the stack. Edit `prod.env` directly only if you want to change domains,
email, difficulty settings, or other production values.

On EC2, the script also tries to detect the instance public IPv4 and compares it
to DNS. If Cloudflare proxying is enabled, DNS will show Cloudflare IPs instead
of the EC2 origin; that is expected. DNS or security group mistakes will not
corrupt the deploy, but Let's Encrypt cannot issue certs until ports `80` and
`443` are publicly reachable through Cloudflare to the origin.

For Cloudflare, use **Full** or **Full (strict)** SSL/TLS mode after the origin
certificate is issued. If first-time Let's Encrypt issuance stalls, temporarily
disable "Always Use HTTPS" or proxying for the host, rerun `./deploy-aws-ec2.sh`,
then re-enable the proxy after certs exist.

## Daily Commands

```bash
./deploy-aws-ec2.sh --logs      # follow logs
./deploy-aws-ec2.sh --down      # stop containers, keep volumes

docker compose --env-file ops/aws-ec2/prod.env -f ops/aws-ec2/compose.prod.yaml ps
docker compose --env-file ops/aws-ec2/prod.env -f ops/aws-ec2/compose.prod.yaml logs -f acme-companion
```

To deploy a new git revision, pull it on the server and run the same script
again. Compose rebuilds the app images and keeps the Postgres volume intact.

## Backups

Postgres data lives in a Docker volume. Also keep logical dumps somewhere off
the instance:

```bash
docker compose --env-file ops/aws-ec2/prod.env -f ops/aws-ec2/compose.prod.yaml exec -T db \
  pg_dump -U rpow rpow > rpow4-$(date +%F).sql
```

The generated `prod.env` contains the server signing key and session secret.
Back it up securely; do not commit it.

## Adding More Apps

This stack is ready for additional subdomains. Add another container to this or
another Compose project on the same Docker host with:

```yaml
environment:
  VIRTUAL_HOST: subdomain.rpow4.com
  VIRTUAL_PORT: "8080"
  LETSENCRYPT_HOST: subdomain.rpow4.com
  LETSENCRYPT_EMAIL: you@example.com
```

Attach that container to the same Docker network as `nginx-proxy`, or run it in
this Compose file.
