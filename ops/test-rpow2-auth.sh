#!/usr/bin/env bash
# Test the RPOW2 session cookie by hitting the RPOW2 API directly.
#
# Run from the repo root:
#
#     ./ops/test-rpow2-auth.sh
#
# If api.rpow2.com is behind Cloudflare bot protection you will need to also
# set RPOW2_CF_CLEARANCE in your env file. To get it:
#   1. Open the RPOW2 API URL in your browser:
#        https://api.rpow2.com/activity?since=2020-01-01T00:00:00Z
#   2. Complete the Cloudflare challenge (usually auto-solved)
#   3. Open DevTools > Application > Cookies > api.rpow2.com
#   4. Copy the value of the 'cf_clearance' cookie
#   5. Add to your env file:
#        RPOW2_CF_CLEARANCE=<the value you copied>
#   6. Re-run this script and restart the server
#
# Auto-detects prod vs dev environment the same way the other ops scripts do.
# Exits 0 if the API responds with HTTP 200, non-zero otherwise.

set -euo pipefail
cd "$(dirname "$0")/.."

# ── Load env ──────────────────────────────────────────────────────────────────
ENV_FILE=""
if [[ -f ops/aws-ec2/prod.env ]]; then
  ENV_FILE="ops/aws-ec2/prod.env"
  MODE=prod
elif [[ -f .env ]]; then
  ENV_FILE=".env"
  MODE=dev
fi

if [[ -z "$ENV_FILE" ]]; then
  echo "no env file found (tried ops/aws-ec2/prod.env and .env)" >&2
  exit 1
fi

# Parse key=value pairs, stripping surrounding quotes and ignoring comments.
parse_env_var() {
  local key="$1"
  local file="$2"
  grep -m1 "^${key}=" "$file" \
    | sed "s/^${key}=//" \
    | sed 's/^"\(.*\)"$/\1/' \
    | sed "s/^'\(.*\)'$/\1/"
}

RPOW2_API_BASE_URL=$(parse_env_var RPOW2_API_BASE_URL "$ENV_FILE")
RPOW2_SESSION_COOKIE=$(parse_env_var RPOW2_SESSION_COOKIE "$ENV_FILE")
RPOW2_CF_CLEARANCE=$(parse_env_var RPOW2_CF_CLEARANCE "$ENV_FILE" || true)

# Default base URL if not set
RPOW2_API_BASE_URL="${RPOW2_API_BASE_URL:-https://api.rpow2.com}"

# Strip any trailing Set-Cookie attributes (same logic as env.ts transform)
RPOW2_SESSION_COOKIE="${RPOW2_SESSION_COOKIE%%;*}"
RPOW2_SESSION_COOKIE="${RPOW2_SESSION_COOKIE## }"
RPOW2_SESSION_COOKIE="${RPOW2_SESSION_COOKIE%% }"

if [[ -z "$RPOW2_SESSION_COOKIE" ]]; then
  echo "RPOW2_SESSION_COOKIE is not set in $ENV_FILE" >&2
  exit 1
fi

# Build the combined cookie header, mirroring the logic in Rpow2Client.
# Strip Set-Cookie HTTP attributes (Path, Domain, Max-Age, SameSite, Secure, HttpOnly)
# then decide whether to use cfClearance as the full cookie or append it.
strip_cookie_attrs() {
  local raw="$1"
  echo "$raw" \
    | tr ';' '\n' \
    | sed 's/^ *//;s/ *$//' \
    | grep -ivE '^(path|domain|max-age|samesite|expires)=' \
    | grep -ivE '^(secure|httponly)$' \
    | grep -v '^$' \
    | paste -sd '; '
}

COOKIE_HEADER="$RPOW2_SESSION_COOKIE"
if [[ -n "$RPOW2_CF_CLEARANCE" ]]; then
  CF_PAIRS=$(strip_cookie_attrs "$RPOW2_CF_CLEARANCE")
  if echo "$CF_PAIRS" | grep -q "rpow_session="; then
    # cfClearance already contains a fresh session — use it as the full header
    COOKIE_HEADER="$CF_PAIRS"
  elif echo "$CF_PAIRS" | grep -q "^cf_clearance="; then
    COOKIE_HEADER="${RPOW2_SESSION_COOKIE}; ${CF_PAIRS}"
  else
    COOKIE_HEADER="${RPOW2_SESSION_COOKIE}; cf_clearance=${CF_PAIRS}"
  fi
fi

# ── Test ──────────────────────────────────────────────────────────────────────
SINCE="2020-01-01T00:00:00Z"
URL="${RPOW2_API_BASE_URL}/activity?since=${SINCE}"

echo "mode        : $MODE"
echo "env file    : $ENV_FILE"
echo "url         : $URL"
echo "session     : ${RPOW2_SESSION_COOKIE:0:40}…"
if [[ -n "$RPOW2_CF_CLEARANCE" ]]; then
  echo "cf_clearance: ${RPOW2_CF_CLEARANCE:0:20}… (set)"
else
  echo "cf_clearance: (not set)"
fi
echo ""

HTTP_CODE=$(curl -s -o /tmp/rpow2-auth-test.json -w "%{http_code}" \
  -H "Cookie: ${COOKIE_HEADER}" \
  -H "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" \
  -H "Accept: application/json, text/plain, */*" \
  -H "Accept-Language: en-US,en;q=0.9" \
  "$URL")

BODY=$(cat /tmp/rpow2-auth-test.json)

echo "HTTP status: $HTTP_CODE"
echo ""
echo "Response body (first 1000 chars):"
echo "$BODY" | head -c 1000
echo ""

if [[ "$HTTP_CODE" == "200" ]]; then
  echo ""
  echo "✓ Cookie is valid — the RPOW2 API accepted the session."
  exit 0
elif echo "$BODY" | grep -qi "cloudflare\|just a moment\|cf-ray\|challenges.cloudflare"; then
  echo ""
  echo "✗ Blocked by Cloudflare bot protection."
  echo ""
  echo "  Cloudflare validates BOTH the cf_clearance cookie AND the TLS fingerprint"
  echo "  (JA3 hash) of the client. Browser cookies won't bypass non-browser HTTP"
  echo "  clients (Node.js, curl) because their TLS signatures differ from Chrome's."
  echo ""
  echo "  RECOMMENDED FIX — ask the rpow2.com team to whitelist your server's IP:"
  echo "    1. Find your EC2 public IP:"
  echo "         curl -s https://api.ipify.org"
  echo "    2. Ask the rpow2.com team to add that IP to their Cloudflare IP allowlist"
  echo "       (Cloudflare dashboard → Security → WAF → IP Access Rules → Allow)"
  echo "    3. Once whitelisted, re-run this script — no cf_clearance needed"
  echo ""
  echo "  ALTERNATIVE — if you are running this from the production server's IP and"
  echo "  the whitelist has been applied, a cf_clearance may no longer be required."
  exit 1
elif [[ "$HTTP_CODE" == "401" ]]; then
  echo ""
  echo "✗ 401 Unauthorized — session cookie is expired or invalid."
  echo "  Log in to rpow2.com as the banker account, grab the new"
  echo "  'rpow_session=…' cookie, and update RPOW2_SESSION_COOKIE in $ENV_FILE."
  exit 1
elif [[ "$HTTP_CODE" == "403" ]]; then
  echo ""
  echo "✗ 403 Forbidden — the banker account may not have API access."
  echo "  Check that RPOW2_BANKER_EMAIL is the correct banker account on rpow2.com."
  exit 1
else
  echo ""
  echo "✗ Unexpected HTTP $HTTP_CODE — check the response body above."
  exit 1
fi
