# Zero-Persistence eKYC System

A decentralized Know Your Customer (KYC) platform built for academic research, combining **Hyperledger Fabric**, **Hyperledger Indy / ACA-Py**, **HashiCorp Vault**, and **IPFS** to provide tamper-proof identity verification with self-sovereign credentials, privacy-preserving document storage, and GDPR-compliant data erasure.

> Research paper: *"Zero-Persistence eKYC: A Dual-Ledger Architecture for Public Sector Identity Verification"* — Springer LLNCS format.

---

## Architecture

```
┌──────────────┐   ┌────────────────┐   ┌───────────────────┐
│ KYC Frontend │   │  Bank Frontend │   │   BC Wallet (iOS) │
│  (React 18)  │   │  (Vanilla JS)  │   │   Mobile App      │
└──────┬───────┘   └───────┬────────┘   └────────┬──────────┘
       │                   │                      │ DIDComm
       ▼                   ▼                      │
┌──────────────────────────────────────┐          │
│          Backend  (Express / TS)     │          │
│                                      │          │
│  FabricService   VaultService        │   ┌──────▼──────────┐
│  IndyService     IpfsService         │   │  ACA-Py Agents  │
└──────┬──────────────┬────────────────┘   │  KYC  + Bank    │
       │              │                    └──────┬──────────┘
       ▼              ▼                           │
┌────────────┐  ┌──────────────┐                 ▼
│ Hyperledger│  │  IPFS Kubo   │    ┌────────────────────────┐
│   Fabric   │  │ (encrypted   │    │   Hyperledger Indy     │
│  + CouchDB │  │    blobs)    │    │  (BCovrin test ledger) │
└────────────┘  └──────────────┘    └────────────────────────┘
       ▲
       │ Vault Transit
┌──────┴───────┐
│  HashiCorp   │
│    Vault     │
└──────────────┘
```

### KYC State Machine

```
PENDING ──► VERIFIED ──► REVOKED   (terminal)
   ▲            │
   │            └──► PENDING  (ResubmitKYC — new documents)
   │
REJECTED ──► PENDING  (ResubmitKYC — re-submit after rejection)

Any non-REVOKED state ──► DELETED  (GDPR Art. 17 erasure)
```

Transition guards live in `chaincode/model.go`. Every state change is recorded in the Fabric ledger and retrievable via `GetKYCHistory`. The ledger stores only the encrypted IPFS manifest CID — no personal data is ever written on-chain.

### Document Storage & Encryption

1. Each document is encrypted via **Vault Transit** (AES-256-GCM96) using a per-KYC-ID named key
2. Encrypted blobs are uploaded individually to IPFS (pinned, CIDv1)
3. An encrypted manifest `{ kycId, did, documents: [{type, fileName, cid}], dateOfBirth? }` is uploaded separately
4. Only the manifest CID is written to the Fabric ledger
5. On GDPR erasure: IPFS blobs are unpinned, Vault key is deleted — ciphertext becomes permanently undecryptable

### SSI Trust Triangle (Bank Verification)

```
KYC System (Issuer) ──issues VC──▶ BC Wallet (Holder)
                                          │
                               ZKP proof (age ≥ 18)
                                          ▼
                              Bank ACA-Py (Verifier)
                                          │
                               verifies against BCovrin
                                    (no backend call)
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| Ledger | Hyperledger Fabric 2.5 + CouchDB |
| Chaincode | Go 1.21 (`fabric-contract-api-go`) |
| Identity & VCs | Hyperledger Indy (BCovrin test ledger) + ACA-Py 1.0 |
| VC Schema | v3.0 — attributes: `kyc_id`, `verification_date`, `age` |
| Document storage | IPFS Kubo v0.26 |
| Encryption | HashiCorp Vault Transit (AES-256-GCM96), per-KYC-ID named keys |
| Secrets management | HashiCorp Vault KV (`secret/kyc`) |
| Backend | Node.js 20 + Express + TypeScript |
| KYC Frontend | React 18 + TypeScript (CRA) |
| Bank Frontend | Standalone HTML/JS (zero npm, zero build step) |
| Orchestration | Docker Compose |
| Logging | ELK Stack (Elasticsearch + Kibana + Filebeat) |

---

## Prerequisites

- Docker + Docker Compose v2
- Go 1.21+ (for local chaincode development only)
- Node.js 20+ (for local backend/frontend development only)
- `peer`, `configtxgen`, `cryptogen` binaries on `$PATH` (Fabric scripts)

---

## Quick Start

### 1. Configure environment

Copy and edit the environment file:

```bash
cp .env.example .env
```

Mandatory changes before first run:

```bash
# Generate strong secrets — these cannot be changed after first run
openssl rand -hex 32   # → ENCRYPTION_MASTER_KEY
openssl rand -hex 32   # → JWT_SECRET
openssl rand -hex 32   # → ACAPY_WALLET_KEY

