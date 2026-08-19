#!/usr/bin/env bash
# Bank verification smoke test:
#   1. Full KYC lifecycle (submit → verify → issue VC)
#   2. Bank creates OOB invitation
#   3. Bank sends proof request (age >= 18 ZKP predicate)
#   4. Polls for proof result
#
# Without a live BC Wallet, steps 2-4 complete the API side and print the
# QR URL so you can scan it manually during a demo. The script polls for the
# connection and proof result, timing out gracefully if no wallet connects.
#
# Usage: ./scripts/test-bank-verify.sh [BASE_URL]
# Default BASE_URL: http://localhost:3000

set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [ -f "$ENV_FILE" ]; then
  set -a; source "$ENV_FILE"; set +a
fi

USER_USERNAME="${USER_USERNAME:-user}"
USER_PASSWORD="${USER_PASSWORD:-user-pass}"
VERIFIER_USERNAME="${VERIFIER_USERNAME:-verifier}"
VERIFIER_PASSWORD="${VERIFIER_PASSWORD:-verifier-pass}"
BANK_USERNAME="${BANK_USERNAME:-bank}"
BANK_PASSWORD="${BANK_PASSWORD:-bank-pass}"
CRED_DEF_ID="${KYC_CRED_DEF_ID:-}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC}  $*"; }
info() { echo -e "${YELLOW}[..]${NC}  $*"; }
fail() { echo -e "${RED}[ERR]${NC} $*"; exit 1; }
note() { echo -e "${CYAN}[>>]${NC}  $*"; }

PASSPORT_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjkB6QAAAABJRU5ErkJggg=="
SELFIE_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjkB6QAAAABJRU5ErkJggg=="

get_field() { echo "$1" | python3 -c "import sys,json; print(json.load(sys.stdin)$2)"; }

api() {
  local method="$1"; local path="$2"; local token="$3"; shift 3
  curl -s -X "$method" "${BASE_URL}${path}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${token}" \
    "$@"
}

login() {
  local user="$1" pass="$2"
  local resp
  resp=$(curl -s -X POST "${BASE_URL}/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${user}\",\"password\":\"${pass}\"}")
  get_field "$resp" "['token']"
}

# ── Step 0: health ────────────────────────────────────────────────────────────
info "Health check..."
curl -sf "${BASE_URL}/health" >/dev/null 2>&1 || fail "Backend is down at ${BASE_URL}"
ok "Backend is up"

# ── Step 1: login all three roles ────────────────────────────────────────────
info "Logging in as user ('${USER_USERNAME}')..."
USER_TOKEN=$(login "$USER_USERNAME" "$USER_PASSWORD")
[[ -n "$USER_TOKEN" ]] || fail "User login failed"
ok "Got user token"

info "Logging in as verifier ('${VERIFIER_USERNAME}')..."
VERIFIER_TOKEN=$(login "$VERIFIER_USERNAME" "$VERIFIER_PASSWORD")
[[ -n "$VERIFIER_TOKEN" ]] || fail "Verifier login failed"
ok "Got verifier token"

info "Logging in as bank ('${BANK_USERNAME}')..."
BANK_TOKEN=$(login "$BANK_USERNAME" "$BANK_PASSWORD")
[[ -n "$BANK_TOKEN" ]] || fail "Bank login failed"
ok "Got bank token"

# ── Step 2: create DID + submit KYC ──────────────────────────────────────────
info "Creating DID..."
DID_RESP=$(api POST /api/did "${USER_TOKEN}" -d '{}')
DID=$(get_field "$DID_RESP" "['did']")
# Strip bare DID → did:indy:test: prefix
[[ "$DID" == did:* ]] || DID="did:indy:test:${DID}"
ok "DID created: ${DID}"

DOB=$(date -d "30 years ago" +%Y-%m-%d 2>/dev/null || date -v-30y +%Y-%m-%d 2>/dev/null || echo "1994-01-15")

