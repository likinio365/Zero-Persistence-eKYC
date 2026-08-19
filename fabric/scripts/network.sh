#!/usr/bin/env bash
# Manages the Hyperledger Fabric network: generate artifacts, bring up/down.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FABRIC_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$FABRIC_DIR")"

CHANNEL_NAME="${FABRIC_CHANNEL:-kycchannel}"
ORDERER="${ORDERER_ADDRESS:-orderer.example.com:7050}"
ORDERER_CA="/crypto-config/ordererOrganizations/example.com/orderers/orderer.example.com/tls/ca.crt"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
CHANNEL_ARTIFACTS="$FABRIC_DIR/channel-artifacts"
CRYPTO_CONFIG="$FABRIC_DIR/crypto-config"
CLI="fabric-cli"

# ── Fabric binary resolution ──────────────────────────────────────────────────
# Looks for binaries in: PATH → FABRIC_BIN_PATH env var → hyperledger/fabric-tools Docker image.
# All paths passed to run_fabric_tool must be relative to FABRIC_DIR.

run_fabric_tool() {
  local cmd="$1"; shift
  if command -v "$cmd" &>/dev/null; then
    (cd "$FABRIC_DIR" && "$cmd" "$@")
  elif [[ -n "${FABRIC_BIN_PATH:-}" && -x "${FABRIC_BIN_PATH}/${cmd}" ]]; then
    (cd "$FABRIC_DIR" && "${FABRIC_BIN_PATH}/${cmd}" "$@")
  else
    echo "    (running $cmd via hyperledger/fabric-tools:2.5 Docker image)"
    docker run --rm \
      -v "${FABRIC_DIR}:/fabric" \
      -w /fabric \
      -e FABRIC_CFG_PATH=/fabric \
      "hyperledger/fabric-tools:2.5.9" \
      "$cmd" "$@"
  fi
}

# ── Peer CLI (executes inside the fabric-cli container with Admin MSP) ────────

peer_cli() {
  local cname
  cname=$(docker ps --filter "name=${CLI}" --format "{{.Names}}" | head -1)
  docker exec "$cname" peer "$@"
}

# ── Wait helpers ──────────────────────────────────────────────────────────────

wait_container_running() {
  local name="$1"
  local retries="${2:-30}"
  echo "    Waiting for container $name ..."
  for i in $(seq 1 "$retries"); do
    if docker ps --filter "name=${name}" --filter "status=running" \
         --format '{{.Names}}' 2>/dev/null | grep -q "${name}"; then
      echo "    $name is running."
      return 0
    fi
    sleep 2
  done
  echo "ERROR: $name did not reach running state." >&2
  return 1
}

wait_peer_healthy() {
  echo "    Waiting for peer to accept connections ..."
  local retries=30
  for i in $(seq 1 "$retries"); do
    if bash -c 'echo > /dev/tcp/localhost/7051' 2>/dev/null; then
      echo "    Peer is ready."
      return 0
    fi
    sleep 2
  done
  echo "ERROR: peer0.org1.example.com not ready after $((retries * 2))s." >&2
  return 1
}

wait_orderer_healthy() {
  echo "    Waiting for orderer to accept connections ..."
  local retries=30
  for i in $(seq 1 "$retries"); do
    if bash -c 'echo > /dev/tcp/localhost/7050' 2>/dev/null; then
      echo "    Orderer is listening."
      return 0
    fi
    sleep 2
  done
  # Non-fatal: orderer may be ready even if the port check timed out
  echo "    (Orderer port check timed out – continuing anyway)"
}

# ── Artifact generation ───────────────────────────────────────────────────────

generate_crypto() {
  if [[ -d "${CRYPTO_CONFIG}/peerOrganizations" ]]; then
    echo "    Crypto material already exists – skipping cryptogen."
    return 0
  fi
  echo "    Running cryptogen ..."
  run_fabric_tool cryptogen generate \
    --config=crypto-config.yaml \
    --output=crypto-config
  echo "    Crypto material written to $CRYPTO_CONFIG"
}

generate_channel_artifacts() {
  mkdir -p "$CHANNEL_ARTIFACTS"

  if [[ -f "${CHANNEL_ARTIFACTS}/genesis.block" ]]; then
    echo "    Channel artifacts already exist – skipping configtxgen."
    return 0
  fi

  echo "    Generating orderer genesis block ..."
  run_fabric_tool configtxgen \
    -profile KYCGenesis \
    -channelID system-channel \
    -outputBlock "channel-artifacts/genesis.block"

  echo "    Generating channel creation tx ..."
  run_fabric_tool configtxgen \
    -profile KYCChannel \
    -outputCreateChannelTx "channel-artifacts/${CHANNEL_NAME}.tx" \
    -channelID "$CHANNEL_NAME"

  echo "    Generating Org1 anchor peer tx ..."
  run_fabric_tool configtxgen \
    -profile KYCChannel \
    -outputAnchorPeersUpdate "channel-artifacts/Org1MSPanchors.tx" \
    -channelID "$CHANNEL_NAME" \
    -asOrg Org1MSP

  echo "    Artifacts written to $CHANNEL_ARTIFACTS"
}

generate() {
  echo "==> Generating crypto material ..."
  generate_crypto
  echo "==> Generating channel artifacts ..."
  generate_channel_artifacts
}

# ── Channel setup ─────────────────────────────────────────────────────────────

