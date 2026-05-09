#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_DIR="$ROOT_DIR/ops/aws-ec2"
ENV_FILE="$OPS_DIR/prod.env"
COMPOSE_FILE="$OPS_DIR/compose.prod.yaml"

WEB_HOST="${WEB_HOST:-rpow4.com}"
API_HOST="${API_HOST:-api.rpow4.com}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-admin@rpow4.com}"
INSTALL_DOCKER=1
ACTION=deploy
PUBLIC_IPV4=""

usage() {
  cat <<EOF
Usage: ./deploy-aws-ec2.sh [options]

Bootstrap and deploy RPOW4 on an Ubuntu AWS EC2 host using Docker Compose.

Options:
  --domain HOST          Web hostname (default: rpow4.com)
  --api-domain HOST      API hostname (default: api.rpow4.com)
  --email EMAIL          Let's Encrypt email (default: admin@rpow4.com)
  --no-install-docker    Skip Docker installation check/install
  --down                 Stop the production stack (volumes preserved)
  --logs                 Tail production logs
  --help                 Show this help

DNS before first run:
  A/AAAA  WEB_HOST -> this EC2 public IP
  A/AAAA  API_HOST -> this EC2 public IP

EC2 security group:
  allow inbound TCP 22, 80, 443
EOF
}

env_has_key() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] && grep -Eq "^${key}=" "$ENV_FILE"
}

env_get() {
  local key="$1"
  local fallback="$2"
  if [[ -f "$ENV_FILE" ]] && env_has_key "$key"; then
    grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-
  else
    printf '%s' "$fallback"
  fi
}

append_env_if_missing() {
  local key="$1"
  local value="$2"
  if ! env_has_key "$key"; then
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    echo "[deploy] added missing env: $key"
  fi
}

generate_signing_keypair() {
  "${DOCKER[@]}" run --rm node:22-alpine node -e "const {generateKeyPairSync}=require('node:crypto'); const {publicKey,privateKey}=generateKeyPairSync('ed25519'); const priv=privateKey.export({format:'der',type:'pkcs8'}).subarray(-32).toString('hex'); const pub=publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex'); console.log('RPOW_SIGNING_PRIVATE_KEY_HEX='+priv); console.log('RPOW_SIGNING_PUBLIC_KEY_HEX='+pub);"
}

sudo_cmd() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

ensure_host_tools() {
  local missing=()
  for bin in curl gpg openssl; do
    if ! command -v "$bin" >/dev/null 2>&1; then
      missing+=("$bin")
    fi
  done

  if [[ "${#missing[@]}" -gt 0 ]]; then
    echo "[deploy] installing required host tools..."
    sudo_cmd apt-get update
    sudo_cmd apt-get install -y ca-certificates curl gnupg openssl
  fi
}

detect_public_ipv4() {
  local token
  token="$(curl -fsS -m 2 -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null || true)"

  if [[ -n "$token" ]]; then
    curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $token" \
      "http://169.254.169.254/latest/meta-data/public-ipv4" 2>/dev/null || true
    return
  fi

  curl -fsS -m 2 "http://169.254.169.254/latest/meta-data/public-ipv4" 2>/dev/null || true
}

dns_ipv4s() {
  local host="$1"
  getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true
}

preflight_dns() {
  local web_host="$1"
  local api_host="$2"

  PUBLIC_IPV4="$(detect_public_ipv4)"
  if [[ -z "$PUBLIC_IPV4" ]]; then
    echo "[deploy] could not detect EC2 public IPv4; skipping DNS match check"
    echo "[deploy] make sure $web_host and $api_host point at this server before expecting SSL"
    return
  fi

  echo "[deploy] detected EC2 public IPv4: $PUBLIC_IPV4"

  local web_ips api_ips
  web_ips="$(dns_ipv4s "$web_host")"
  api_ips="$(dns_ipv4s "$api_host")"

  if [[ " $web_ips " != *" $PUBLIC_IPV4 "* ]]; then
    echo "[deploy] note: $web_host does not currently resolve directly to $PUBLIC_IPV4"
    echo "[deploy]          current A records: ${web_ips:-none found}"
    echo "[deploy]          this is expected when Cloudflare proxy is enabled"
  fi

  if [[ " $api_ips " != *" $PUBLIC_IPV4 "* ]]; then
    echo "[deploy] note: $api_host does not currently resolve directly to $PUBLIC_IPV4"
    echo "[deploy]          current A records: ${api_ips:-none found}"
    echo "[deploy]          this is expected when Cloudflare proxy is enabled"
  fi
}

