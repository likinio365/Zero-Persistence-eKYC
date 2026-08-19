# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

KYC (Know Your Customer) decentralized identity system combining:

- **Hyperledger Fabric** — immutable KYC record ledger with Go chaincode
- **Hyperledger Indy + ACA-Py** — self-sovereign DIDs and Verifiable Credentials
- **IPFS** — encrypted document storage (Vault Transit ciphertext tokens)
- **Node.js / Express** — backend API
- **React** — frontend
- **Docker Compose** — local stack orchestration

## Academic Paper

The system is described in a Springer LLNCS paper:

- **File**: `trash/Paper/paper_extracted/merged.tex` — working version (all corrections applied)
- **Title**: "Zero-Persistence eKYC: A Dual-Ledger Architecture for Public Sector Identity Verification"
- **Figures**: `trash/Paper/paper_extracted/figures/kyc-*-V2.png`

### Key paper rules (do NOT violate)
- **Vault Transit** (aes256-gcm96) = production primary encryption. Never describe as secondary or optional.
- **EncryptionService / HKDF / AES-256-GCM** = fallback only, never mentioned in the paper.
- **REVOKED** is the sole terminal state. REJECTED is NOT terminal (ResubmitKYC resets it to PENDING).
- **Two ACA-Py agents**: KYC Issuer (:8030/:8031) + Bank Verifier (:8040/:8041).
- **VC schema v3.0**: attributes `kyc_id`, `verification_date`, `age`. The `age` is computed server-side from `dateOfBirth` at verification time.
- **9 chaincode functions**: SubmitKYC, VerifyKYC, RejectKYC, RevokeKYC, ResubmitKYC, GetKYC, GetKYCHistory, QueryByDID, QueryByStatus.
- **4 backend domain services**: FabricService, VaultService, IpfsService, IndyService.

## Commands

### Full stack

```bash
./scripts/start-network.sh   # bring up everything
./scripts/stop-network.sh    # tear down + remove volumes
```

### Hyperledger Fabric

```bash
./fabric/scripts/network.sh up          # start Fabric services (CA, orderer, peer, CouchDB)
./fabric/scripts/network.sh down
./fabric/scripts/network.sh generate    # generate crypto material and channel artifacts
./fabric/scripts/deploy-chaincode.sh    # package, install, approve, and commit chaincode
```

### Go chaincode

```bash
cd chaincode
go build ./...
go test ./...
```

### Backend

```bash
cd backend
npm install
npm run dev       # ts-node-dev with hot reload on :3000
npm run build     # compile TypeScript → dist/
npm test          # jest
npm run lint      # eslint
```

### Frontend

```bash
cd frontend
npm install
npm start         # CRA dev server on :3000
npm run build     # production build → build/
npm test          # jest
```

### Docker Compose

```bash
docker compose up -d              # all services
docker compose up -d backend      # single service
docker compose logs -f backend    # follow logs
```

## Architecture

### Data flow for a KYC submission

1. Frontend → `POST /api/kyc` with DID + base64 documents + optional `dateOfBirth` (YYYY-MM-DD)
2. Backend encrypts each document individually via Vault Transit (per-KYC-ID named key, `aes256-gcm96`) and uploads each encrypted blob to IPFS
3. Backend builds an encrypted **manifest** (`{ kycId, did, documents: [{ type, fileName, cid }], dateOfBirth? }`) and uploads it to IPFS — only the manifest CID is written to the ledger
4. Backend calls `FabricService.submitKYC(id, did, manifestCid)` → chaincode writes `KYCRecord{status: PENDING}` to ledger
5. Verifier calls `PUT /api/kyc/:id/verify` with `credDefId` → chaincode transitions `PENDING → VERIFIED`; backend decrypts manifest, calculates age from `dateOfBirth`, issues VC with `{ kyc_id, verification_date, age }` over DIDComm connection
6. Revocation: `PUT /api/kyc/:id/revoke` → chaincode transitions `VERIFIED → REVOKED`; VC revoked via ACA-Py if `credentialExchangeId` provided
7. Re-submission: `PUT /api/kyc/:id/resubmit` (VERIFIED or REJECTED → PENDING) — user uploads new docs, new IPFS manifest, chaincode resets status
8. Bank verification: bank-acapy (Verifier role) creates DIDComm OOB invitation → user scans QR with BC Wallet → bank sends proof request with `age >= 18` ZKP predicate → wallet responds with AnonCreds proof → bank verifies against Indy ledger (no contact with KYC backend)

### State machine (chaincode/model.go)

```
PENDING ──► VERIFIED ──► REVOKED  (terminal)
PENDING ──► REJECTED
VERIFIED ──► PENDING   (ResubmitKYC — new documents uploaded)
REJECTED ──► PENDING   (ResubmitKYC — re-submit after rejection)
any      ──► DELETED   (EraseKYC — GDPR Art. 17, terminal; clears ipfsHash)
```

Transition guard lives in `KYCRecord.canTransitionTo()`. `RejectKYC` stores an optional `rejectionReason` on-chain. `ResubmitKYC` clears `credDefId` and `rejectionReason`, updates `ipfsHash` with the new manifest CID. `EraseKYC` clears `ipfsHash` (ciphertext unreachable after Vault key deletion). `GetKYCHistory` returns the full audit trail via `GetHistoryForKey`.

