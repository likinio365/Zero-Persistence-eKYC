# Backend — Node.js / Express API

TypeScript Express application providing the KYC lifecycle REST API. Bridges Hyperledger Fabric (ledger), IPFS (document storage), HashiCorp Vault (encryption), and ACA-Py (verifiable credentials).

## Project Structure

```
backend/src/
├── index.ts                      # entry point — async IIFE, dynamic imports after bootstrap
├── bootstrap.ts                  # fetches Vault KV secrets → populates process.env
├── config/
│   └── index.ts                  # typed config object (Fabric, ACA-Py, IPFS, Vault, auth, port)
├── services/
│   ├── fabric.service.ts         # Fabric Gateway v1.x — all chaincode calls
│   ├── vault.service.ts          # Vault Transit — per-KYC-ID encrypt/decrypt
│   ├── ipfs.service.ts           # IPFS Kubo — upload/download/pin/unpin
│   └── indy.service.ts           # ACA-Py REST — DID, VC issuance, revocation, connections
├── routes/
│   ├── kyc.routes.ts             # KYC lifecycle
│   ├── bank.routes.ts            # bank verifier (ZKP proof flow)
│   ├── did.routes.ts             # DID management
│   ├── document.routes.ts        # document upload / retrieval
│   └── auth.routes.ts            # JWT login
├── middleware/
│   ├── auth.middleware.ts        # JWT verify + requireVerifier + requireBank role guards
│   └── validation.middleware.ts  # Zod schemas for submit and verify requests
└── types/
    └── kyc.types.ts              # shared TS types
```

## Services

### FabricService
`@hyperledger/fabric-gateway` v1.x client with explicit gRPC+TLS via `@grpc/grpc-js`. Reads TLS CA cert and Admin identity directly from `crypto-config/`. No connection profile file needed.

### VaultService
HashiCorp Vault Transit Secrets Engine. Creates a per-KYC-ID named key (`kyc/<id>`) on first use. All document encryption/decryption is delegated to Vault — the backend never sees raw plaintext keys. Cipher: `aes256-gcm96`.

### IpfsService
IPFS Kubo HTTP API client. Uploads blobs with CIDv1 + pinning. Downloads and unpins on GDPR erasure.

### IndyService
ACA-Py REST client. Handles DID creation, ledger publication (`POST /ledger/register-nym`), VC issuance (v2.0), revocation, and DIDComm connection lookups.

## API

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | — | Returns signed JWT with `user`, `verifier`, or `bank` role |

### KYC Lifecycle

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/kyc` | verifier | List all KYC records (optional `?status=PENDING`) |
| POST | `/api/kyc` | user | Submit new KYC application |
| GET | `/api/kyc/:id` | user/verifier | Get KYC record by ID |
| GET | `/api/kyc/:id/history` | user/verifier | Full on-chain audit trail |
| GET | `/api/kyc/:id/documents` | verifier | Decrypt + return all documents as base64 previews |
| PUT | `/api/kyc/:id/verify` | verifier | Approve KYC; issue VC (best-effort) |
| PUT | `/api/kyc/:id/reject` | verifier | Reject with optional reason |
| PUT | `/api/kyc/:id/revoke` | verifier | Revoke KYC + VC |
| PUT | `/api/kyc/:id/resubmit` | user | Upload new documents after rejection or re-submit after verification |
| DELETE | `/api/kyc/:id` | user | GDPR Art. 17 erasure — unpin IPFS, delete Vault key, revoke VC, mark DELETED |
| GET | `/api/kyc/:id/my-data` | user | GDPR Art. 15 — export all personal data for a KYC record |

### Wallet (VC Issuance to BC Wallet)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/kyc/:id/wallet-invitation` | user | Create OOB DIDComm invitation → QR data |
| GET | `/api/kyc/:id/wallet-connection/:oobId` | user | Poll connection status |
| POST | `/api/kyc/:id/send-credential` | user | Issue VC to connected wallet |

