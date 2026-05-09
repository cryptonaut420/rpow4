#!/usr/bin/env bash
# Flip api.rpow4.com A (and AAAA if VPS_IPV6 is set) to point at VPS.
# Required env: CLOUDFLARE_API_TOKEN, VPS_IP, VPS_IPV6 (or "NONE"),
#               ZONE_ID, A_REC_ID, AAAA_REC_ID
set -euo pipefail

: "${ZONE_ID:?missing  (Cloudflare zone id for the rpow4 domain)}"
: "${A_REC_ID:?missing  (A record id for api.rpow4.com)}"
: "${AAAA_REC_ID:?missing  (AAAA record id for api.rpow4.com; pass dummy if unused)}"

: "${CLOUDFLARE_API_TOKEN:?missing}"
: "${VPS_IP:?missing}"
: "${VPS_IPV6:?missing  (use the literal string NONE if VPS has no IPv6)}"

api () { curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"; }

echo "Flipping A record to $VPS_IP..."
api -X PATCH --data "{\"content\": \"$VPS_IP\"}" \
    "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$A_REC_ID" \
  | jq -e '.success' > /dev/null
echo "  A flipped."

if [ "$VPS_IPV6" = "NONE" ]; then
    echo "Deleting AAAA record (VPS has no IPv6)..."
    api -X DELETE \
        "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$AAAA_REC_ID" \
      | jq -e '.success' > /dev/null
    echo "  AAAA deleted."
else
    echo "Flipping AAAA record to $VPS_IPV6..."
    api -X PATCH --data "{\"content\": \"$VPS_IPV6\"}" \
        "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$AAAA_REC_ID" \
      | jq -e '.success' > /dev/null
    echo "  AAAA flipped."
fi

echo
echo "Live records:"
api "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?name=api.rpow4.com" \
  | jq -r '.result[] | "  \(.type) \(.name) -> \(.content) (proxied=\(.proxied), ttl=\(.ttl))"'