# Set passwords
COUCHDB_PASSWORD=<strong-password>
POSTGRES_PASSWORD=<strong-password>
VERIFIER_PASSWORD=<strong-password>
USER_PASSWORD=<strong-password>
BANK_PASSWORD=<strong-password>
```

> **Indy ledger:** ACA-Py connects to the [BCovrin public test ledger](http://test.bcovrin.vonx.io) by default — internet access is required at runtime. For a fully local setup, run [von-network](https://github.com/bcgov/von-network) and set `INDY_GENESIS_URL=http://localhost:9000/genesis`.

### 2. Start the full stack

```bash
./scripts/start-network.sh
```

This script:
1. Generates Fabric crypto material and channel artifacts (idempotent)
2. Starts all Docker services
3. Deploys the Go chaincode (CaaS mode, sequence 1)
4. Waits for ACA-Py to be healthy

### 3. Provision ACA-Py (first time only)

```bash
bash acapy/scripts/provision.sh
```

Registers a new Indy DID + schema v3.0 + credential definition on BCovrin. Updates `.env` automatically with `KYC_CRED_DEF_ID`.

Then rebuild the frontend to bake in the new cred def:

```bash
docker compose build frontend
docker compose up -d --force-recreate frontend
```

### 4. Open the app

| URL | Description |
|-----|-------------|
| `http://localhost` | KYC Frontend (user + verifier) |
| `http://localhost:4000` | Bank Portal (isolated container) |
| `http://localhost:3000/health` | Backend health check |
| `http://localhost:8031` | KYC ACA-Py admin API |
| `http://localhost:8041` | Bank ACA-Py admin API |
| `http://localhost:5984/_utils` | CouchDB Fauxton |
| `http://localhost:8200` | HashiCorp Vault UI |
| `http://localhost:5601` | Kibana (ELK logging) |

### 5. Tear down

```bash
./scripts/stop-network.sh   # stops all containers and removes volumes
```

---

## User Flows

### Applicant

1. Login (`USER_USERNAME` / `USER_PASSWORD`) → **Submit KYC**
2. Enter DID + date of birth + upload passport + selfie → Submit
3. **Check Status** with Application ID → status: `PENDING`
4. Once `VERIFIED`: click **"Receive Credential in BC Wallet"** → scan QR → VC issued to wallet

### Verifier

1. Login (`VERIFIER_USERNAME` / `VERIFIER_PASSWORD`) → **Verifier Panel**
2. **Pending tab**: View Docs (decrypts + previews documents) → Approve or Reject with reason
3. **Verified tab**: Revoke a credential (transitions to `REVOKED`, revokes VC on Indy ledger)
4. **Rejected tab**: view rejected records (re-submittable by applicant)

### Bank (ZKP Age Verification)

1. Open Bank Portal → **Start Verification** → QR code appears
2. User scans with BC Wallet → DIDComm connection established
3. Bank sends proof request: `age ≥ 18` (AnonCreds ZKP predicate)
4. Wallet responds with zero-knowledge proof — age is never revealed
5. Bank verifies proof against BCovrin ledger — **no contact with KYC backend**

### GDPR Right to Erasure (Art. 17)

```bash
curl -X DELETE http://localhost:3000/api/kyc/<id> \
  -H "Authorization: Bearer <token>"
```

This: unpins all IPFS blobs → deletes Vault transit key (ciphertext permanently undecryptable) → revokes VC on Indy ledger → marks record `DELETED` on Fabric (clears `ipfsHash`, `credDefId`, personal data references).

---

## Post-teardown Recovery (`docker compose down -v`)

After a full teardown (volumes wiped), three extra steps are required beyond `start-network.sh`:

### Step 1 — Re-upload tails file to tails-server

```bash
curl -sf "https://test.bcovrin.vonx.io/genesis" -o /tmp/genesis.txn

REV_REG=$(curl -sf http://localhost:8031/revocation/registries/created \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['rev_reg_ids'][0])")

TAILS_HASH=$(curl -sf "http://localhost:8031/revocation/registry/${REV_REG}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['tails_hash'])")

docker cp "kyc2-system-acapy-agent-1:/home/aries/.indy_client/tails/${REV_REG}/${TAILS_HASH}" /tmp/tails_file

curl -X PUT "http://localhost:6543/${REV_REG}" \
  -F "genesis=@/tmp/genesis.txn" \
  -F "tails=@/tmp/tails_file"
```