### DID Management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/did` | user | Create DID in ACA-Py wallet + publish to Indy ledger |
| GET | `/api/did/:did` | user | Resolve DID |
| GET | `/api/did/:did/credentials` | user | List credentials held for DID |
| POST | `/api/did/:did/connect` | user | Create OOB invitation for DIDComm connection |
| GET | `/api/did/:did/connection-status` | user | Poll connection state |

### Bank Verification (ZKP)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/bank/invitation` | bank | Create OOB QR invitation via bank-acapy |
| GET | `/api/bank/connection/:oobId` | bank | Poll DIDComm connection |
| POST | `/api/bank/proof-request` | bank | Send AnonCreds proof request (`age ≥ 18`) |
| GET | `/api/bank/proof-result/:presExId` | bank | Poll proof verification result; calls verify-presentation if needed |

### Documents

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/documents/upload` | user | Multer upload → IPFS (10 MB limit) |
| GET | `/api/documents/:cid` | user | Download + decrypt document by CID |

## Encryption

All documents are encrypted using **HashiCorp Vault Transit** (`aes256-gcm96`). A named key is created per KYC ID — Vault manages key material and rotation. The backend only passes ciphertext in and out; plaintext keys never leave Vault.

Data flow for document submission:
1. Each document encrypted individually with `VaultService.encrypt(kycId, plaintextBase64)`
2. Encrypted blobs uploaded to IPFS
3. A manifest JSON (`{ kycId, did, documents: [{ type, fileName, cid }], dateOfBirth? }`) is encrypted and also uploaded to IPFS
4. Only the **manifest CID** is written to the Fabric ledger

## Vault Bootstrap

`bootstrap.ts` runs before any other module. It fetches all secrets from Vault KV (`secret/kyc`) and writes them into `process.env`. Then `index.ts` uses `await import()` (dynamic) for all modules that depend on config, ensuring `config/index.ts` evaluates after secrets are in place.

If Vault is unreachable, bootstrap logs a warning and continues — the service will fail later on the first encrypted operation.

## Authentication

JWT Bearer tokens issued by `POST /api/auth/login`. Three roles:

| Role | Credentials env vars | Access |
|------|---------------------|--------|
| `user` | `USER_USERNAME` / `USER_PASSWORD` | submit, status, resubmit, wallet, GDPR delete |
| `verifier` | `VERIFIER_USERNAME` / `VERIFIER_PASSWORD` | approve, reject, revoke, documents |
| `bank` | `BANK_USERNAME` / `BANK_PASSWORD` | bank proof flow |

## Development

```bash
cd backend
npm install
npm run dev        # ts-node-dev hot reload on :3000
npm test           # jest
npm run lint       # eslint
npm run build      # compile → dist/
```

## Key Environment Variables

| Variable | Description |
|----------|-------------|
| `VAULT_ADDR` | Vault address (default `http://vault:8200`) |
| `VAULT_TOKEN` | Vault token |
| `VAULT_ENABLED` | Must be `true` — otherwise `validateConfig()` throws |
| `FABRIC_CHANNEL` | Channel name (default `kycchannel`) |
| `FABRIC_CHAINCODE` | Chaincode name (default `kyccc`) |
| `FABRIC_MSP_ID` | MSP ID (default `Org1MSP`) |
| `FABRIC_CRYPTO_CONFIG_PATH` | Path to crypto material |
| `ACAPY_ADMIN_URL` | KYC issuer ACA-Py admin URL |
| `BANK_ACAPY_ADMIN_URL` | Bank verifier ACA-Py admin URL |
| `JWT_SECRET` | JWT signing secret |
| `CORS_ORIGIN` | Allowed CORS origin |

See `.env.example` for the full list.

## Docker

```bash
docker compose build backend
docker compose up -d --force-recreate backend
docker compose logs -f backend
```
