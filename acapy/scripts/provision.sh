#!/usr/bin/env bash
# Provisions the ACA-Py agent: ensures a public DID, registers the KYC schema,
# and creates a revocation-enabled credential definition on the Indy ledger.
#
# Idempotent: every step checks for an existing resource before writing.
# On success, writes schema_id and cred_def_id to acapy/state/provision.json
# so the backend can read them at startup.
#
# Environment variables:
#   ACAPY_ADMIN_URL      ACA-Py admin base URL  (default: http://localhost:8031)
#   ACAPY_API_KEY        Admin API key           (default: empty / no auth)
#   INDY_LEDGER_URL      Indy ledger browser URL (default: http://test.bcovrin.vonx.io)
#   KYC_SCHEMA_NAME      Schema name             (default: kyc)
#   KYC_SCHEMA_VERSION   Schema version          (default: 1.0)
#   KYC_CRED_DEF_TAG     Credential def tag      (default: default)
set -euo pipefail

# Load .env from the project root if present (same pattern as test-kyc.sh)
_PROVISION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_ENV_FILE="$_PROVISION_DIR/../../.env"
if [[ -f "$_ENV_FILE" ]]; then
  set -a; source "$_ENV_FILE"; set +a
fi

ACAPY_ADMIN="${ACAPY_ADMIN_URL:-http://localhost:8031}"
INDY_LEDGER="${INDY_LEDGER_URL:-http://test.bcovrin.vonx.io}"

SCHEMA_NAME="${KYC_SCHEMA_NAME:-kyc}"
SCHEMA_VERSION="${KYC_SCHEMA_VERSION:-3.0}"
CRED_DEF_TAG="${KYC_CRED_DEF_TAG:-default}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$(dirname "$SCRIPT_DIR")/state"
STATE_FILE="$STATE_DIR/provision.json"

# KYC schema attributes — must match exactly what the backend sends in issueCredential.
# The schema is immutable once written; bump KYC_SCHEMA_VERSION to evolve it.
# PII (name, DOB, etc.) stays encrypted on IPFS — only age (integer) is disclosed in VC
# so the bank can run a ZKP predicate (age >= 18) without seeing the actual date of birth.
SCHEMA_ATTRS=(
  kyc_id
  verification_date
  age
)

# ── HTTP helpers ──────────────────────────────────────────────────────────────

# Build curl header args (Content-Type + optional X-API-Key)
_curl_headers() {
  local -a headers=(-H "Content-Type: application/json")
  [[ -n "${ACAPY_API_KEY:-}" ]] && headers+=(-H "X-API-Key: ${ACAPY_API_KEY}")
  printf '%s\0' "${headers[@]}"
}

acapy_get() {
  local path="$1"
  local -a headers
  readarray -t -d '' headers < <(_curl_headers)
  curl -sf "${headers[@]}" "${ACAPY_ADMIN}${path}"
}

acapy_post() {
  local path="$1"
  local body="$2"
  local -a headers
  readarray -t -d '' headers < <(_curl_headers)
  curl -sf -X POST "${headers[@]}" -d "$body" "${ACAPY_ADMIN}${path}"
}

# ── JSON helpers ──────────────────────────────────────────────────────────────

# Extract a value from JSON using jq.
# $1 = JSON string, $2 = dotted path like "result.did" or "schema_ids.0"
# Prints the value to stdout; prints nothing if the path is absent.
json_get() {
  local json="$1"
  local path="$2"
  # Convert "a.b.0" → ".a.b[0]" for jq
  local jq_path
  jq_path=$(echo "$path" | sed 's/\.\([0-9]\+\)/[\1]/g')
  echo "$json" | jq -re ".${jq_path} // empty" 2>/dev/null || true
}

# ── Utility ───────────────────────────────────────────────────────────────────

die() { echo "ERROR: $*" >&2; exit 1; }

# Build a JSON array from the SCHEMA_ATTRS bash array.
build_attrs_json() {
  local json='['
  local first=1
  for attr in "${SCHEMA_ATTRS[@]}"; do
    [[ $first -eq 0 ]] && json+=','
    json+="\"$attr\""
    first=0
  done
  json+=']'
  echo "$json"
}

# ── Agent readiness ───────────────────────────────────────────────────────────

wait_for_agent() {
  echo ">>> Waiting for ACA-Py at ${ACAPY_ADMIN} ..." >&2
  local retries=40
  for i in $(seq 1 "$retries"); do
    if acapy_get /status 2>/dev/null | grep -q '"version"'; then
      echo "    Agent is ready." >&2
      return 0
    fi
    printf '    (%d/%d) not ready, retrying in 3s ...\n' "$i" "$retries" >&2
    sleep 3
  done
  die "ACA-Py agent did not become ready after $((retries * 3))s"
}