sync_existing_env() {
  echo "[deploy] checking $ENV_FILE for missing defaults..."

  append_env_if_missing COMPOSE_PROJECT_NAME rpow4-prod
  append_env_if_missing WEB_HOST "$WEB_HOST"
  append_env_if_missing API_HOST "$API_HOST"
  append_env_if_missing LETSENCRYPT_EMAIL "$LETSENCRYPT_EMAIL"

  append_env_if_missing NODE_ENV production
  append_env_if_missing PORT 8080
  append_env_if_missing WEB_ORIGIN "https://$(env_get WEB_HOST "$WEB_HOST")"
  append_env_if_missing TRUST_PROXY true

  append_env_if_missing DATABASE_POOL_MAX 30
  append_env_if_missing DATABASE_STATEMENT_TIMEOUT_MS 5000
  if ! env_has_key POSTGRES_PASSWORD; then
    append_env_if_missing POSTGRES_PASSWORD "$(openssl rand -hex 32)"
  fi
  append_env_if_missing DATABASE_URL "postgres://rpow:$(env_get POSTGRES_PASSWORD "")@db:5432/rpow"

  if ! env_has_key SESSION_SECRET; then
    append_env_if_missing SESSION_SECRET "$(openssl rand -hex 32)"
  fi
  if ! env_has_key RPOW_SIGNING_PRIVATE_KEY_HEX || ! env_has_key RPOW_SIGNING_PUBLIC_KEY_HEX; then
    local key_lines private_key public_key
    key_lines="$(generate_signing_keypair)"
    private_key="$(printf '%s\n' "$key_lines" | awk -F= '/RPOW_SIGNING_PRIVATE_KEY_HEX/ {print $2}')"
    public_key="$(printf '%s\n' "$key_lines" | awk -F= '/RPOW_SIGNING_PUBLIC_KEY_HEX/ {print $2}')"
    append_env_if_missing RPOW_SIGNING_PRIVATE_KEY_HEX "$private_key"
    append_env_if_missing RPOW_SIGNING_PUBLIC_KEY_HEX "$public_key"
  fi

  append_env_if_missing DIFFICULTY_BITS 24
  append_env_if_missing DIFFICULTY_STEP_BLOCKS 50000
  append_env_if_missing DIFFICULTY_MAX_BITS 50
  append_env_if_missing SIGNUP_DIFFICULTY_BITS 18
  append_env_if_missing MINT_BASE_REWARD_BASE_UNITS 50000000000
  append_env_if_missing HALVING_INTERVAL_BLOCKS 210000
  append_env_if_missing MINT_MAX_SUPPLY 21000000
  append_env_if_missing SEND_BASE_FEE_BASE_UNITS 1000000000

  append_env_if_missing FAUCET_ENABLED true
  append_env_if_missing FAUCET_CLAIM_AMOUNT_BASE_UNITS 5000000000
  append_env_if_missing FAUCET_COOLDOWN_HOURS 24
  append_env_if_missing TROLLBOX_POST_FEE_BASE_UNITS 5000000000

  chmod 600 "$ENV_FILE" 2>/dev/null || true
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      WEB_HOST="${2:?missing value for --domain}"
      shift 2
      ;;
    --api-domain)
      API_HOST="${2:?missing value for --api-domain}"
      shift 2
      ;;
    --email)
      LETSENCRYPT_EMAIL="${2:?missing value for --email}"
      shift 2
      ;;
    --no-install-docker)
      INSTALL_DOCKER=0
      shift
      ;;
    --down)
      ACTION=down
      shift
      ;;
    --logs)
      ACTION=logs
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

ensure_host_tools

if [[ "$INSTALL_DOCKER" == "1" ]] && ! command -v docker >/dev/null 2>&1; then
  echo "[deploy] Docker not found; installing Docker Engine..."
  sudo_cmd install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo_cmd gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo_cmd chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    | sudo_cmd tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo_cmd apt-get update
  sudo_cmd apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo_cmd systemctl enable --now docker
fi

DOCKER=(docker)
if ! "${DOCKER[@]}" info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
  else
    echo "[deploy] Docker is installed but this user cannot access the daemon." >&2
    echo "[deploy] Re-run with sudo, or add the user to the docker group and start a new shell." >&2
    exit 1
  fi
fi

