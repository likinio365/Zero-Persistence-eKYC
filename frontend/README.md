# Frontend — KYC React App

React SPA that provides the user-facing KYC submission flow and the verifier admin panel.

## Stack

- **Framework**: React 18, TypeScript
- **Routing**: React Router v6
- **HTTP**: Axios (with JWT interceptor)
- **Build**: Create React App (react-scripts 5)

## Commands

```bash
npm install
npm start         # CRA dev server on :3000
npm run build     # production build → build/
npm test          # jest + React Testing Library
npm run lint      # eslint
```

> **Docker build note**: use `npm install --legacy-peer-deps` (peer dep conflicts with CRA). This is already set in `Dockerfile`.

## Project structure

```
src/
├── components/
│   ├── DocumentUpload/     # single-file drop zone (image preview + PDF support)
│   ├── KYCForm/            # DID input + multi-document upload form
│   └── VerificationStatus/ # status badge, record details, on-chain history
├── pages/
│   ├── Home.tsx            # landing page
│   ├── Login.tsx           # username/password form → JWT stored in localStorage
│   ├── Submit.tsx          # wraps KYCForm, handles submission result
│   ├── Status.tsx          # search by Application ID, shows VerificationStatus
│   └── Verifier.tsx        # verifier admin panel (3 tabs + document viewer)
├── services/
│   └── api.ts              # APIClient (axios) + token helpers
├── types/
│   └── kyc.ts              # shared TypeScript types
└── App.tsx                 # router, nav, RequireAuth / RequireVerifier guards
```

## Auth

JWT is stored in `localStorage` (`kyc_token` + `kyc_role`). The axios interceptor attaches it automatically to every request. On `401` the token is cleared and the user is redirected to `/login`.

Role-based guards in `App.tsx`:
- `RequireAuth` — redirects unauthenticated users to `/login`
- `RequireVerifier` — additionally checks `role === 'verifier'`; redirects others to `/`

Same-tab login/logout is synced via a custom `auth-change` event; cross-tab via the `storage` event.

## Pages

| Path | Auth | Description |
|------|------|-------------|
| `/login` | public | Username/password form |
| `/` | user/verifier | Home — links to Submit and Status |
| `/submit` | user/verifier | KYC submission form |
| `/status` | user/verifier | Look up a KYC record by Application ID |
| `/status/:id` | user/verifier | Direct link to a specific record |
| `/verifier` | **verifier** | Admin panel |

## KYC submission flow (frontend side)

1. User enters or generates a DID (`POST /api/did` via "Generate one for me")
2. Uploads passport (required) + selfie (required) + optional docs
3. Each file is read as base64 (`FileReader`) and sent in `POST /api/kyc`
4. On success, the Application ID is shown with a direct link to `/status/:id`

Required documents are validated both client-side (`KYCForm`) and server-side (Zod schema).

## Verifier panel

Three tabs: **Pending Review** / **Verified** / **Rejected**. Each tab fetches `GET /api/kyc?status=<TAB>`.

Actions available per tab:

| Tab | Actions |
|-----|---------|
| Pending | View Docs, Approve, Reject |
| Verified | Revoke |
| Rejected | — (terminal) |

**View Docs** decrypts and previews all submitted documents from IPFS (`GET /api/kyc/:id/documents`). Images are rendered inline; PDFs offer a download link. MIME type is inferred from the file extension.

**Approve** calls `PUT /api/kyc/:id/verify`. The credential definition ID defaults to `REACT_APP_CRED_DEF_ID` and can be overridden per-action in the modal.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REACT_APP_API_URL` | `http://localhost:3000` | Backend API base URL |
| `REACT_APP_CRED_DEF_ID` | — | Default cred def ID pre-filled in the Approve modal. Update after each `provision.sh` run. |

Set these in the root `.env` file (CRA picks up `REACT_APP_*` automatically).

## Docker

The production image is served by nginx on port 80. After rebuilding:

```bash
docker compose build frontend
docker compose up -d --force-recreate frontend
```

`nginx.conf` proxies `/api/` to the backend service, so the frontend only needs to know about its own origin.

## Testing

```bash
npm test              # watch mode
npm test -- --watchAll=false   # single run (CI)
```

Tests use Jest + React Testing Library. `axios` is mocked via `jest.mock` — no live backend required.