# ── Public DID setup ──────────────────────────────────────────────────────────

# Returns the current public DID (stdout), or empty string if none.
get_public_did() {
  local resp
  resp=$(acapy_get /wallet/did/public 2>/dev/null || echo '{}')
  json_get "$resp" "result.did"
}

# Creates a new local DID and registers it on the Indy ledger as ENDORSER,
# then sets it as the agent's public DID. Returns the new DID on stdout.
register_new_did() {
  echo "    Creating local DID ..." >&2
  local create_resp did verkey
  create_resp=$(acapy_post /wallet/did/create \
    '{"method":"sov","options":{"key_type":"ed25519"}}') \
    || die "Failed to create DID in wallet"

  did=$(json_get "$create_resp" "result.did")
  verkey=$(json_get "$create_resp" "result.verkey")
  [[ -n "$did" ]] || die "DID creation returned no DID. Response: $create_resp"
  echo "    Created DID: $did (verkey: $verkey)" >&2

  # Attempt auto-registration via the ledger browser (works with von-network / BCovrin test).
  echo "    Registering DID on ledger at ${INDY_LEDGER} ..." >&2
  local reg_body reg_resp
  reg_body="{\"did\":\"${did}\",\"verkey\":\"${verkey}\",\"role\":\"ENDORSER\"}"
  reg_resp=$(curl -sfL -X POST \
    -H "Content-Type: application/json" \
    -d "$reg_body" \
    "${INDY_LEDGER}/register" 2>/dev/null || true)

  if [[ -z "$reg_resp" ]]; then
    cat >&2 <<EOF

    *** MANUAL LEDGER REGISTRATION REQUIRED ***
    Could not auto-register on ${INDY_LEDGER}/register.
    Register the DID manually then re-run this script:

      DID   : ${did}
      Verkey: ${verkey}
      Role  : ENDORSER

    Options:
      • von-network browser: http://localhost:9000
      • BCovrin test:        http://test.bcovrin.vonx.io
      • indy-cli:            ledger nym did=${did} verkey=${verkey} role=ENDORSER

EOF
    die "DID not registered on ledger"
  fi
  echo "    Ledger response: $reg_resp" >&2

  # Set this DID as the agent's public (signing) DID.
  acapy_post "/wallet/did/public?did=${did}" '{}' > /dev/null \
    || die "Failed to set public DID"
  echo "    Public DID set: $did" >&2
  echo "$did"
}

# Ensures the agent has a public DID, creating and registering one if needed.
ensure_public_did() {
  echo ">>> Checking for public DID ..." >&2
  local did
  did=$(get_public_did)
  if [[ -n "$did" && "$did" != "null" ]]; then
    echo "    Public DID already set: $did" >&2
    echo "$did"
    return 0
  fi
  echo "    No public DID found — creating and registering ..." >&2
  register_new_did
}

# ── Schema registration ───────────────────────────────────────────────────────

# Returns the existing schema_id for this name+version, or empty string.
find_existing_schema() {
  local resp
  resp=$(acapy_get \
    "/schemas/created?schema_name=${SCHEMA_NAME}&schema_version=${SCHEMA_VERSION}" \
    2>/dev/null || echo '{}')
  json_get "$resp" "schema_ids.0"
}

# Registers the KYC schema on the ledger. Returns schema_id on stdout.
register_schema() {
  echo ">>> Schema '${SCHEMA_NAME}' v${SCHEMA_VERSION} ..." >&2

  local existing
  existing=$(find_existing_schema)
  if [[ -n "$existing" ]]; then
    echo "    Already registered: $existing" >&2
    echo "$existing"
    return 0
  fi

  echo "    Registering (${#SCHEMA_ATTRS[@]} attributes) ..." >&2
  local attrs body resp schema_id
  attrs=$(build_attrs_json)
  body=$(printf '{"schema_name":"%s","schema_version":"%s","attributes":%s}' \
    "$SCHEMA_NAME" "$SCHEMA_VERSION" "$attrs")

  resp=$(acapy_post /schemas "$body") \
    || die "Schema POST failed"

  schema_id=$(json_get "$resp" "schema_id")
  [[ -n "$schema_id" && "$schema_id" != "null" ]] \
    || die "Schema registration returned no schema_id. Response: $resp"

  echo "    Registered: $schema_id" >&2
  echo "$schema_id"
}

# ── Credential definition registration ───────────────────────────────────────

