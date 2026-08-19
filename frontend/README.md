# Frontend — React KYC Application

React (TypeScript, Create React App) web interface for the KYC system. Serves applicants, verifiers, and the SSI Trust Triangle wallet flow.

## Pages

| Route | Auth | Description |
|-------|------|-------------|
| `/` | any | Home — project overview and navigation |
| `/login` | — | Username/password form; stores JWT + role, redirects after success |
| `/submit` | user | KYC submission form (DID + date of birth + document upload) |
| `/submit?resubmit=:id` | user | Re-submission mode — DID pre-filled and locked, new documents required |
| `/status/:id` | user | KYC record status, history, and wallet credential issuance QR |
| `/verifier` | verifier | Admin panel — approve, reject, and revoke records |
| `/bank` | bank | Bank portal — ZKP proof verification flow |

## Components

### `KYCForm` (`components/KYCForm/`)
DID input + date-of-birth picker + multi-document uploader. Accepts `initialDid` / `lockDid` props for re-submission mode (prevents changing the DID after an initial submission).

### `DocumentUpload` (`components/DocumentUpload/`)
Single-file drop zone. Used by `KYCForm` for each document type (passport + selfie).

### `VerificationStatus` (`components/VerificationStatus/`)
Status badge, human-readable status description, and action buttons:
- **Show History** — expands on-chain audit trail
- **Update Documents** — available on `VERIFIED` and `REJECTED` status; navigates to re-submission form
- **Receive Credential in BC Wallet** — available on `VERIFIED`; shows QR code and auto-polls for connection, then auto-issues the VC

## State Machine (as reflected in the UI)

```
PENDING  → user waiting for verifier action
VERIFIED → "Update Documents" + wallet QR available
REJECTED → "Update Documents" available; can resubmit (NOT a terminal state)
REVOKED  → terminal, no further actions
DELETED  → GDPR erasure complete; no further actions
```

`REJECTED` is **not** terminal — the applicant can always resubmit updated documents.

## Auth Flow

1. User navigates to any protected route → `RequireAuth` / `RequireVerifier` / `RequireBank` guard redirects to `/login?redirect=<path>`
2. Login form calls `POST /api/auth/login` → stores JWT + role in `localStorage`
3. On success, fires `window.dispatchEvent(new Event('auth-change'))` so `App.tsx` re-renders nav links
4. Redirects back to the originally requested page

## Verifier Admin Panel (`/verifier`)

Three tabs:

| Tab | Records shown | Actions available |
|-----|--------------|-------------------|
| Pending | `PENDING` | View documents (passport + selfie preview), Approve, Reject |
| Verified | `VERIFIED` | Revoke |
| Rejected | `REJECTED` | View documents; applicant can resubmit from their Status page |

## Bank Portal (`/bank`)

Step machine driven by polling:

```
idle → QR displayed → waiting for proof → verified / failed
```

1. Click **Start Verification** → calls `POST /api/bank/invitation` → QR rendered
2. User scans with BC Wallet → DIDComm connection established
3. **Send Proof Request** → calls `POST /api/bank/proof-request` with `age ≥ 18` ZKP predicate
4. Polls `GET /api/bank/proof-result/:presExId` → displays **"Identity Verified — age ≥ 18 confirmed via ZKP"** or rejection

No PII is revealed to the bank — only the ZKP predicate result.

## API Client (`services/api.ts`)

Typed `APIClient` class covering all endpoints:
- `submitKYC`, `getKYC`, `getKYCHistory`, `resubmitKYC`, `verifyKYC`, `rejectKYC`, `revokeKYC`, `deleteKYC`
- `getWalletInvitation`, `getWalletConnection`, `sendCredential`
- `createBankInvitation`, `getBankConnection`, `sendProofRequest`, `getProofResult`
- `createDID`, `getDID`
- `login`

Axios interceptors attach the JWT Bearer token from `localStorage` to every request.

## Development

```bash
cd frontend
npm install --legacy-peer-deps
npm start          # CRA dev server on :3000
npm test           # jest
npm run build      # production build → build/
```

## Docker

The frontend image bakes in two build-time variables:

```bash
docker compose build \
  --build-arg REACT_APP_API_URL=https://your-domain.example.com \
  --build-arg REACT_APP_CRED_DEF_ID=<cred_def_id_from_provision.sh> \
  frontend
docker compose up -d --force-recreate frontend
```

`REACT_APP_CRED_DEF_ID` must match the value in `.env` (`KYC_CRED_DEF_ID`). After re-provisioning ACA-Py, rebuild the frontend image.

## Known Peer Dependency Notes

| Package | Fix applied |
|---------|-------------|
| `ajv` peer conflict (CRA) | `"overrides": { "ajv": "^8.0.0" }` in `package.json` |
| ESLint plugin CRA conflict | `DISABLE_ESLINT_PLUGIN=true` in `Dockerfile` |
| `@types/jest` missing | Added to `devDependencies` |
