#!/usr/bin/env bash
# Deploys the KYC Go chaincode as CaaS (Chaincode as a Service):
#   build image → package (ccaas) → install → start service → approve → commit
# Re-running with a higher CC_SEQUENCE upgrades the chaincode.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FABRIC_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$FABRIC_DIR")"

CC_NAME="${FABRIC_CHAINCODE:-kyccc}"
CC_VERSION="${CC_VERSION:-1.0}"
CC_SEQUENCE="${CC_SEQUENCE:-1}"
CC_LABEL="${CC_NAME}_${CC_VERSION}"
CHANNEL_NAME="${FABRIC_CHANNEL:-kycchannel}"
ORDERER="${ORDERER_ADDRESS:-orderer.example.com:7050}"
PEER="peer0.org1.example.com:7051"
CLI="fabric-cli"
ORDERER_CA="/crypto-config/ordererOrganizations/example.com/orderers/orderer.example.com/tls/ca.crt"
PEER_TLS_ROOTCERT="/crypto-config/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"

CC_PKG_CONTAINER="/tmp/${CC_LABEL}.tar.gz"
CCAAS_ADDRESS="kyccc-service:7052"
ENV_FILE="$ROOT_DIR/.env"

# ── helpers ───────────────────────────────────────────────────────────────────

peer_cli() {
  local cname
  cname=$(docker ps --filter "name=${CLI}" --format "{{.Names}}" | head -1)
  docker exec "$cname" peer "$@"
}

cli_exec() {
  local cname
  cname=$(docker ps --filter "name=${CLI}" --format "{{.Names}}" | head -1)
  docker exec "$cname" "$@"
}

check_cli_running() {
  local cname
  cname=$(docker ps --filter "name=${CLI}" --filter "status=running" --format "{{.Names}}" | head -1)
  if [[ -z "$cname" ]]; then
    echo "ERROR: fabric-cli container is not running." >&2
    echo "       Run ./fabric/scripts/network.sh up first." >&2
    exit 1
  fi
}

# ── Step 1: ensure vendor/ exists (needed for docker build) ───────────────────

vendor_chaincode() {
  echo ">>> Vendoring chaincode dependencies ..."
  if [[ -d "$ROOT_DIR/chaincode/vendor" ]]; then
    echo "    vendor/ already exists – skipping."
    return 0
  fi
  if command -v go &>/dev/null; then
    (cd "$ROOT_DIR/chaincode" && go mod vendor)
  else
    echo "    go not in PATH — running go mod vendor via Docker..."
    docker run --rm \
      -v "${ROOT_DIR}/chaincode:/chaincode" \
      -w /chaincode \
      golang:1.21-alpine \
      go mod vendor
  fi
  echo "    Vendored to $ROOT_DIR/chaincode/vendor"
}

# ── Step 2: build chaincode Docker image (on host, bypasses peer Docker issue) ─

build_chaincode_image() {
  echo ">>> Building chaincode Docker image ..."
  docker build -t kyc2-system-kyccc "$ROOT_DIR/chaincode"
  echo "    Image kyc2-system-kyccc built."
}

# ── Step 3: package as CaaS (manual tar — peer CLI has no --type ccaas flag) ──

package_chaincode() {
  echo ">>> Packaging $CC_LABEL (CaaS) ..."
  local cname
  cname=$(docker ps --filter "name=${CLI}" --format "{{.Names}}" | head -1)

  # Build the CaaS package manually inside fabric-cli:
  #   metadata.json  → {"type":"ccaas","label":"<label>"}
  #   code.tar.gz    → contains connection.json
  #   final .tar.gz  → metadata.json + code.tar.gz
  docker exec "$cname" sh -c "
    set -e
    mkdir -p /tmp/ccaas-build

    # metadata.json
    printf '{\"type\":\"ccaas\",\"label\":\"%s\"}' '$CC_LABEL' \
      > /tmp/ccaas-build/metadata.json

    # connection.json → code.tar.gz
    printf '{\"address\":\"%s\",\"dial_timeout\":\"10s\",\"tls_required\":false}' '$CCAAS_ADDRESS' \
      > /tmp/connection.json
    tar czf /tmp/ccaas-build/code.tar.gz -C /tmp connection.json

    # final package
    tar czf '$CC_PKG_CONTAINER' -C /tmp/ccaas-build metadata.json code.tar.gz

    echo '    Package created: $CC_PKG_CONTAINER'
  "
}

# ── Step 4: install ───────────────────────────────────────────────────────────

install_chaincode() {
  if cli_exec peer lifecycle chaincode queryinstalled 2>&1 \
       | grep -q "Label: ${CC_LABEL}"; then
    echo ">>> $CC_LABEL already installed – skipping install."
    return 0
  fi
  echo ">>> Installing $CC_LABEL on peer0.org1 ..."
  peer_cli lifecycle chaincode install "$CC_PKG_CONTAINER"
  echo "    Installed."
}

# ── Step 5: resolve package ID ────────────────────────────────────────────────