# Returns the existing cred_def_id for the given schema_id, or empty string.
find_existing_cred_def() {
  local schema_id="$1"
  local resp
  resp=$(acapy_get \
    "/credential-definitions/created?schema_id=${schema_id}&cred_def_tag=${CRED_DEF_TAG}" \
    2>/dev/null || echo '{}')
  json_get "$resp" "credential_definition_ids.0"
}

# Creates a credential definition with revocation support. Returns cred_def_id on stdout.
register_cred_def() {
  local schema_id="$1"
  echo ">>> Credential definition (schema: ${schema_id}, tag: ${CRED_DEF_TAG}) ..." >&2

  local existing
  existing=$(find_existing_cred_def "$schema_id")
  if [[ -n "$existing" ]]; then
    echo "    Already registered: $existing" >&2
    echo "$existing"
    return 0
  fi

  local revocation_enabled="false"
  local max_cred_num="${KYC_MAX_CRED_NUM:-1000}"
  if [[ -n "${ACAPY_TAILS_SERVER_BASE_URL:-}" ]]; then
    revocation_enabled="true"
    echo "    Revocation enabled (tails server: ${ACAPY_TAILS_SERVER_BASE_URL})" >&2
  fi

  echo "    Registering (revocation: ${revocation_enabled}) ..." >&2
  local body resp cred_def_id
  if [[ "$revocation_enabled" == "true" ]]; then
    body=$(printf \
      '{"schema_id":"%s","tag":"%s","support_revocation":true,"revocation_registry_size":%s}' \
      "$schema_id" "$CRED_DEF_TAG" "$max_cred_num")
  else
    body=$(printf \
      '{"schema_id":"%s","tag":"%s","support_revocation":false}' \
      "$schema_id" "$CRED_DEF_TAG")
  fi

  resp=$(acapy_post /credential-definitions "$body") \
    || die "Credential definition POST failed"

  cred_def_id=$(json_get "$resp" "credential_definition_id")
  [[ -n "$cred_def_id" && "$cred_def_id" != "null" ]] \
    || die "Cred def registration returned no credential_definition_id. Response: $resp"

  echo "    Registered: $cred_def_id" >&2
  echo "$cred_def_id"
}

# ── State persistence ─────────────────────────────────────────────────────────

save_state() {
  local schema_id="$1"
  local cred_def_id="$2"
  local public_did="$3"

  mkdir -p "$STATE_DIR"
  cat > "$STATE_FILE" <<EOF
{
  "schema_id": "${schema_id}",
  "cred_def_id": "${cred_def_id}",
  "public_did": "${public_did}",
  "schema_name": "${SCHEMA_NAME}",
  "schema_version": "${SCHEMA_VERSION}",
  "cred_def_tag": "${CRED_DEF_TAG}",
  "attributes": $(build_attrs_json),
  "provisioned_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  echo "    State written to ${STATE_FILE}" >&2

  # Update both cred def ID vars in .env so backend and frontend stay in sync.
  if [[ -f "$_ENV_FILE" ]]; then
    sed -i "s|^KYC_CRED_DEF_ID=.*|KYC_CRED_DEF_ID=${cred_def_id}|" "$_ENV_FILE"
    sed -i "s|^REACT_APP_CRED_DEF_ID=.*|REACT_APP_CRED_DEF_ID=${cred_def_id}|" "$_ENV_FILE"
    echo "    KYC_CRED_DEF_ID + REACT_APP_CRED_DEF_ID updated in .env" >&2

    # Rebuild frontend (bakes REACT_APP_CRED_DEF_ID into the bundle) and restart
    # backend so it picks up the new KYC_CRED_DEF_ID from the updated .env.
    local compose_file
    compose_file="$(cd "$(dirname "${_ENV_FILE}")" && pwd)/docker-compose.yml"
    if [[ -f "$compose_file" ]]; then
      echo "    Rebuilding frontend and restarting backend with new cred def ID..." >&2
      docker compose -f "$compose_file" up -d --build --force-recreate frontend backend \
        || echo "[WARN] Could not restart backend/frontend automatically. Run: docker compose up -d --build --force-recreate backend frontend" >&2
    fi
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  wait_for_agent

  local public_did schema_id cred_def_id
  public_did=$(ensure_public_did)
  schema_id=$(register_schema)
  cred_def_id=$(register_cred_def "$schema_id")
  save_state "$schema_id" "$cred_def_id" "$public_did"

  echo ""
  echo "==> Provisioning complete."
  echo "    Public DID : $public_did"
  echo "    Schema ID  : $schema_id"
  echo "    Cred Def ID: $cred_def_id"
  echo ""
  echo "    Add to backend .env:"
  echo "    KYC_CRED_DEF_ID=$cred_def_id"
}

main