channel_exists() {
  local cname
  cname=$(docker ps --filter "name=${CLI}" --format "{{.Names}}" | head -1)
  [[ -n "$cname" ]] && docker exec "$cname" peer channel list 2>/dev/null | grep -qw "$CHANNEL_NAME"
}

channel_create() {
  if channel_exists; then
    echo "    Channel $CHANNEL_NAME already exists – skipping create."
    return 0
  fi
  echo "    Creating channel $CHANNEL_NAME (waiting for Raft leader) ..."
  local retries=15
  for i in $(seq 1 "$retries"); do
    local out
    out=$(peer_cli channel create \
        -o "$ORDERER" \
        -c "$CHANNEL_NAME" \
        -f "/channel-artifacts/${CHANNEL_NAME}.tx" \
        --outputBlock "/channel-artifacts/${CHANNEL_NAME}.block" \
        --tls --cafile "$ORDERER_CA" 2>&1)
    local rc=$?
    echo "$out"
    if [ $rc -eq 0 ]; then
      echo "    Channel $CHANNEL_NAME created."
      return 0
    fi
    # Channel already exists in orderer but peer hasn't joined yet
    if echo "$out" | grep -q "already exists\|version 1"; then
      echo "    Channel $CHANNEL_NAME already exists in orderer – fetching genesis block ..."
      peer_cli channel fetch 0 "/channel-artifacts/${CHANNEL_NAME}.block" \
        -c "$CHANNEL_NAME" -o "$ORDERER" --tls --cafile "$ORDERER_CA" 2>&1
      return 0
    fi
    echo "    Raft not ready yet (attempt $i/$retries) – retrying in 4s ..."
    sleep 4
  done
  echo "ERROR: failed to create channel after $retries attempts." >&2
  return 1
}

channel_join() {
  if channel_exists; then
    echo "    peer0.org1 already joined $CHANNEL_NAME – skipping join."
    return 0
  fi
  echo "    Joining peer0.org1 to $CHANNEL_NAME ..."
  # Fetch genesis block from orderer in case local file is missing
  if [ ! -f "/channel-artifacts/${CHANNEL_NAME}.block" ] 2>/dev/null; then
    peer_cli channel fetch 0 "/channel-artifacts/${CHANNEL_NAME}.block" \
      -c "$CHANNEL_NAME" -o "$ORDERER" --tls --cafile "$ORDERER_CA" 2>&1 || true
  fi
  peer_cli channel join -b "/channel-artifacts/${CHANNEL_NAME}.block"
  echo "    Peer joined channel."
}

channel_update_anchors() {
  echo "    Updating Org1 anchor peers ..."
  if ! peer_cli channel update \
    -o "$ORDERER" \
    -c "$CHANNEL_NAME" \
    -f /channel-artifacts/Org1MSPanchors.tx \
    --tls --cafile "$ORDERER_CA" 2>&1; then
    echo "    (Anchor peers already set at current version — skipping)"
  else
    echo "    Anchor peers updated."
  fi
}

# ── Network lifecycle ─────────────────────────────────────────────────────────

network_up() {
  generate

  echo "==> Starting Fabric services ..."
  docker compose -f "$COMPOSE_FILE" up -d \
    fabric-ca "orderer.example.com" couchdb "peer0.org1.example.com" fabric-cli

  wait_container_running "orderer.example.com"
  wait_container_running "peer0.org1.example.com"
  wait_container_running "$CLI"
  wait_orderer_healthy
  wait_peer_healthy

  echo "==> Setting up channel ..."
  channel_create
  channel_join
  channel_update_anchors

  echo ""
  echo "==> Fabric network is up."
  echo "    Peer     : grpc://localhost:7051"
  echo "    Orderer  : grpc://localhost:7050"
  echo "    CouchDB  : http://localhost:5984/_utils"
  echo ""
  echo "    Next: ./fabric/scripts/deploy-chaincode.sh"
}

network_down() {
  echo "==> Stopping Fabric services ..."
  docker compose -f "$COMPOSE_FILE" stop \
    fabric-ca "orderer.example.com" "peer0.org1.example.com" couchdb fabric-cli
  docker compose -f "$COMPOSE_FILE" rm -f \
    fabric-ca "orderer.example.com" "peer0.org1.example.com" couchdb fabric-cli
  echo "==> Fabric services stopped."
}

clean() {
  echo "==> Removing Fabric services and volumes ..."
  docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans 2>/dev/null || true
  echo "==> Removing generated artifacts ..."
  rm -rf "$CRYPTO_CONFIG" "$CHANNEL_ARTIFACTS"
  echo "==> Clean complete."
}

# ── Entrypoint ────────────────────────────────────────────────────────────────

usage() {
  cat <<EOF
Usage: $0 <command>

Commands:
  generate   Generate crypto material and channel artifacts (idempotent)
  up         Generate artifacts, start services, create and join channel
  down       Stop Fabric containers (preserves volumes and artifacts)
  clean      Stop containers, remove volumes, delete all generated artifacts

Environment:
  FABRIC_CHANNEL    Channel name (default: kycchannel)
  FABRIC_BIN_PATH   Directory containing Fabric binaries (default: system PATH)
  ORDERER_ADDRESS   Orderer endpoint (default: orderer.example.com:7050)
EOF
  exit 1
}

case "${1:-}" in
  generate) generate ;;
  up)       network_up ;;
  down)     network_down ;;
  clean)    clean ;;
  *)        usage ;;
esac
