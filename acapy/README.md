# ACA-Py — Verifiable Credentials Agent

Handles self-sovereign identity (SSI) for the KYC system using Hyperledger Aries Cloud Agent Python.

## Responsibilities

- Maintains a public DID registered on the Indy ledger (BCovrin test network)
- Registers the KYC schema and credential definition on the ledger
- Issues Verifiable Credentials (VCs) to holders over DIDComm connections
- Revokes VCs (disabled — see Limitations)

## Directory structure

```
acapy/
├── scripts/
│   └── provision.sh       # one-time setup: DID + schema + cred def registration
├── state/
│   └── provision.json     # output of provision.sh — schema/cred def IDs used by backend
└── README.md
```

## Provisioning

Run once after `docker compose up` (and again after any `docker compose down -v`):

```bash
bash acapy/scripts/provision.sh
```

The script is idempotent — it skips steps that are already done. On success it writes
`state/provision.json` with the IDs the backend needs.

After provisioning, verify the public DID is set:

```bash
curl -s http://localhost:8031/wallet/did/public | jq .
```

## Schema

| Field | Value |
|-------|-------|
| Name | `kyc` |
| Version | `2.0` |
| Attributes | `kyc_id`, `verification_date` |
| Ledger | BCovrin test (`https://test.bcovrin.vonx.io`) |

PII (name, date of birth, documents) stays encrypted on IPFS. The VC proves only that a
KYC verification was completed — not the underlying personal data.

## Credential issuance flow

1. Holder creates a DID via `POST /api/did`
2. Holder establishes a DIDComm connection via `POST /api/did/:did/connect` (OOB invitation)
3. Verifier approves KYC via `PUT /api/kyc/:id/verify` → backend calls ACA-Py `POST /issue-credential-2.0/send`
4. ACA-Py delivers the VC to the holder's wallet over the DIDComm connection

A DIDComm connection must be active before step 3. VC issuance is best-effort — if no
connection exists, the Fabric ledger transition (`PENDING → VERIFIED`) still succeeds and
a warning is returned.

## Indy ledger

ACA-Py connects to the **BCovrin public test ledger** (internet access required). There is
no local `indy-node` container. For a fully offline setup, deploy
[von-network](https://github.com/bcgov/von-network) and set:

```bash
INDY_GENESIS_URL=http://localhost:9000/genesis
```

## After `docker compose down -v`

The ACA-Py wallet is wiped. You must:

1. Re-run `provision.sh` — a new DID will be created and registered on BCovrin
2. Set the new DID as public:
   ```bash
   curl -X POST "http://localhost:8031/wallet/did/public?did=<NEW_DID>" \
     -H "Content-Type: application/json" -d '{}'
   ```
3. Update `ACAPY_PUBLIC_DID` in `.env` if used

## Limitations

| Limitation | Detail |
|------------|--------|
| Revocation disabled | `support_revocation: false` — no tails server configured. Revoking a VC on the Fabric ledger does not invalidate an already-issued VC in a holder's wallet. |
| DIDs not publicly resolvable | `createDID` writes to the local wallet only — no NYM transaction is published. Fix: call `POST /ledger/register-nym` or switch to `did:peer`. |
| No tails server | Required to enable revocation. Deploy `bcgov/indy-tails-server` and set `ACAPY_TAILS_SERVER_BASE_URL` in `.env`. |
