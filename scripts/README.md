# Scripts

Shell scripts for orchestrating the full KYC stack.

## Lifecycle

### `start-network.sh`

Brings up the complete stack in the correct order:

1. Generate Fabric crypto material and channel artifacts (if not already present)
2. Start Fabric services (CA, orderer, peer, CouchDB)
3. Create and join the channel
4. Build and deploy the KYC chaincode (CaaS mode)
5. Start remaining Docker Compose services (Vault, IPFS, ACA-Py, backend, frontend)

```bash
./scripts/start-network.sh

# Deploy with a specific chaincode version and sequence number
CC_VERSION=2.0 CC_SEQUENCE=2 ./scripts/start-network.sh
```

### `stop-network.sh`

Tears down all services and removes Docker volumes.

```bash
./scripts/stop-network.sh
```

> **Warning**: removes all persisted data including the Fabric ledger, Vault storage, IPFS pins, and ACA-Py wallet. After running this, re-run `provision.sh` and follow the post-teardown recovery steps in the root README.

## ACA-Py Startup

### `acapy-start.sh`

Entrypoint for the `acapy-agent` Docker container. Fetches `ACAPY_WALLET_KEY` and `POSTGRES_PASSWORD` from HashiCorp Vault KV (`secret/kyc`), exports them into the environment, then `exec aca-py start` with the full flag set.

Uses an inline Python 3 heredoc to call the Vault HTTP API — the container has no `curl` or `jq`.

### `bank-acapy-start.sh`

Same pattern for the `bank-acapy` container (Bank Verifier agent, ports 8040/8041, wallet `bank-wallet`).

## Testing

### `test-kyc.sh`

Smoke-tests the full KYC lifecycle against a running stack using `curl`:

1. Login as `user` → get JWT
2. `POST /api/did` → create and publish DID
3. `POST /api/kyc` → submit KYC with test passport + selfie (base64 encoded)
4. Login as `verifier`
5. `PUT /api/kyc/:id/verify` → approve
6. `GET /api/kyc/:id` → confirm `VERIFIED`

```bash
# Against local stack (default)
bash scripts/test-kyc.sh

# Against a remote deployment
BASE_URL=https://your-domain.example.com bash scripts/test-kyc.sh
```

## Environment

All scripts read configuration from the `.env` file in the repo root. The most relevant variables:

| Variable | Used by |
|----------|---------|
| `CC_VERSION` | `start-network.sh`, `deploy-chaincode.sh` |
| `CC_SEQUENCE` | `start-network.sh`, `deploy-chaincode.sh` |
| `VAULT_ADDR` / `VAULT_TOKEN` | `acapy-start.sh`, `bank-acapy-start.sh` |
| `ACAPY_WALLET_KEY` | seeded into Vault by `vault-init`; fetched at runtime by `acapy-start.sh` |
| `BASE_URL` | `test-kyc.sh` |
