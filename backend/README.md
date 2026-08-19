# Backend — KYC API Server

Node.js / Express REST API that connects the frontend to Hyperledger Fabric, ACA-Py, and IPFS.

## Stack

- **Runtime**: Node.js 20, TypeScript
- **Framework**: Express 4
- **Fabric SDK**: `@hyperledger/fabric-gateway` v1.x (explicit gRPC + TLS via `@grpc/grpc-js`)
- **Auth**: JWT (`jsonwebtoken`) — `user` and `verifier` roles
- **Validation**: Zod schemas
- **Encryption**: AES-256-GCM + HKDF (Node.js built-in `crypto`)

## Commands

```bash
npm install
npm run dev       # ts-node-dev with hot reload on :3000
npm run build     # compile TypeScript → dist/
npm start         # run compiled dist/index.js
npm test          # jest (all test files)
npm run lint      # eslint
```

## Project structure

```
src/
├── config/
│   ├── index.ts              # typed config object from env vars
│   └── logger.ts             # winston logger
├── middleware/
│   ├── auth.middleware.ts    # JWT verify (authMiddleware) + verifier role guard
│   └── validation.middleware.ts  # Zod schemas for POST /kyc and PUT /kyc/:id/verify
├── routes/
│   ├── auth.routes.ts        # POST /api/auth/login
│   ├── kyc.routes.ts         # KYC lifecycle
│   ├── did.routes.ts         # DID management + DIDComm
│   └── document.routes.ts    # multer upload → IPFS
├── services/
│   ├── encryption.service.ts # AES-256-GCM + HKDF per-document key derivation
│   ├── fabric.service.ts     # Hyperledger Fabric Gateway client
│   ├── indy.service.ts       # ACA-Py REST client (DID, VC, DIDComm)
│   └── ipfs.service.ts       # IPFS Kubo API client
├── types/
│   └── kyc.types.ts          # shared TypeScript types
└── index.ts                  # app entry point, route mounting
```

## API endpoints

All endpoints except `/health` and `POST /api/auth/login` require `Authorization: Bearer <token>`.

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/auth/login` | — | Returns a signed JWT with `user` or `verifier` role |

### KYC

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/kyc?status=PENDING` | user/verifier | List records by status |
| `POST` | `/api/kyc` | user/verifier | Submit KYC — requires passport + selfie (encrypts docs → IPFS → Fabric) |
| `GET` | `/api/kyc/:id` | user/verifier | Get single record |
| `GET` | `/api/kyc/:id/history` | user/verifier | Full on-chain audit trail |
| `GET` | `/api/kyc/:id/documents` | **verifier** | Decrypt and return document previews |
| `GET` | `/api/kyc/did/:did` | user/verifier | Query records by DID |
| `PUT` | `/api/kyc/:id/verify` | **verifier** | `PENDING → VERIFIED` + issue VC |
| `PUT` | `/api/kyc/:id/reject` | **verifier** | `PENDING → REJECTED` with optional reason |
| `PUT` | `/api/kyc/:id/revoke` | **verifier** | `VERIFIED → REVOKED` |

### DID

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/did` | user/verifier | Create a new DID in the ACA-Py wallet |
| `GET` | `/api/did/:did` | user/verifier | Resolve DID document |
| `GET` | `/api/did/:did/credentials` | user/verifier | List issued VCs for a DID |
| `POST` | `/api/did/:did/connect` | user/verifier | Create OOB DIDComm invitation |
| `GET` | `/api/did/:did/connection-status` | user/verifier | Check if DIDComm connection is active |

### Documents

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/documents/upload` | user/verifier | Upload a single file (multer, 10 MB limit) → IPFS |
| `GET` | `/api/documents/:cid?documentId=` | user/verifier | Download and decrypt a document by CID |

## KYC submission flow

1. Frontend sends `POST /api/kyc` with `did` + array of base64 documents — `passport` and `selfie` are required (validated server-side)
2. Each document is encrypted with a per-document key derived via HKDF from `${kycId}-${doc.type}` and uploaded to IPFS
3. An encrypted manifest `{ kycId, did, documents: [{ type, fileName, cid }] }` is built and uploaded to IPFS — only the manifest CID goes on-chain
4. `FabricService.submitKYC(id, did, manifestCid)` writes a `KYCRecord{ status: PENDING }` to the Fabric ledger

## Encryption

All document encryption uses `EncryptionService` (`src/services/encryption.service.ts`):

- **Algorithm**: AES-256-GCM
- **Key derivation**: HKDF-SHA256 — a unique 32-byte key per document, derived from `ENCRYPTION_MASTER_KEY` with the `documentId` as salt
- **Master key**: read from `ENCRYPTION_MASTER_KEY` env var (64 hex chars / 32 bytes)

> **Never change `ENCRYPTION_MASTER_KEY` after first use** — all existing IPFS documents become unreadable.

## Fabric connection

`FabricService` uses `@hyperledger/fabric-gateway` with explicit gRPC TLS:

- TLS CA cert: `crypto-config/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt`
- Admin identity: `crypto-config/.../users/Admin@org1.example.com/msp/`
- Peer: `peer0.org1.example.com:7051`

The connection is lazy (established on first transaction) and reused across requests.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `NODE_ENV` | `development` | |
| `ENCRYPTION_MASTER_KEY` | — | **Required.** 64 hex chars. Never change after first run. |
| `JWT_SECRET` | `change-me-jwt-secret` | **Change before any non-local deployment.** |
| `VERIFIER_USERNAME` / `VERIFIER_PASSWORD` | `verifier` / `verifier-pass` | Verifier credentials |
| `USER_USERNAME` / `USER_PASSWORD` | `user` / `user-pass` | Applicant credentials |
| `FABRIC_CHANNEL` | `kycchannel` | Fabric channel name |
| `FABRIC_CHAINCODE` | `kyccc` | Chaincode name |
| `FABRIC_CRYPTO_CONFIG_PATH` | `./crypto-config` | Path to Fabric crypto material |
| `FABRIC_MSP_ID` | `Org1MSP` | MSP identifier |
| `FABRIC_AS_LOCALHOST` | `false` | Set `true` when running backend outside Docker |
| `ACAPY_ADMIN_URL` | `http://localhost:8031` | ACA-Py admin API base URL |
| `ACAPY_API_KEY` | — | ACA-Py admin API key (if configured) |
| `IPFS_API_URL` | `http://localhost:5001` | Kubo IPFS API URL |
| `CORS_ORIGIN` | `http://localhost` | Allowed CORS origin |

## Docker

```bash
docker compose up -d backend
docker compose logs -f backend

# After rebuilding (required on WSL2 — plain restart fails):
docker compose build backend
docker compose up -d --force-recreate backend
```

## Testing

```bash
npm test               # run all tests
npm run test:watch     # watch mode
```

Tests use Jest + Supertest. Services are injected with mock contracts/axios instances — no live Fabric, ACA-Py, or IPFS required.