### Key files

| Path | Purpose |
|------|---------|
| `chaincode/kyc.go` | Chaincode contract — `SubmitKYC`, `VerifyKYC`, `RejectKYC`, `RevokeKYC`, `ResubmitKYC`, `StoreCredExchangeID`, `EraseKYC`, `GetKYC`, `GetKYCHistory`, `QueryByDID`, `QueryByStatus` |
| `chaincode/model.go` | `KYCRecord` + `HistoryEntry` structs; state machine with resubmit transitions |
| `chaincode/kyc_test.go` | 20+ unit tests covering full lifecycle, reject path, and invalid transitions |
| `backend/src/bootstrap.ts` | Fetches secrets from Vault KV (`secret/kyc`) and populates `process.env` before config module evaluates; falls back gracefully if Vault unreachable |
| `backend/src/index.ts` | Async IIFE with dynamic imports — bootstrap runs first so `config` is evaluated AFTER Vault secrets are in `process.env` |
| `backend/src/services/vault.service.ts` | HashiCorp Vault Transit client — per-KYC-ID named keys, `encrypt`/`decrypt` wrappers; sole encryption path |
| `backend/src/services/fabric.service.ts` | `@hyperledger/fabric-gateway` v1.x client; explicit gRPC+TLS via `@grpc/grpc-js`; reads TLS CA cert and Admin identity directly from `crypto-config/` |
| `backend/src/services/indy.service.ts` | ACA-Py REST client — DID create/resolve, VC issuance (v2.0), revocation, connection lookup |
| `backend/src/services/ipfs.service.ts` | IPFS Kubo client — upload (pin + CIDv1), download, explicit pin/unpin |
| `backend/src/routes/kyc.routes.ts` | KYC lifecycle: GET `/api/kyc?status=`, POST `/api/kyc`, PUT `/:id/resubmit`, GET `/:id`, GET `/:id/history`, GET `/:id/documents`, GET `/did/:did`, PUT `/:id/verify`, PUT `/:id/reject`, PUT `/:id/revoke`, DELETE `/:id` (GDPR), GET `/:id/my-data`, GET `/:id/wallet-invitation`, GET `/:id/wallet-connection/:oobId`, POST `/:id/send-credential` |
| `backend/src/routes/bank.routes.ts` | Bank verifier: POST `/api/bank/invitation` (OOB QR), GET `/api/bank/connection/:oobId`, POST `/api/bank/proof-request` (with `age>=18` ZKP predicate), GET `/api/bank/proof-result/:presExId` |
| `backend/src/routes/did.routes.ts` | DID management: POST `/api/did`, GET `/api/did/:did`, GET `/:did/credentials`, POST `/:did/connect`, GET `/:did/connection-status` |
| `backend/src/routes/document.routes.ts` | Document storage: POST `/api/documents/upload` (multer, 10 MB limit), GET `/api/documents/:cid?documentId=` |
| `backend/src/middleware/validation.middleware.ts` | Zod schemas for `POST /api/kyc` (incl. optional `dateOfBirth`) and `PUT /:id/verify` |
| `backend/src/middleware/auth.middleware.ts` | JWT verify + `requireVerifier` + `requireBank` role guards |
| `backend/src/routes/auth.routes.ts` | `POST /api/auth/login` — returns signed JWT with `user`, `verifier`, or `bank` role |
| `backend/src/config/index.ts` | Typed config object — Fabric, ACA-Py, bankAcapy, IPFS, encryption, vault, auth (user/verifier/bank), port |
| `backend/src/types/kyc.types.ts` | Shared TypeScript types: `KYCRecord`, `SubmitKYCRequest` (incl. `dateOfBirth?`), `VerifyKYCRequest` |
| `frontend/src/services/api.ts` | `APIClient` — all endpoints including `resubmitKYC`, bank invitation/connection/proof methods |
| `frontend/src/pages/Login.tsx` | Login form — calls `POST /api/auth/login`, stores JWT+role, redirects to requested page |
| `frontend/src/pages/Verifier.tsx` | Verifier admin panel — 3 tabs: Pending (View Docs + approve + reject) / Verified (revoke) / Rejected |
| `frontend/src/pages/Bank.tsx` | Bank portal — step machine: idle → QR scan → proof waiting → verified/failed; shows "age ≥ 18 confirmed via ZKP" |
| `frontend/src/App.tsx` | Router + `RequireAuth` + `RequireVerifier` + `RequireBank` guards + role-aware nav |
| `frontend/src/components/KYCForm/index.tsx` | DID input + date-of-birth picker + multi-document upload; `initialDid`/`lockDid` props for re-submission |
| `frontend/src/components/DocumentUpload/index.tsx` | Single-file drop zone used by `KYCForm` |
| `frontend/src/components/VerificationStatus/index.tsx` | Status display + "Show History" + "Update Documents" button (VERIFIED/REJECTED only) |
| `fabric/configtx.yaml` | Fabric channel + org configuration |
| `acapy/scripts/provision.sh` | Registers Indy schema v3.0 (`kyc_id`, `verification_date`, `age`) + credential definition |
| `scripts/acapy-start.sh` | Fetches `ACAPY_WALLET_KEY` + `POSTGRES_PASSWORD` from Vault KV, then `exec aca-py start` |
| `scripts/bank-acapy-start.sh` | Same pattern for bank-acapy (port 8040/8041, wallet `bank-wallet`) |
| `chaincode/Dockerfile` | CaaS image — Go binary built in multi-stage, listens on 7052 for peer connections |
| `bank-frontend/public/index.html` | Standalone vanilla JS bank portal — login + QR + polling; no npm/React |
| `bank-frontend/Dockerfile` | Nginx-only image; `sed` substitutes `__API_URL__` at build time |

