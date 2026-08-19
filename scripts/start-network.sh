#!/usr/bin/env bash
# Brings up the full KYC stack: Fabric network, ACA-Py (BCovrin ledger), IPFS, and the application.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Starting Fabric network..."
bash "$ROOT/fabric/scripts/network.sh" up

echo "==> Starting ACA-Py, IPFS, backend, frontend..."
docker compose -f "$ROOT/docker-compose.yml" up -d \
  postgres acapy-agent bank-postgres bank-acapy ipfs backend frontend

echo "==> Deploying KYC chaincode..."
CC_VERSION="${CC_VERSION:-1.0}" CC_SEQUENCE="${CC_SEQUENCE:-1}" \
  bash "$ROOT/fabric/scripts/deploy-chaincode.sh"

echo "==> Provisioning ACA-Py agent (schema + cred def)..."
bash "$ROOT/acapy/scripts/provision.sh"

echo ""
echo "Stack is up:"
echo "  Backend  : http://localhost:3000"
echo "  Frontend : http://localhost:80"
echo "  ACA-Py   : http://localhost:8031/api/doc"
echo "  IPFS API : http://localhost:5001/webui"
echo "  CouchDB  : http://localhost:5984/_utils"