### Step 2 — Publish revocation accumulator to BCovrin

Run this **after** issuing at least one credential:

```bash
REV_REG=$(curl -sf http://localhost:8031/revocation/registries/created \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['rev_reg_ids'][0])")

curl -s -X POST "http://localhost:8031/revocation/registry/${REV_REG}/entry"
```

### Step 3 — Rebuild frontend with new Cred Def ID

```bash
REACT_APP_CRED_DEF_ID=$(grep "^REACT_APP_CRED_DEF_ID" .env | cut -d= -f2)
docker compose build \
  --build-arg REACT_APP_API_URL=http://localhost \
  --build-arg REACT_APP_CRED_DEF_ID="$REACT_APP_CRED_DEF_ID" \
  frontend
docker compose up -d --force-recreate frontend
```

---

## Authentication

Two roles with pre-configured credentials in `.env`:

| Role | Env vars | Permissions |
|------|----------|-------------|
| `user` | `USER_USERNAME` / `USER_PASSWORD` | Submit KYC, check status, receive VC, GDPR erasure |
| `verifier` | `VERIFIER_USERNAME` / `VERIFIER_PASSWORD` | All of the above + approve/reject/revoke + view docs |
| `bank` | `BANK_USERNAME` / `BANK_PASSWORD` | Bank portal — create OOB invitation, send proof request |

```bash
# Get a JWT
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"user","password":"<USER_PASSWORD>"}'
# → { "token": "eyJ...", "role": "user", "expiresIn": "24h" }

# Use it
curl http://localhost:3000/api/kyc/<id> \
  -H "Authorization: Bearer <token>"
```

---

## API Reference

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/auth/login` | — | Exchange credentials for a signed JWT |

### KYC Lifecycle

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/kyc?status=PENDING` | verifier | List records by status |
| `POST` | `/api/kyc` | user | Submit new KYC application |
| `GET` | `/api/kyc/:id` | user | Get a KYC record |
| `GET` | `/api/kyc/:id/history` | user | Full on-chain audit trail (all state transitions + TxIDs) |
| `GET` | `/api/kyc/:id/documents` | verifier | Decrypt manifest + documents; returns base64 previews |
| `GET` | `/api/kyc/:id/my-data` | user | GDPR Art. 15 — applicant views their own documents |
| `DELETE` | `/api/kyc/:id` | user | GDPR Art. 17 — erase record (unpin IPFS, delete Vault key, revoke VC) |
| `GET` | `/api/kyc/did/:did` | user | List all records for a DID |
| `PUT` | `/api/kyc/:id/verify` | verifier | Approve: `PENDING → VERIFIED`; issues VC (best-effort) |
| `PUT` | `/api/kyc/:id/reject` | verifier | Reject: `PENDING → REJECTED` with optional reason |
| `PUT` | `/api/kyc/:id/revoke` | verifier | Revoke: `VERIFIED → REVOKED`; revokes VC on Indy ledger |
| `PUT` | `/api/kyc/:id/resubmit` | user | Re-submit: `VERIFIED\|REJECTED → PENDING` with new documents |
| `GET` | `/api/kyc/:id/wallet-invitation` | user | Create DIDComm OOB invitation QR for BC Wallet |
| `GET` | `/api/kyc/:id/wallet-connection/:oobId` | user | Poll whether wallet has scanned QR |
| `POST` | `/api/kyc/:id/send-credential` | user | Issue VC to connected wallet |

**POST /api/kyc — body**
```json
{
  "did": "did:indy:test:ABC123",
  "dateOfBirth": "1995-06-15",
  "documents": [
    { "type": "passport", "fileName": "passport.jpg", "contentBase64": "<base64>" },
    { "type": "selfie",   "fileName": "selfie.jpg",   "contentBase64": "<base64>" }
  ]
}
```
Accepted types: `passport`, `national_id`, `drivers_license`, `selfie`. Passport + selfie are required.

### DID Management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/did` | user | Create DID in ACA-Py wallet + publish NYM to Indy ledger |
| `GET` | `/api/did/:did` | user | Resolve DID Document |
| `GET` | `/api/did/:did/credentials` | user | List credentials issued to a DID |
| `POST` | `/api/did/:did/connect` | user | Create DIDComm OOB invitation |
| `GET` | `/api/did/:did/connection-status` | user | Poll active DIDComm connection |