### Implementation status

| Component | Status | Notes |
|-----------|--------|-------|
| Go chaincode | Done | All 11 functions including `ResubmitKYC`, `StoreCredExchangeID`, `EraseKYC`; `go test ./...` passes |
| ~~`EncryptionService`~~ | Removed | Deleted — Vault Transit is the sole encryption path; `validateConfig()` enforces `VAULT_ENABLED=true` |
| `VaultService` | Done | HashiCorp Vault Transit — per-KYC-ID named keys; `encrypt`/`decrypt` wrappers; always active |
| Vault bootstrap | Done | `bootstrap.ts` fetches KV secrets before `config.ts` evaluates; `index.ts` uses async dynamic imports |
| `FabricService` | Done | `@hyperledger/fabric-gateway` v1.x; includes `resubmitKYC()` |
| `IndyService` | Done | DID create/resolve, VC issue (v2.0), revocation, connection lookup |
| `IpfsService` | Done | Upload/download/pin/unpin via Kubo API |
| KYC routes | Done | Full lifecycle + `PUT /:id/resubmit`; verify reads manifest for `dateOfBirth` → calculates age → includes in VC |
| Bank routes | Done | OOB invitation + connection poll + proof request (ZKP `age>=18` predicate) + proof result |
| DID routes | Done | create, resolve, credentials, OOB connect, connection-status |
| Document routes | Done | multer upload → IPFS; CID download + decrypt |
| Validation middleware | Done | Zod schemas for submit (incl. `dateOfBirth?`) and verify; enforces passport + selfie |
| Auth middleware | Done | JWT Bearer token; `requireVerifier` and `requireBank` role guards |
| Auth routes | Done | `POST /api/auth/login` issues JWT with `user`, `verifier`, or `bank` role |
| Frontend `APIClient` | Done | All endpoints including `resubmitKYC`, all bank methods |
| Frontend Login page | Done | `/login` — username/password form, redirects back after success |
| Frontend auth guards | Done | `RequireAuth`, `RequireVerifier`, `RequireBank` in `App.tsx` |
| Full UI demo | Done | Browser flow tested: login → submit KYC → status PENDING → verifier panel approve |
| `KYCForm` component | Done | DID + date-of-birth picker + multi-doc upload; `initialDid`/`lockDid` for re-submission |
| `DocumentUpload` component | Done | Single-file selector used by `KYCForm` |
| `VerificationStatus` component | Done | Status display + "Show History" + "Update Documents" button (VERIFIED/REJECTED) |
| Frontend pages | Done | Home, Submit (+ resubmit mode), Status, Login, Verifier, Bank pages wired up |
| Verifier admin panel | Done | 3 tabs: Pending (approve + reject) / Verified (revoke) / Rejected; role-aware nav |
| Bank portal | Done | QR → DIDComm scan → proof request → ZKP result; shows "age ≥ 18 confirmed via ZKP" |
| Age / ZKP predicate | Done | Schema v3.0 adds `age` attr; manifest stores `dateOfBirth`; verify calculates age for VC; bank uses `age>=18` AnonCreds predicate |
| Document re-submission | Done | Chaincode `ResubmitKYC` (VERIFIED/REJECTED→PENDING); backend `PUT /:id/resubmit`; frontend "Update Documents" button |
| KYC history | Done | `GET /api/kyc/:id/history` + "Show History" in Status page — full on-chain audit trail |
| REJECTED status | Done | `PENDING → REJECTED` with `rejectionReason` stored on-chain |
| Document viewer | Done | `GET /api/kyc/:id/documents` (verifier only) — decrypts manifest + each doc, returns base64 previews |
| Backend CORS | Done | `cors` middleware; configurable via `CORS_ORIGIN` env var |
| Docker Compose | Done | All services: Fabric, CouchDB, postgres (KYC), postgres (bank), acapy-agent, bank-acapy, IPFS, tails-server, Vault, vault-init, backend, frontend |
| Fabric scripts | Done | network.sh, deploy-chaincode.sh; TLS flags on all peer/orderer commands |
| ACA-Py startup scripts | Done | `scripts/acapy-start.sh` + `scripts/bank-acapy-start.sh` fetch secrets from Vault KV |
| Vault KV init | Done | `vault-init` container seeds all secrets from `.env`; services fetch at runtime |
| Frontend build | Done | `npm install --legacy-peer-deps`; `ajv@^8` override; `DISABLE_ESLINT_PLUGIN=true`; `@types/jest` explicit dep |
| End-to-end demo | Done | Full SSI Trust Triangle tested live on VPS with BC Wallet |
| Wallet credential issuance (user-initiated) | Done | `GET /api/kyc/:id/wallet-invitation` + `POST /api/kyc/:id/send-credential`; Status page shows QR → auto-polls → auto-issues |
| Bank frontend (isolated container) | Done | Separate `bank-frontend` container (vanilla HTML/JS) at port 4000; zero shared code with KYC app |

