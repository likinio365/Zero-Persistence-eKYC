#!/usr/bin/env bash
# End-to-end smoke test: login → create DID → submit KYC → poll status → query by DID
# Usage: ./scripts/test-kyc.sh [BASE_URL]
# Default BASE_URL: http://localhost:3000
#
# Credentials are read from env vars (falls back to .env defaults):
#   USER_USERNAME / USER_PASSWORD
#   VERIFIER_USERNAME / VERIFIER_PASSWORD

set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"

# Load .env if present so the script picks up local credentials automatically
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

USER_USERNAME="${USER_USERNAME:-user}"
USER_PASSWORD="${USER_PASSWORD:-user-pass}"
VERIFIER_USERNAME="${VERIFIER_USERNAME:-verifier}"
VERIFIER_PASSWORD="${VERIFIER_PASSWORD:-verifier-pass}"

# ── colours ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC}  $*"; }
info() { echo -e "${YELLOW}[..]${NC}  $*"; }
fail() { echo -e "${RED}[ERR]${NC} $*"; exit 1; }

# ── minimal 1×1 white PNG (valid image, accepted by the backend) ──────────────
PASSPORT_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjkB6QAAAABJRU5ErkJggg=="
SELFIE_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjkB6QAAAABJRU5ErkJggg=="
NID_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjkB6QAAAABJRU5ErkJggg=="

# ── helpers ───────────────────────────────────────────────────────────────────
get_field() { echo "$1" | python3 -c "import sys,json; print(json.load(sys.stdin)$2)"; }

# api <METHOD> <PATH> <TOKEN> [extra curl args...]
api() {
  local method="$1"; local path="$2"; local token="$3"; shift 3
  curl -s -X "$method" "${BASE_URL}${path}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${token}" \
    "$@"
}

login() {
  local username="$1"; local password="$2"
  local resp
  resp=$(curl -s -X POST "${BASE_URL}/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${username}\",\"password\":\"${password}\"}")
  local token
  token=$(get_field "$resp" "['token']") || fail "Login failed for '${username}': $resp"
  echo "$token"
}

# ── 1. health check (no auth needed) ─────────────────────────────────────────
info "Health check..."
HEALTH=$(curl -s "${BASE_URL}/health")
[ "$(get_field "$HEALTH" "['status']")" = "ok" ] || fail "Backend not healthy: $HEALTH"
ok "Backend is up"

# ── 2. login as user ──────────────────────────────────────────────────────────
info "Logging in as user ('${USER_USERNAME}')..."
USER_TOKEN=$(login "$USER_USERNAME" "$USER_PASSWORD")
ok "Got user token"

# ── 3. login as verifier ──────────────────────────────────────────────────────
info "Logging in as verifier ('${VERIFIER_USERNAME}')..."
VERIFIER_TOKEN=$(login "$VERIFIER_USERNAME" "$VERIFIER_PASSWORD")
ok "Got verifier token"

# ── 4. create DID (user token) ────────────────────────────────────────────────
info "Creating DID..."
DID_RESP=$(api POST /api/did "$USER_TOKEN")
RAW_DID=$(get_field "$DID_RESP" "['did']") || fail "createDID failed: $DID_RESP"
# ACA-Py returns a bare key (no did: prefix) for wallet_only DIDs.
# Wrap it in did:indy:test: to satisfy the chaincode DID format validator.
if [[ "$RAW_DID" == did:* ]]; then
  DID="$RAW_DID"
else
  DID="did:indy:test:${RAW_DID}"
fi
ok "DID created: $DID"

# ── 5. submit KYC (user token) ───────────────────────────────────────────────
info "Submitting KYC application..."
SUBMIT_BODY=$(cat <<EOF
{
  "did": "$DID",
  "documents": [
    { "type": "passport",    "fileName": "test-passport.png", "contentBase64": "$PASSPORT_B64" },
    { "type": "selfie",      "fileName": "test-selfie.png",   "contentBase64": "$SELFIE_B64"   },
    { "type": "national_id", "fileName": "test-nid.png",      "contentBase64": "$NID_B64"      }
  ]
}
EOF
)
SUBMIT_RESP=$(api POST /api/kyc "$USER_TOKEN" -d "$SUBMIT_BODY")
KYC_ID=$(get_field "$SUBMIT_RESP" "['id']") || fail "submitKYC failed: $SUBMIT_RESP"
ok "KYC submitted — ID: $KYC_ID"