### Document Storage

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/documents/upload` | user | Encrypt + upload file to IPFS (multipart, max 10 MB) |
| `GET` | `/api/documents/:cid` | user | Fetch + decrypt file from IPFS |

### Bank Verification

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/bank/invitation` | bank | Create DIDComm OOB invitation (QR code) |
| `GET` | `/api/bank/connection/:oobId` | bank | Poll whether holder has connected |
| `POST` | `/api/bank/proof-request` | bank | Send ZKP proof request (`age ≥ 18`, `non_revoked`) |
| `GET` | `/api/bank/proof-result/:presExId` | bank | Poll proof result; auto-verifies on `presentation-received` |

---

## Chaincode Functions (Go)

| Function | Transition | Description |
|----------|-----------|-------------|
| `SubmitKYC` | → `PENDING` | Create new KYC record |
| `VerifyKYC` | `PENDING → VERIFIED` | Approve; stores `credDefId` |
| `RejectKYC` | `PENDING → REJECTED` | Reject with optional `rejectionReason` |
| `RevokeKYC` | `VERIFIED → REVOKED` | Terminal revocation |
| `ResubmitKYC` | `VERIFIED\|REJECTED → PENDING` | Re-open with new IPFS manifest CID |
| `StoreCredExchangeID` | (VERIFIED only) | Persist ACA-Py exchange ID for later VC revocation |
| `EraseKYC` | any → `DELETED` | GDPR Art. 17 — clears personal data references on-chain |
| `GetKYC` | — | Read single record |
| `GetKYCHistory` | — | Full audit trail via `GetHistoryForKey` |
| `QueryByDID` | — | CouchDB rich query by DID |
| `QueryByStatus` | — | CouchDB rich query by status |

---

## Development

### Chaincode (Go)

```bash
cd chaincode
go build ./...
go test ./...         # 20+ unit tests, full lifecycle coverage
```

### Backend

```bash
cd backend
npm install
npm run dev           # ts-node-dev, hot reload on :3000
npm test              # jest (162 tests)
npm run lint          # eslint
npm run build         # compile TypeScript → dist/
```

### Frontend

```bash
cd frontend
npm install --legacy-peer-deps
npm start             # CRA dev server on :3001
npm test
npm run build
```

### Rebuild a single Docker service

```bash
docker compose build backend
docker compose up -d --force-recreate backend
docker compose logs -f backend
```

> On WSL2: `docker compose restart` may fail after file replacement. Always use `--force-recreate`.

### Smoke test (end-to-end via curl)

```bash
bash scripts/test-kyc.sh [BASE_URL]
# Runs: login → create DID → submit KYC → poll PENDING → queryByDID → OOB invitation → role guard
```

### Bank verification smoke test

```bash
bash scripts/test-bank-verify.sh [BASE_URL]
```

---

## Project Structure

```
kyc-system/
├── chaincode/                    # Go chaincode (Hyperledger Fabric)
│   ├── kyc.go                    # 11 contract functions
│   ├── model.go                  # KYCRecord struct + state machine
│   └── kyc_test.go               # Unit tests (MockStub)
├── backend/
│   └── src/
│       ├── bootstrap.ts          # Vault KV secret injection (runs before config)
│       ├── index.ts              # Server entry point (async IIFE, dynamic imports)
│       ├── routes/               # kyc, did, document, bank, auth routes
│       ├── services/
│       │   ├── fabric.service.ts # Hyperledger Fabric Gateway client
│       │   ├── vault.service.ts  # HashiCorp Vault Transit (encrypt/decrypt/delete key)
│       │   ├── indy.service.ts   # ACA-Py REST client (DIDs, VCs, revocation, OOB)
│       │   └── ipfs.service.ts   # IPFS Kubo client (upload, download, pin/unpin)
│       ├── middleware/           # Zod validation, JWT auth + role guards, CORS
│       ├── config/               # Typed env config + Winston logger
│       └── types/                # KYCRecord, SubmitKYCRequest, VerifyKYCRequest
├── frontend/
│   └── src/
│       ├── components/           # KYCForm, DocumentUpload, VerificationStatus
│       ├── pages/                # Home, Submit, Status, Login, Verifier, Bank
│       └── services/api.ts       # APIClient — all endpoints
├── bank-frontend/                # Isolated bank portal (vanilla HTML/JS, no npm)
│   ├── public/index.html
│   └── Dockerfile                # Nginx + sed substitutes __API_URL__ at build time
├── fabric/
│   ├── configtx.yaml             # Channel + org configuration
│   ├── crypto-config.yaml        # cryptogen config
│   └── scripts/
│       ├── network.sh            # Fabric network lifecycle
│       └── deploy-chaincode.sh   # CaaS package + install + approve + commit
├── acapy/
│   └── scripts/
│       ├── provision.sh          # Register DID + schema + cred def on BCovrin
│       ├── acapy-start.sh        # Fetch Vault secrets + exec aca-py start
│       └── bank-acapy-start.sh   # Same for bank agent
├── scripts/
│   ├── start-network.sh          # Full stack startup
│   ├── stop-network.sh           # Teardown + volume removal
│   ├── test-kyc.sh               # End-to-end curl smoke test
│   └── test-bank-verify.sh       # Bank ZKP verification smoke test
├── benchmarks/
│   ├── caliper/                  # Hyperledger Caliper (Fabric throughput)
│   └── k6/                       # k6 load tests (API throughput)
├── iac/                          # Ansible playbooks for VPS setup + nginx SSL
├── docker-compose.yml
├── filebeat.yml                  # Filebeat autodiscover config (Docker labels)
└── .env.example
```