### Environment

`.env` exists and is configured. Do not regenerate `ENCRYPTION_MASTER_KEY` — changing it invalidates all existing IPFS documents.

Key values:

- `ENCRYPTION_MASTER_KEY` — 64 hex chars (32-byte AES key). Already set. **Never change after first run.**
- `ACAPY_WALLET_KEY` — ACA-Py wallet encryption key (change from default before production use)
- `FABRIC_CHANNEL` / `FABRIC_CHAINCODE` — must match what `deploy-chaincode.sh` uses
- `FABRIC_MSP_ID` — set to `Org1MSP`; must match `CORE_PEER_LOCALMSPID` in docker-compose.yml
- `INDY_GENESIS_URL` — defaults to `http://test.bcovrin.vonx.io/genesis` (BCovrin public test ledger). For a fully local Indy network, run [von-network](https://github.com/bcgov/von-network) and set to `http://localhost:9000/genesis`.
- `KYC_CRED_DEF_ID` — written automatically by `provision.sh`; must be re-updated after each `docker compose down -v`.
- `REACT_APP_CRED_DEF_ID` — baked into the frontend Docker image at build time; must match `KYC_CRED_DEF_ID` (used by Verifier panel to pre-fill the credential definition ID).
- `JWT_SECRET` — secret for signing JWTs. **Change before any non-local deployment.**
- `CORS_ORIGIN` — origin allowed by the backend CORS middleware (default `http://localhost`). Change if frontend is served on a different port or domain.
- `VERIFIER_USERNAME` / `VERIFIER_PASSWORD` — credentials for the verifier role
- `USER_USERNAME` / `USER_PASSWORD` — credentials for the applicant role

### Indy ledger

There is **no local `indy-node` container** in docker-compose. ACA-Py connects to the **BCovrin public test ledger** (`test.bcovrin.vonx.io`) by default. This requires internet access at runtime. The original `ghcr.io/hyperledger/indy-node:latest` image was private (access denied). For a fully offline setup, replace with von-network.

### Ports

| Service | Port |
|---------|------|
| Backend API | 3000 (also via nginx `/api/` on 443) |
| KYC Frontend | 3001 (docker), 443 via nginx |
| Bank Frontend | 3002 (docker), 4000 via nginx SSL |
| Fabric Peer | 7051 |
| Fabric Orderer | 7050 |
| Fabric CA | 7054 |
| CouchDB UI | 5984 |
| KYC ACA-Py inbound | 8030 |
| KYC ACA-Py admin | 127.0.0.1:8031 |
| Bank ACA-Py inbound | 8040 |
| Bank ACA-Py admin | 127.0.0.1:8041 |
| IPFS API | 5001 |
| IPFS Gateway | 8080 |
| Tails server | 127.0.0.1:6543 |
| HashiCorp Vault | 127.0.0.1:8200 |
| Indy ledger | external (BCovrin) |

### Current deployment state (last updated 2026-07-02)

| Item | Value |
|------|-------|
| VPS | `185.2.101.205` — domain `e-kyc.cloud-ip.cc` — SSL via Certbot |
| KYC app URL | `https://e-kyc.cloud-ip.cc` (user + verifier) |
| Bank portal URL | `https://e-kyc.cloud-ip.cc:4000` (isolated bank-frontend container) |
| Chaincode | **CaaS mode** — `kyccc_1.0` sequence 1, deployed and committed |
| Chaincode package ID | `kyccc_1.0:128849e111ae2ac25b50e914702bd6ca28044e7622df933912272d5b5cc62045` |
| Schema | **v3.0** (`kyc_id`, `verification_date`, `age`) — registered on BCovrin |
| Cred Def ID | `tRPN7eELKUt9WZ1dG8QqP:3:CL:3208173:default` |
| ACA-Py Public DID | `tRPN7eELKUt9WZ1dG8QqP` |
| Revocation Registry | `tRPN7eELKUt9WZ1dG8QqP:4:tRPN7eELKUt9WZ1dG8QqP:3:CL:3208173:default:CL_ACCUM:8f34d8fe-b318-4c42-87dc-f39b9ef82e6b` |
| Tails public URI | `https://e-kyc.cloud-ip.cc/tails/tRPN7eELKUt9WZ1dG8QqP:4:...:CL_ACCUM:8f34d8fe-b318-4c42-87dc-f39b9ef82e6b` |
| Tails hash | `9FZwDrjG1B3hox7E6M1vVQVrKzQ5iUFQheZ3ynpirxEu` |
| Vault | dev mode; secrets seeded by `vault-init` |
| Revocation | Enabled — tails-server running, accumulator published to BCovrin ✓ |
| CORS | `CORS_ORIGIN=https://e-kyc.cloud-ip.cc` with `startsWith` check (covers port 4000) |
| UFW open ports | 22, 80, 443, 3000, 4000, 5601, 8030, 8040 |
| Kibana | `http://185.2.101.205:5601` — index pattern `kyc-logs-*` |

> After `docker compose down -v` (full teardown), ACA-Py wallet + Vault dev storage are wiped. Re-run `provision.sh` — it will create a new DID, register it on BCovrin, update `acapy/state/provision.json` + `.env` automatically. Then **three extra manual steps** are required (see gotchas below): tails file upload, accumulator publish, and frontend rebuild.

> Chaincode sequence resets to 1 after full teardown. Use `CC_VERSION=2.0 CC_SEQUENCE=2 ./scripts/start-network.sh` to deploy the new version with `ResubmitKYC`.

> **CaaS mode**: chaincode runs as a separate container (`kyccc-service`), not built by the peer. The peer never calls Docker to build. `deploy-chaincode.sh` builds the image on the host and creates a manual CaaS package (tar with `metadata.json` + `code.tar.gz`).

### Deployment gotchas (discovered during live demo)

| Issue | Fix |
|-------|-----|
| Fabric 2.5 etcdraft **requires TLS** — orderer panics without it | All three services (orderer, peer, fabric-cli) need TLS env vars and volume mounts; see `docker-compose.yml` |
| `fabric-network` v2 SDK silently fails with empty endorsement responses over TLS | Replaced with `@hyperledger/fabric-gateway` v1.x using explicit `grpc.credentials.createSsl()` |
| Fabric TLS certs | `FabricService` reads TLS CA cert and Admin identity directly from `crypto-config/` — no connection profile file needed |
| Docker Compose names containers `kyc-system-<service>-1`, not `<service>` | `network.sh` and `deploy-chaincode.sh` use substring matching (`--filter "name=<service>"`) |
| ACA-Py `POST /out-of-band/create-invitation` 500 — `assert my_endpoint` | ACA-Py must start with `--endpoint http://localhost:8030`; now set in `docker-compose.yml` |
| ACA-Py returns bare DID strings (e.g. `Abc123`), not `did:indy:test:Abc123` | `scripts/test-kyc.sh` automatically prefixes with `did:indy:test:` if the returned string lacks `did:` |
| `docker compose restart backend` fails on WSL2 after `Write` tool replaces a file | Use `docker compose up -d --force-recreate backend` instead |
| Browser shows "Welcome to nginx!" on port 80 | System nginx was running on the host, shadowing the Docker container. Stop it: `sudo systemctl stop nginx && sudo systemctl disable nginx` |
| Login returns "Network Error" (CORS blocked) | Backend had no CORS middleware. Added `cors` package in `backend/src/index.ts`; `CORS_ORIGIN` env var controls the allowed origin |
| Frontend Docker build — `npm ci` fails with peer dep conflicts | Changed to `npm install --legacy-peer-deps` in `frontend/Dockerfile` |
| Backend Docker build — `npm ci` fails after adding new deps | Changed to `npm install` in `backend/Dockerfile` (no lockfile sync required) |
| Frontend Docker build — `ajv/dist/compile/codegen` not found | Added `"overrides": { "ajv": "^8.0.0" }` in `frontend/package.json` |
| Frontend Docker build — ESLint plugin `react-hooks` not found in CRA context | Set `DISABLE_ESLINT_PLUGIN=true` in `frontend/Dockerfile` |
| Frontend Docker build — `TS2582: Cannot find name 'describe'` | Added `"@types/jest": "^27.0.0"` to `frontend/package.json` devDependencies |
| "Missing or invalid Authorization header" after login | Axios v1.x requires `config.headers.set('Authorization', ...)` in interceptors, not `config.headers['Authorization'] = ...` |
| Verifier Panel nav link not appearing after login | `App` role state not updated after same-tab login; fixed with `window.dispatchEvent(new Event('auth-change'))` in `storeToken` |
| "KYC verification failed" even though Fabric state updated | VC issuance (`issueCredential`) fails without DIDComm connection; made best-effort — Fabric transition succeeds, VC failure returns warning not 500 |
| BCovrin `POST /register` returns "Permanent Redirect" | BCovrin redirects HTTP → HTTPS. Fixed: `INDY_LEDGER_URL=https://test.bcovrin.vonx.io` in `.env` + `-L` flag on curl in `provision.sh` |
| `channel_exists()` in `network.sh` always returned false | `docker exec "fabric-cli"` never found the container because Docker Compose names it `kyc-system-fabric-cli-1`. Fixed: lookup container via `docker ps --filter "name=fabric-cli"` before exec |
| `wait_peer_healthy()` / `wait_orderer_healthy()` port check fragile | Replaced `/proc/net/tcp6` hex grep with `bash -c 'echo > /dev/tcp/localhost/<port>'` |
| `query_package_id()` in `deploy-chaincode.sh` broke on labels with underscores | Replaced fragile `grep | sed` with `--output json \| jq -r ".installed_chaincodes[] \| select(.label==\"${CC_LABEL}\") \| .package_id"` |
| `REACT_APP_CRED_DEF_ID` not passed through Docker build | Added `ARG`/`ENV` to `frontend/Dockerfile` and build arg to `docker-compose.yml`; must rebuild frontend image after provisioning |
| `config.ts` evaluated before Vault secrets available | Static imports cause config to evaluate at module load time. Fixed: `index.ts` uses async IIFE with dynamic `await import()` for all modules that depend on config |
| `$VAR` vs `$$VAR` in docker-compose commands | Single `$VAR` in `vault-init` command would bake the secret value into Docker inspect. Use `$$VAR` so docker-compose passes literal `$VAR` to the container's shell, which expands from its own env |
| YAML `>` (folded block) breaks multi-line shell in docker-compose | Folded block collapses newlines to spaces, breaking shell scripts. Use list form `command: [sh, -c, ...]` with `|` literal block scalar |
| `acapy-start.sh` / `bank-acapy-start.sh` — inline Python to fetch Vault secrets | Shell has no HTTP client; uses `python3 -` heredoc to call Vault KV API, then `eval` exports, then `exec aca-py start` |
| Bank ACA-Py OOB invitation 500 — missing `--endpoint` | `bank-acapy` must start with `--endpoint http://<public-host>:8040`; set `BANK_ACAPY_ENDPOINT` in `.env` |
| Chaincode install broken pipe (Docker 29.x + Fabric 2.5.x) | Peer tries to build chaincode image via Docker socket; Docker 29.x breaks the connection. Fix: **CaaS (Chaincode as a Service)** — build image manually on host, peer never calls Docker for build. `deploy-chaincode.sh` creates a manual CaaS package (tar with `metadata.json` + `code.tar.gz`). |
| `--type ccaas` flag not in Fabric 2.5.9 peer CLI | Peer lifecycle CLI has no `--type ccaas` flag. Must manually create the tar package inside fabric-cli container. |
| CaaS env var: `CORE_CHAINCODE_ID_NAME` not `CHAINCODE_ID` | fabric-chaincode-go shim requires `CORE_CHAINCODE_ID_NAME` in CaaS mode. Using `CHAINCODE_ID` causes crash on startup. |
| `oob_id` ≠ `invitation_msg_id` on ACA-Py connections | `POST /out-of-band/create-invitation` returns `oob_id` but connections store `invitation['@id']` as `invitation_msg_id`. Must use `invitation['@id']` for `GET /connections?invitation_msg_id=` lookup. Fixed in `IndyService.createInvitation()` (returns `invitationMsgId`) and bank routes. |
| ACA-Py `presentation-received` state needs explicit verify call | ACA-Py does NOT auto-verify presentations. After wallet sends proof, state is `presentation-received`. Must call `POST /present-proof-2.0/records/:id/verify-presentation` explicitly. Fixed in `GET /api/bank/proof-result/:id`. Also handle `deleted` state (returned when `auto_remove=true`) as `done=true`. |
| Bank frontend CORS from port 4000 | Bank served at `https://e-kyc.cloud-ip.cc:4000` — different origin from KYC app on 443. Backend CORS uses `startsWith` check so `https://e-kyc.cloud-ip.cc` matches both ports. |
| Bank frontend: `fork-ts-checker-webpack-plugin` ajv conflict | CRA's `fork-ts-checker-webpack-plugin` has nested `ajv-keywords` incompatible with ajv v8. Cannot be fixed via npm overrides. Solution: bank-frontend is a **single static HTML file** with vanilla JS + QRCode.js CDN — zero npm, zero build step. |
| Mixed content (HTTP API from HTTPS page) | Frontend built with `REACT_APP_API_URL=http://...` causes browser to block requests from HTTPS page. Must use `REACT_APP_API_URL=https://e-kyc.cloud-ip.cc` so all requests go through nginx SSL proxy. |
| BC Wallet stuck after QR scan — DIDExchange 1.1 | BC Wallet uses DIDExchange 1.1 which never sends the final ACK, leaving connection at `response` state (not `completed`). Fixed: added `'response'` to accepted states in `findConnectionByOobId()` and bank `/connection/:oobId` poll. |
| Credential not arriving in BC Wallet — wrong `tailsLocation` | ACA-Py wrote local container path (`/home/aries/.indy_client/tails/...`) as `tailsLocation` in Indy ledger. BC Wallet needs a public URL to download tails file for non-revocation proof. Fix: full teardown + reprovision AFTER nginx `/tails/` location is configured so ACA-Py uploads with public URL. |
| Nginx 500 on tails GET — HTTP/1.0 chunked encoding | Nginx proxies to tails-server using HTTP/1.0; tails-server uses chunked Transfer-Encoding (forbidden for HTTP/1.0). Fix: `proxy_http_version 1.1;` in nginx `/tails/` location. |
| tails-server `PermissionError: /tails-files` | tails-server runs as `indy` user but Docker named volume owned by root. Fix: `user: root` + `chmod 777 /tails-files` + `su indy` in docker-compose.yml command. |
| Go 1.22 rejects ECDSA cert from cryptogen | `x509: ECDSA verification failure while trying to verify candidate authority certificate "tlsca.example.com"` — first cryptogen run produced keys Go 1.22 rejected (OpenSSL accepted them). Fix: delete `fabric/crypto-config/` and run cryptogen a second time. |
| Stale Docker bind mount after directory deletion | After `rm -rf fabric/crypto-config` + regenerate, fabric-cli/peer containers still reference the old inode. Fix: restart affected containers. |
| Revocation not published to BCovrin ledger | `POST /revocation/revoke` returns `{}` but accumulator was never written to ledger — ACA-Py threw `LedgerTransactionError` internally (BCovrin returned response without `txnTime`). Fix: `PUT /revocation/registry/{id}/fix-revocation-entry-state?apply_ledger_update=true` — forces a retry that succeeds. |
| Bank shows "Identity Verified" for revoked credentials | Two causes: (1) `non_revoked` interval missing from proof request — bank.routes.ts was only changed locally, not synced to VPS. Fix: `scp bank.routes.ts` → VPS + rebuild. (2) Revocation accumulator not on BCovrin — see fix above. |
| Code changes not synced to VPS | Files edited locally (WSL2) must be explicitly `scp`'d to VPS before `docker compose build`. There is no automatic sync. Always verify with `ssh liks@185.2.101.205 "grep ... /path/to/file"` after scp. |
| Elasticsearch requires `vm.max_map_count=262144` | ES crashes with `max virtual memory areas vm.max_map_count [65530] is too low`. Fix: `sudo sysctl -w vm.max_map_count=262144` + add to `/etc/sysctl.conf` for persistence. |
| After `down -v`: tails file missing from tails-server | `tails-data` volume is wiped. ACA-Py still has the file locally. Must re-upload with multipart (NOT octet-stream — returns "Expected multipart content type"): `curl -X PUT http://localhost:6543/<rev_reg_id> -F "genesis=@/tmp/genesis.txn" -F "tails=@/tmp/tails_file"`. Path is `/<rev_reg_id>`, not `/<hash>`. |
| After `down -v`: BC Wallet silently declines proof request (`abandoned: Declined`) | Non-revocation proof fails because the new rev reg accumulator was never published to BCovrin. Fix: `curl -s -X POST http://localhost:8031/revocation/registry/<rev_reg_id>/entry`. Do this AFTER issuing at least one credential. `fix-revocation-entry-state` does NOT work here (requires prior revocation). |
| After `down -v`: verifier approves with old cred def | `REACT_APP_CRED_DEF_ID` is baked into the frontend JS bundle at build time. If frontend image is not rebuilt after reprovision, the old cred def gets written to the Fabric record → VC issuance uses wrong cred def → wallet has no matching credential for bank proof request. Fix: `sudo docker compose build --build-arg REACT_APP_CRED_DEF_ID=<new_id> frontend && sudo docker compose up -d --force-recreate frontend`. |
| tails-server `command:` vs `entrypoint:` | `ghcr.io/bcgov/tails-server:1.0.0` ENTRYPOINT is `[/bin/bash -c tails-server "$@"]`. Using `command:` in docker-compose passes args as positional bash params, not to tails-server. Fix: use `entrypoint: ["sh", "-c", "chmod 777 /tails-files && tails-server --host 0.0.0.0 --port 6543 --storage-path /tails-files --log-level INFO"]` with `user: root`. |

## Known limitations & future work (discussed 2026-06-01)

### Encryption — per-KYC-ID Vault keys (current)
Vault Transit creates a separate named key per KYC ID (`kyc/<id>`). If one key leaks, only that one applicant's documents are exposed. The backend never holds raw key material. For production, add Vault key rotation policy and audit logging.

### User registration
No signup flow exists. Credentials are hardcoded in `.env` (`USER_USERNAME` / `USER_PASSWORD`). A production system would need bcrypt-hashed passwords, a users table, and a `POST /api/auth/register` endpoint.

### BC Wallet + public domain deployment (για παρουσίαση)
Για live demo με κινητό στην παρουσίαση:
- **VPS** (Hetzner/DigitalOcean ~5€/μήνα) + domain + Nginx + SSL (Certbot) + Docker Compose
- Εκτιμώμενος χρόνος: ~3-4 ώρες, να γίνει κοντά στην παρουσίαση
- Όφελος: το BC Wallet (open-source mobile wallet) δουλεύει αμέσως με public URL — ο εξεταστής σκανάρει QR code και βλέπει live το VC
- Χωρίς public domain: απαιτείται ngrok (URL αλλάζει κάθε φορά, άβολο)
- K8s deployment: εφικτό αλλά πολύ πολύπλοκο για αυτό το stack — αναφορά ως future work μόνο

### Bank / third-party verification via VC Presentation + Fabric Org2

**Planned:** Bank as **Org2 in the Fabric channel** (not just a second ACA-Py agent). Status: agreed, not yet implemented — deferred until after VPS deployment.

Architecture:
```
Org1 (KYC Provider) ──┐
                       ├── kyc-channel
Org2 (Bank)         ──┘
```

**Why Org2 vs. just ACA-Py agent:** Bank reads KYC records directly from the ledger without going through our backend. Endorsement policy `AND('Org1MSP.peer', 'Org2MSP.peer')` means both orgs must approve `VerifyKYC` — real multi-party trust.

**Open decision:** Endorsement policy `AND` (both endorse VerifyKYC) vs `OR` (bank is read-only) — not decided yet.

**Files to change when implementing:**
- `fabric/configtx.yaml` — Org2MSP definition + channel profile
- `docker-compose.yml` — bank-ca, bank-peer, bank-acapy (ports 8040/8041)
- `fabric/scripts/network.sh` — channel join + anchor peer for Org2
- `fabric/scripts/deploy-chaincode.sh` — approve + install from Org2 peer
- `backend/` — bank-specific routes (`/api/bank/verify-kyc`)

**DIDComm flow (bank ACA-Py agent):**
1. Bank runs its own ACA-Py agent (Verifier role)
2. Creates DIDComm OOB invitation (QR code)
3. User scans with wallet → DIDComm connection established
4. Bank sends proof request referencing `cred_def_id`
5. User's wallet responds with ZKP proof
6. Bank verifies against Indy ledger — **no contact with our backend needed**

Demo script: `scripts/test-bank-verify.sh` (to be written)

### ~~DID publication to Indy ledger~~ (DONE)
`IndyService.publishDID(did, verkey)` calls `POST /ledger/register-nym` — implemented and called from `POST /api/did` with best-effort try/catch (failure is non-fatal, logged as warning).

### ACA-Py revocation
~~Revocation is disabled~~ — **Revocation is fully enabled** (tails-server running, accumulator published to BCovrin). Bank proof request includes `non_revoked: { to: now }` so BC Wallet must prove non-revocation. Revoked credentials are correctly rejected by the bank.

## Remaining work (thesis)

### ~~1. Auth middleware~~ (DONE)
### ~~2. DIDComm OOB connection flow~~ (DONE)
### ~~3. End-to-end demo~~ (DONE)
### ~~4. HashiCorp Vault~~ (DONE) — Transit + KV, per-KYC-ID keys, `vault-init` seeds secrets
### ~~5. Bank verification (SSI Trust Triangle)~~ (DONE) — bank-acapy Verifier agent, DIDComm proof request
### ~~6. Age / ZKP predicate~~ (DONE) — schema v3.0 with `age`; manifest stores `dateOfBirth`; bank uses `age>=18` AnonCreds predicate
### ~~7. Document re-submission~~ (DONE) — chaincode `ResubmitKYC`; backend `PUT /:id/resubmit`; "Update Documents" button

To re-run the demo from scratch:

```bash
CC_VERSION=2.0 CC_SEQUENCE=2 ./scripts/start-network.sh  # deploy upgraded chaincode with ResubmitKYC
bash scripts/test-kyc.sh
```

**After `docker compose build backend`** always use `--force-recreate`:
```bash
docker compose up -d --force-recreate backend
```

### ~~8. VPS deployment + BC Wallet live demo~~ (DONE — 2026-07-01, updated 2026-07-02)

Full end-to-end SSI Trust Triangle tested and working on `https://e-kyc.cloud-ip.cc`:

1. User submits KYC → verifier approves → user's Status page shows **"Receive Credential in BC Wallet"** button
2. User clicks → QR appears → scans with BC Wallet → DIDComm connection → VC issued automatically
3. Bank portal (`https://e-kyc.cloud-ip.cc:4000`) → Start Verification → QR → wallet scans → proof request → user shares `age>=18` ZKP → **Identity Verified**

**To redeploy from scratch after `docker compose down -v`:**
```bash
# On VPS as liks:
cd /home/liks/kyc2-system
CC_VERSION=1.0 CC_SEQUENCE=1 ./scripts/start-network.sh
bash acapy/scripts/provision.sh          # new DID + cred def → updates .env automatically

# 1. Rebuild frontend with new cred def
REACT_APP_CRED_DEF_ID=$(grep REACT_APP_CRED_DEF_ID .env | cut -d= -f2)
sudo docker compose build \
  --build-arg REACT_APP_API_URL=https://e-kyc.cloud-ip.cc \
  --build-arg REACT_APP_CRED_DEF_ID=$REACT_APP_CRED_DEF_ID \
  frontend bank-frontend
sudo docker compose up -d --force-recreate frontend bank-frontend backend

# 2. Re-upload tails file to tails-server (volume was wiped)
REV_REG=$(curl -sf http://localhost:8031/revocation/registries/created | python3 -c "import json,sys; print(json.load(sys.stdin)['rev_reg_ids'][0])")
TAILS_HASH=$(curl -sf "http://localhost:8031/revocation/registry/${REV_REG}" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['tails_hash'])")
sudo docker cp "kyc2-system-acapy-agent-1:/home/aries/.indy_client/tails/${REV_REG}/${TAILS_HASH}" /tmp/tails_file
curl -sf "https://test.bcovrin.vonx.io/genesis" -o /tmp/genesis.txn
curl -X PUT "http://localhost:6543/${REV_REG}" -F "genesis=@/tmp/genesis.txn" -F "tails=@/tmp/tails_file"

# 3. Publish accumulator to BCovrin (do this AFTER issuing first credential)
curl -s -X POST "http://localhost:8031/revocation/registry/${REV_REG}/entry"
```

### ~~9. DID publication to Indy ledger~~ (DONE — 2026-08-19)

`IndyService.publishDID(did, verkey)` calls `POST /ledger/register-nym`. Called from `POST /api/did` with best-effort try/catch. DIDs created via the API are publicly resolvable on BCovrin.

### ~~10. Revocation at bank~~ (DONE — 2026-07-02)

Bank correctly rejects revoked credentials. Two fixes required:
1. `non_revoked: { to: Math.floor(Date.now() / 1000) }` in bank proof request (`bank.routes.ts` line 81)
2. BCovrin accumulator published via `POST /revocation/registry/{id}/entry` after issuing first credential

### ~~11. ELK Stack logging~~ (DONE — 2026-07-02)

Elasticsearch + Kibana + Filebeat added to `docker-compose.yml`. Filebeat autodiscovers all Docker containers via `/var/run/docker.sock`. Index pattern: `kyc-logs-*`. Kibana at `http://185.2.101.205:5601`.

### 12. Keycloak — identity & access management (optional, thesis reference only)

Replaces hardcoded JWT auth with a proper OIDC provider. Value: manages user/verifier/bank roles without hardcoded credentials. Overkill for the PoC — describe in thesis as the production auth layer without implementing.