if ! "${DOCKER[@]}" compose version >/dev/null 2>&1; then
  echo "[deploy] docker compose plugin is required but not available." >&2
  exit 1
fi

mkdir -p "$OPS_DIR"

if [[ "$ACTION" == "down" ]]; then
  "${DOCKER[@]}" compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" down
  exit 0
fi

if [[ "$ACTION" == "logs" ]]; then
  "${DOCKER[@]}" compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs -f --tail=200
  exit 0
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[deploy] creating $ENV_FILE with fresh secrets..."
  umask 077
  POSTGRES_PASSWORD="$(openssl rand -hex 32)"
  SESSION_SECRET="$(openssl rand -hex 32)"
  KEY_LINES="$(generate_signing_keypair)"
  RPOW_SIGNING_PRIVATE_KEY_HEX="$(printf '%s\n' "$KEY_LINES" | awk -F= '/RPOW_SIGNING_PRIVATE_KEY_HEX/ {print $2}')"
  RPOW_SIGNING_PUBLIC_KEY_HEX="$(printf '%s\n' "$KEY_LINES" | awk -F= '/RPOW_SIGNING_PUBLIC_KEY_HEX/ {print $2}')"

  cat > "$ENV_FILE" <<EOF
COMPOSE_PROJECT_NAME=rpow4-prod

WEB_HOST=$WEB_HOST
API_HOST=$API_HOST
LETSENCRYPT_EMAIL=$LETSENCRYPT_EMAIL

NODE_ENV=production
PORT=8080
WEB_ORIGIN=https://$WEB_HOST
TRUST_PROXY=true

DATABASE_POOL_MAX=30
DATABASE_STATEMENT_TIMEOUT_MS=5000
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
DATABASE_URL=postgres://rpow:$POSTGRES_PASSWORD@db:5432/rpow

SESSION_SECRET=$SESSION_SECRET
RPOW_SIGNING_PRIVATE_KEY_HEX=$RPOW_SIGNING_PRIVATE_KEY_HEX
RPOW_SIGNING_PUBLIC_KEY_HEX=$RPOW_SIGNING_PUBLIC_KEY_HEX

DIFFICULTY_BITS=24
DIFFICULTY_STEP_BLOCKS=50000
DIFFICULTY_MAX_BITS=50
SIGNUP_DIFFICULTY_BITS=18
MINT_BASE_REWARD_BASE_UNITS=50000000000
HALVING_INTERVAL_BLOCKS=210000
MINT_MAX_SUPPLY=21000000
SEND_BASE_FEE_BASE_UNITS=1000000000

FAUCET_ENABLED=true
FAUCET_CLAIM_AMOUNT_BASE_UNITS=5000000000
FAUCET_COOLDOWN_HOURS=24
TROLLBOX_POST_FEE_BASE_UNITS=5000000000
EOF
  chmod 600 "$ENV_FILE" 2>/dev/null || true
else
  echo "[deploy] using existing $ENV_FILE (not overwriting secrets)"
fi

sync_existing_env

EFFECTIVE_WEB_HOST="$(env_get WEB_HOST "$WEB_HOST")"
EFFECTIVE_API_HOST="$(env_get API_HOST "$API_HOST")"

preflight_dns "$EFFECTIVE_WEB_HOST" "$EFFECTIVE_API_HOST"

echo "[deploy] building and starting production stack..."
"${DOCKER[@]}" compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build

echo "[deploy] waiting for API container health..."
for i in {1..60}; do
  if "${DOCKER[@]}" compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T server node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  if [[ "$i" == "60" ]]; then
    echo "[deploy] API did not become healthy; showing recent logs" >&2
    "${DOCKER[@]}" compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail=120 server >&2
    exit 1
  fi
  sleep 2
done

cat <<EOF

[deploy] RPOW4 production stack is up.

Web: https://$EFFECTIVE_WEB_HOST
API: https://$EFFECTIVE_API_HOST

Let's Encrypt issuance can take a minute on first boot. Check:
  docker compose --env-file $ENV_FILE -f $COMPOSE_FILE logs -f acme-companion

Useful commands:
  ./deploy-aws-ec2.sh --logs
  ./deploy-aws-ec2.sh --down
  docker compose --env-file $ENV_FILE -f $COMPOSE_FILE ps

Back up regularly:
  docker compose --env-file $ENV_FILE -f $COMPOSE_FILE exec -T db pg_dump -U rpow rpow > rpow4-\$(date +%F).sql

EOF
