#!/usr/bin/env bash
# Stops all KYC stack services.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Stopping all services..."
docker compose -f "$ROOT/docker-compose.yml" down --volumes --remove-orphans

echo "==> Removing stopped chaincode build containers..."
docker container prune -f

echo "==> Done."