---

## Configuration Reference

Key `.env` variables:

| Variable | Description | Notes |
|----------|-------------|-------|
| `ENCRYPTION_MASTER_KEY` | 64 hex chars (32-byte AES key) | **Never change after first run** — invalidates all IPFS documents |
| `JWT_SECRET` | JWT signing secret | Change before any non-local deployment |
| `ACAPY_WALLET_KEY` | ACA-Py wallet encryption key | Change before any non-local deployment |
| `KYC_CRED_DEF_ID` | Indy credential definition ID | Written by `provision.sh`; must match `REACT_APP_CRED_DEF_ID` |
| `REACT_APP_CRED_DEF_ID` | Baked into frontend bundle at build time | Must match `KYC_CRED_DEF_ID`; rebuild frontend after change |
| `VAULT_TOKEN` | HashiCorp Vault dev root token | `root` for dev mode |
| `CORS_ORIGIN` | Allowed CORS origin(s) | Comma-separated; supports `startsWith` check for multi-port |
| `ACAPY_ENDPOINT` | Public URL for KYC ACA-Py DIDComm | Must be reachable by mobile wallets |
| `BANK_ACAPY_ENDPOINT` | Public URL for bank ACA-Py DIDComm | Must be reachable by mobile wallets |
| `INDY_GENESIS_URL` | Indy genesis file URL | Default: BCovrin test ledger |

---

## Security Notes

- **Vault Transit** is the sole encryption provider. The backend never handles raw document plaintext at rest — all encrypt/decrypt operations go through Vault, which logs every call.
- **No personal data on-chain.** Fabric stores only `{ id, did, status, ipfsHash (manifest CID), credDefId, credentialExchangeId, timestamps }`.
- **GDPR Art. 17 (right to erasure):** `DELETE /api/kyc/:id` unpins IPFS content, deletes the Vault transit key (making ciphertext permanently undecryptable), revokes the VC, and marks the record `DELETED` on-chain.
- **Zero-knowledge proof:** The bank never sees the applicant's actual age — only a cryptographic proof that `age ≥ 18`.
- **Non-revocation proof:** Bank proof requests include `non_revoked: { to: now }`, so revoked credentials are rejected by the wallet.
- **JWT expiry:** Tokens expire after 24 hours. The secret is configurable via `JWT_SECRET`.

---

## Known Limitations

| Limitation | Detail | Production fix |
|-----------|--------|----------------|
| Shared Vault key namespace | All users share one Vault instance; transit keys are per-KYC-ID, not per-user | Per-user Vault namespaces or AWS KMS |
| Static credentials | No user registration — credentials in `.env` | `POST /api/auth/register` + bcrypt + users table |
| Local DID publication | `POST /api/did` publishes to BCovrin ledger (NYM tx), but DIDs are only resolvable on BCovrin, not universally | Switch to `did:peer` or a universally resolvable DID method |
| Single-org Fabric | One organization, one peer — no multi-org endorsement policy | Add Org2 to `configtx.yaml` (e.g. bank as Org2) |
| Vault dev mode | Vault runs in `-dev` mode (in-memory, no persistence) | Production Vault with storage backend + TLS |
| BCovrin dependency | ACA-Py requires internet access to BCovrin at runtime | Run [von-network](https://github.com/bcgov/von-network) for fully offline setup |

---

## License

MIT