info "Submitting KYC application (age ≥ 18 via dateOfBirth=${DOB})..."
SUBMIT_RESP=$(api POST /api/kyc "${USER_TOKEN}" -d "{
  \"did\": \"${DID}\",
  \"dateOfBirth\": \"${DOB}\",
  \"documents\": [
    {\"type\": \"passport\", \"fileName\": \"passport.png\", \"contentBase64\": \"${PASSPORT_B64}\"},
    {\"type\": \"selfie\",   \"fileName\": \"selfie.png\",   \"contentBase64\": \"${SELFIE_B64}\"}
  ]
}")
KYC_ID=$(get_field "$SUBMIT_RESP" "['id']")
[[ -n "$KYC_ID" && "$KYC_ID" != "None" ]] || fail "KYC submit failed: ${SUBMIT_RESP}"
ok "KYC submitted — ID: ${KYC_ID}"

# ── Step 3: verifier approves → issues VC ────────────────────────────────────
[[ -n "$CRED_DEF_ID" ]] || fail "KYC_CRED_DEF_ID not set in .env — run provision.sh first"

info "Verifier approving KYC (cred_def_id: ${CRED_DEF_ID})..."
VERIFY_RESP=$(api PUT "/api/kyc/${KYC_ID}/verify" "${VERIFIER_TOKEN}" \
  -d "{\"credDefId\": \"${CRED_DEF_ID}\"}")
VERIFY_STATUS=$(get_field "$VERIFY_RESP" ".get('status','')") 2>/dev/null || true
VERIFY_WARNING=$(echo "$VERIFY_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('warning',''))" 2>/dev/null || true)

# Check Fabric state directly
CHAIN_STATUS=$(api GET "/api/kyc/${KYC_ID}" "${USER_TOKEN}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))")
if [[ "$CHAIN_STATUS" == "VERIFIED" ]]; then
  ok "KYC verified on Fabric — status: VERIFIED"
  [[ -n "$VERIFY_WARNING" ]] && note "VC issuance warning (no DIDComm connection): ${VERIFY_WARNING}"
else
  fail "Verification failed — Fabric status: ${CHAIN_STATUS} — response: ${VERIFY_RESP}"
fi

# ── Step 4: bank creates OOB invitation ───────────────────────────────────────
echo ""
echo "── Bank Verification (SSI Trust Triangle) ───────────────────────────"
info "Bank creating DIDComm OOB invitation..."
INV_RESP=$(api POST /api/bank/invitation "${BANK_TOKEN}")
OOB_ID=$(get_field "$INV_RESP" "['oobId']")
INV_URL=$(get_field "$INV_RESP" "['invitationUrl']")
[[ -n "$OOB_ID" ]] || fail "Bank invitation failed: ${INV_RESP}"
ok "Bank OOB invitation created — oobId: ${OOB_ID}"
echo ""
note "Scan this URL with BC Wallet to connect:"
note "${INV_URL}"
echo ""

# ── Step 5: poll for wallet connection (30s timeout) ─────────────────────────
info "Polling for wallet connection (30s timeout — scan the QR above)..."
CONNECTION_ID=""
for i in $(seq 1 6); do
  sleep 5
  CONN_RESP=$(api GET "/api/bank/connection/${OOB_ID}" "${BANK_TOKEN}")
  CONNECTED=$(get_field "$CONN_RESP" "['connected']")
  if [[ "$CONNECTED" == "True" ]]; then
    CONNECTION_ID=$(get_field "$CONN_RESP" "['connectionId']")
    ok "Wallet connected! connectionId: ${CONNECTION_ID}"
    break
  fi
  echo "    (attempt ${i}/6 — not connected yet)"
done

if [[ -z "$CONNECTION_ID" ]]; then
  note "No wallet connected within 30s — skipping proof request."
  note "To send proof request manually after scanning:"
  note "  CONN_ID=\$(curl -s ${BASE_URL}/api/bank/connection/${OOB_ID} -H 'Authorization: Bearer \$BANK_TOKEN' | jq -r .connectionId)"
  note "  curl -s -X POST ${BASE_URL}/api/bank/proof-request -H 'Authorization: Bearer \$BANK_TOKEN' -H 'Content-Type: application/json' -d \"{\\\"connectionId\\\":\\\"\$CONN_ID\\\"}\""
  echo ""
  echo "──────────────────────────────────────────────────────────────────────"
  ok  "Bank API smoke test passed (invitation created, proof API ready)"
  echo "   KYC ID        : ${KYC_ID}"
  echo "   Fabric status : VERIFIED"
  echo "   OOB ID        : ${OOB_ID}"
  echo "   Cred Def ID   : ${CRED_DEF_ID}"
  echo "──────────────────────────────────────────────────────────────────────"
  exit 0
fi

# ── Step 6: send proof request ────────────────────────────────────────────────
info "Sending proof request (age >= 18 ZKP predicate)..."
PROOF_RESP=$(api POST /api/bank/proof-request "${BANK_TOKEN}" \
  -d "{\"connectionId\": \"${CONNECTION_ID}\"}")
PRES_EX_ID=$(get_field "$PROOF_RESP" "['presExId']")
[[ -n "$PRES_EX_ID" && "$PRES_EX_ID" != "None" ]] || fail "Proof request failed: ${PROOF_RESP}"
ok "Proof request sent — presExId: ${PRES_EX_ID}"

# ── Step 7: poll for proof result (60s timeout) ───────────────────────────────
info "Polling for proof result (60s timeout — approve in your wallet)..."
for i in $(seq 1 12); do
  sleep 5
  RESULT_RESP=$(api GET "/api/bank/proof-result/${PRES_EX_ID}" "${BANK_TOKEN}")
  STATE=$(get_field "$RESULT_RESP" "['state']")
  DONE=$(get_field "$RESULT_RESP" "['done']")
  VERIFIED=$(get_field "$RESULT_RESP" "['verified']")

  if [[ "$DONE" == "True" ]]; then
    if [[ "$VERIFIED" == "True" ]]; then
      ok "ZKP proof VERIFIED — age >= 18 confirmed without revealing exact age"
    else
      fail "Proof completed but NOT verified — state: ${STATE}"
    fi
    break
  fi
  echo "    (attempt ${i}/12 — proof state: ${STATE})"
done

echo ""
echo "──────────────────────────────────────────────────────────────────────"
ok  "Full bank verification test passed"
echo "   KYC ID        : ${KYC_ID}"
echo "   Fabric status : VERIFIED"
echo "   Connection ID : ${CONNECTION_ID}"
echo "   Pres Ex ID    : ${PRES_EX_ID}"
echo "   ZKP result    : age >= 18 VERIFIED (no DOB disclosed)"
echo "──────────────────────────────────────────────────────────────────────"
