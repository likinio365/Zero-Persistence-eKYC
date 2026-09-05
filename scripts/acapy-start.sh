#!/bin/sh
# Fetches ACA-Py secrets from Vault KV and starts the agent.
# Runs inside the ACA-Py container; Python 3 is guaranteed available.
set -e

VAULT_ADDR="${VAULT_ADDR:-http://vault:8200}"
VAULT_TOKEN="${VAULT_TOKEN:-root}"

echo "[vault] Fetching ACA-Py secrets from ${VAULT_ADDR}..."

eval "$(python3 - <<'PYEOF'
import urllib.request, json, os, sys

addr  = os.environ.get('VAULT_ADDR',  'http://vault:8200')
token = os.environ.get('VAULT_TOKEN', 'root')

try:
    req = urllib.request.Request(
        addr + '/v1/secret/data/kyc',
        headers={'X-Vault-Token': token},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode())['data']['data']

    mapping = {
        'acapy_wallet_key':  'ACAPY_WALLET_KEY',
        'postgres_password': 'POSTGRES_PASSWORD',
        'postgres_user':     'POSTGRES_USER',
    }
    for src, dst in mapping.items():
        val = data.get(src) or os.environ.get(dst, '')
        if val:
            safe = val.replace("'", "'\\''")
            print(f"export {dst}='{safe}'")
    print("echo '[vault] ACA-Py secrets loaded'", file=sys.stderr)
except Exception as e:
    print(f"echo '[vault] WARNING: could not fetch secrets: {e}' >&2")
PYEOF
)"

POSTGRES_USER="${POSTGRES_USER:-acapy}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-acapypw}"

if [ -z "${ACAPY_WALLET_KEY:-}" ]; then
  echo "[ERROR] ACAPY_WALLET_KEY is empty — cannot start aca-py with an empty wallet key." >&2
  exit 1
fi

exec aca-py start \
  --inbound-transport http 0.0.0.0 8030 \
  --outbound-transport http \
  --endpoint "${ACAPY_ENDPOINT:-http://localhost:8030}" \
  --admin 0.0.0.0 8031 \
  --admin-insecure-mode \
  --genesis-url "${INDY_GENESIS_URL:-http://test.bcovrin.vonx.io/genesis}" \
  --wallet-type askar \
  --wallet-name kyc-wallet \
  --wallet-key "${ACAPY_WALLET_KEY}" \
  --wallet-storage-type postgres_storage \
  --wallet-storage-config "{\"url\":\"postgres:5432\",\"max_connections\":5}" \
  --wallet-storage-creds "{\"account\":\"${POSTGRES_USER}\",\"password\":\"${POSTGRES_PASSWORD}\",\"admin_account\":\"${POSTGRES_USER}\",\"admin_password\":\"${POSTGRES_PASSWORD}\"}" \
  --auto-provision \
  --auto-accept-invites \
  --auto-accept-requests \
  --auto-ping-connection \
  --label kyc-agent \
  --log-level info \
  --tails-server-base-url "${ACAPY_TAILS_SERVER_BASE_URL:-http://tails-server:6543}" \
  --preserve-exchange-records