query_package_id() {
  local pkg_id
  pkg_id=$(peer_cli lifecycle chaincode queryinstalled --output json 2>/dev/null \
    | jq -r ".installed_chaincodes[] | select(.label==\"${CC_LABEL}\") | .package_id")
  if [[ -z "$pkg_id" || "$pkg_id" == "null" ]]; then
    echo "ERROR: Could not find package ID for label '${CC_LABEL}'." >&2
    peer_cli lifecycle chaincode queryinstalled 2>&1 >&2 || true
    exit 1
  fi
  echo "$pkg_id"
}

# ── Step 6: start chaincode service with correct CHAINCODE_ID ─────────────────

start_chaincode_service() {
  local pkg_id="$1"
  echo ">>> Starting kyccc-service (CHAINCODE_ID=$pkg_id) ..."

  # Persist KYCCC_ID in .env so docker compose picks it up
  if grep -q "^KYCCC_ID=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^KYCCC_ID=.*|KYCCC_ID=${pkg_id}|" "$ENV_FILE"
  else
    echo "KYCCC_ID=${pkg_id}" >> "$ENV_FILE"
  fi

  docker compose -f "$ROOT_DIR/docker-compose.yml" \
    --env-file "$ENV_FILE" \
    up -d --force-recreate kyccc-service

  # Give the service a moment to connect
  echo "    Waiting for kyccc-service to start ..."
  sleep 5
  echo "    kyccc-service started."
}

# ── Step 7: approve for Org1 ─────────────────────────────────────────────────

approve_chaincode() {
  local pkg_id="$1"
  local approved
  approved=$(cli_exec peer lifecycle chaincode queryapproved \
    --channelID "$CHANNEL_NAME" --name "$CC_NAME" --sequence "$CC_SEQUENCE" 2>&1 || true)
  if echo "$approved" | grep -q "package_id:"; then
    echo ">>> Org1MSP approval already present at sequence $CC_SEQUENCE – skipping."
    return 0
  fi
  echo ">>> Approving $CC_NAME for Org1MSP (sequence $CC_SEQUENCE) ..."
  echo "    Package ID: $pkg_id"
  peer_cli lifecycle chaincode approveformyorg \
    -o "$ORDERER" \
    --channelID "$CHANNEL_NAME" \
    --name "$CC_NAME" \
    --version "$CC_VERSION" \
    --package-id "$pkg_id" \
    --sequence "$CC_SEQUENCE" \
    --tls --cafile "$ORDERER_CA"
  echo "    Approved."
}

# ── Step 8: check commit readiness ───────────────────────────────────────────

check_commit_readiness() {
  echo ">>> Checking commit readiness ..."
  peer_cli lifecycle chaincode checkcommitreadiness \
    --channelID "$CHANNEL_NAME" \
    --name "$CC_NAME" \
    --version "$CC_VERSION" \
    --sequence "$CC_SEQUENCE"
}

# ── Step 9: commit ────────────────────────────────────────────────────────────

commit_chaincode() {
  local committed
  committed=$(cli_exec peer lifecycle chaincode querycommitted \
    --channelID "$CHANNEL_NAME" --name "$CC_NAME" 2>&1 || true)
  if echo "$committed" | grep -q "Sequence: ${CC_SEQUENCE},"; then
    echo ">>> $CC_NAME already committed at sequence $CC_SEQUENCE – skipping."
    return 0
  fi
  echo ">>> Committing $CC_NAME v$CC_VERSION (sequence $CC_SEQUENCE) to $CHANNEL_NAME ..."
  peer_cli lifecycle chaincode commit \
    -o "$ORDERER" \
    --channelID "$CHANNEL_NAME" \
    --name "$CC_NAME" \
    --version "$CC_VERSION" \
    --sequence "$CC_SEQUENCE" \
    --peerAddresses "$PEER" \
    --tlsRootCertFiles "$PEER_TLS_ROOTCERT" \
    --tls --cafile "$ORDERER_CA"
  echo "    Committed."
}

# ── Step 10: verify ────────────────────────────────────────────────────────────

verify_deployment() {
  echo ">>> Verifying deployment ..."
  peer_cli lifecycle chaincode querycommitted \
    --channelID "$CHANNEL_NAME" \
    --name "$CC_NAME"
}

# ── Entrypoint ────────────────────────────────────────────────────────────────

main() {
  check_cli_running
  vendor_chaincode
  build_chaincode_image
  package_chaincode
  install_chaincode

  local pkg_id
  pkg_id="$(query_package_id)"

  start_chaincode_service "$pkg_id"
  approve_chaincode "$pkg_id"
  check_commit_readiness
  commit_chaincode
  verify_deployment

  echo ""
  echo "==> $CC_NAME v$CC_VERSION deployed to channel '$CHANNEL_NAME' (CaaS mode)."
  echo "    Chaincode service: $CCAAS_ADDRESS"
  echo "    Package ID: $pkg_id"
  echo ""
  echo "    To upgrade: CC_VERSION=2.0 CC_SEQUENCE=2 $0"
}

main
