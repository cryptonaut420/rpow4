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

if [[ "$INSTALL_DOCKER" == "1" ]] && ! command -v docker >/dev/null 2>&1; then
  echo "[deploy] Docker not found; installing Docker Engine..."
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg openssl
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo systemctl enable --now docker
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

if ! command -v openssl >/dev/null 2>&1; then
  echo "[deploy] openssl not found; installing it for secret generation..."
  sudo apt-get update
  sudo apt-get install -y openssl
fi

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
  POSTGRES_PASSWORD="$(openssl rand -base64 36 | tr -d '\n')"
  SESSION_SECRET="$(openssl rand -hex 32)"
  KEY_LINES="$(
    "${DOCKER[@]}" run --rm node:22-alpine node -e "const {generateKeyPairSync}=require('node:crypto'); const {publicKey,privateKey}=generateKeyPairSync('ed25519'); const priv=privateKey.export({format:'der',type:'pkcs8'}).subarray(-32).toString('hex'); const pub=publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex'); console.log('RPOW_SIGNING_PRIVATE_KEY_HEX='+priv); console.log('RPOW_SIGNING_PUBLIC_KEY_HEX='+pub);"
  )"
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
else
  echo "[deploy] using existing $ENV_FILE (not overwriting secrets)"
fi

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

Web: https://$WEB_HOST
API: https://$API_HOST

Let's Encrypt issuance can take a minute on first boot. Check:
  docker compose --env-file $ENV_FILE -f $COMPOSE_FILE logs -f acme-companion

Useful commands:
  ./deploy-aws-ec2.sh --logs
  ./deploy-aws-ec2.sh --down
  docker compose --env-file $ENV_FILE -f $COMPOSE_FILE ps

Back up regularly:
  docker compose --env-file $ENV_FILE -f $COMPOSE_FILE exec -T db pg_dump -U rpow rpow > rpow4-\$(date +%F).sql

EOF