# ── 6. check status (user token) ─────────────────────────────────────────────
info "Checking status..."
STATUS_RESP=$(api GET "/api/kyc/$KYC_ID" "$USER_TOKEN")
STATUS=$(get_field "$STATUS_RESP" "['status']")
[ "$STATUS" = "PENDING" ] || fail "Expected PENDING, got: $STATUS_RESP"
ok "Status: PENDING"

# ── 7. query by DID (user token) ─────────────────────────────────────────────
info "Querying by DID..."
ENCODED_DID=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$DID', safe=''))")
DID_RECORDS=$(api GET "/api/kyc/did/${ENCODED_DID}" "$USER_TOKEN")
COUNT=$(echo "$DID_RECORDS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
[ "$COUNT" -ge 1 ] || fail "queryByDID returned no records"
ok "QueryByDID: $COUNT record(s) found"

# ── 8. create DIDComm invitation (user token) ────────────────────────────────
info "Creating DIDComm invitation for holder..."
ENCODED_DID_CONNECT=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$DID', safe=''))")
INVITE_RESP=$(api POST "/api/did/${ENCODED_DID_CONNECT}/connect" "$USER_TOKEN" -d '{}')
OOB_ID=$(get_field "$INVITE_RESP" "['oobId']") || fail "createInvitation failed: $INVITE_RESP"
INVITE_URL=$(get_field "$INVITE_RESP" "['invitationUrl']")
ok "Invitation created — oobId: $OOB_ID"
echo "      URL: $INVITE_URL"

# ── 9. check connection status (expect not yet connected) ─────────────────────
info "Checking connection status (holder has not scanned yet — expect not connected)..."
CONN_RESP=$(api GET "/api/did/${ENCODED_DID_CONNECT}/connection-status" "$USER_TOKEN")
CONNECTED=$(get_field "$CONN_RESP" "['connected']")
ok "Connection status: connected=$CONNECTED (expected false until holder scans the invitation)"

# ── 10. verify attempt with user token (should be 403) ────────────────────────
info "Verifying that user role cannot call /verify (expect 403)..."
FORBIDDEN=$(api PUT "/api/kyc/$KYC_ID/verify" "$USER_TOKEN" \
  -d '{"credDefId":"test-cred-def"}')
FORBIDDEN_STATUS=$(get_field "$FORBIDDEN" "['error']")
[[ "$FORBIDDEN_STATUS" == *"Verifier role required"* ]] || fail "Expected 403, got: $FORBIDDEN"
ok "Role guard works — user correctly blocked from /verify"

# ── 11. print summary ─────────────────────────────────────────────────────────
echo ""
echo "──────────────────────────────────────────────"
ok "Smoke test passed"
echo "   DID           : $DID"
echo "   KYC ID        : $KYC_ID"
echo "   Status        : PENDING"
echo ""
echo "Next steps (require a live Fabric + provisioned cred def):"
echo ""
CRED_DEF_ID="${KYC_CRED_DEF_ID:-<CRED_DEF_ID>}"
echo "  Verify (verifier token required):"
echo "    curl -X PUT $BASE_URL/api/kyc/$KYC_ID/verify \\"
echo "      -H 'Authorization: Bearer \$VERIFIER_TOKEN' \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -d '{\"credDefId\":\"$CRED_DEF_ID\",\"attributes\":{\"kyc_id\":\"$KYC_ID\",\"verification_date\":\"$(date +%F)\"}}'"
echo ""
echo "  Revoke (verifier token required):"
echo "    curl -X PUT $BASE_URL/api/kyc/$KYC_ID/revoke \\"
echo "      -H 'Authorization: Bearer \$VERIFIER_TOKEN' \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -d '{\"credentialExchangeId\":\"<CRED_EX_ID>\"}'"
echo "──────────────────────────────────────────────"
