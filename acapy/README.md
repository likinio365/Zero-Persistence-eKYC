# ACA-Py — Verifiable Credentials Agents

Two ACA-Py (Aries Cloud Agent Python) instances handle the SSI layer of the KYC system.

| Agent | Port (inbound) | Port (admin) | Role |
|-------|---------------|--------------|------|
| `acapy-agent` | 8030 | 8031 (localhost only) | KYC Issuer |
| `bank-acapy` | 8040 | 8041 (localhost only) | Bank Verifier |

## Responsibilities

**KYC Issuer (`acapy-agent`)**
- Maintains a public DID registered on the Indy ledger (BCovrin test network)
- Registers the KYC schema v3.0 + credential definition on the ledger
- Issues Verifiable Credentials to holders over DIDComm connections
- Revokes VCs (tails-server running; accumulator published to BCovrin)

**Bank Verifier (`bank-acapy`)**
- Creates DIDComm OOB invitations (QR codes) for bank verification
- Sends AnonCreds proof requests with `age ≥ 18` ZKP predicate
- Verifies proofs against BCovrin ledger — no contact with KYC backend required

## Directory structure

```
acapy/
├── scripts/
│   ├── provision.sh          # one-time: DID + schema v3.0 + cred def registration
│   ├── acapy-start.sh        # entrypoint: fetch Vault secrets → exec aca-py start
│   └── bank-acapy-start.sh   # same for bank agent
└── state/
    └── provision.json        # output of provision.sh (gitignored — regenerated each run)
```

## Schema v3.0

| Field | Value |
|-------|-------|
| Name | `kyc` |
| Version | `3.0` |
| Attributes | `kyc_id`, `verification_date`, `age` |
| Ledger | BCovrin test (`https://test.bcovrin.vonx.io`) |

The `age` attribute is computed server-side from `dateOfBirth` at verification time. The bank uses a ZKP predicate (`age >= 18`) — the actual age value is never revealed to the verifier.

PII (name, documents) stays encrypted on IPFS. The VC proves only that a KYC verification was completed and the holder meets the age requirement.

## Provisioning (first time or after full teardown)

```bash
bash acapy/scripts/provision.sh
```

The script:
1. Registers a new DID on BCovrin (or uses existing if already set as public)
2. Registers schema v3.0 on BCovrin
3. Creates a credential definition with revocation support
4. Writes `acapy/state/provision.json` + updates `.env` with `KYC_CRED_DEF_ID`

After provisioning, rebuild the frontend to bake in the new cred def:

```bash
docker compose build frontend
docker compose up -d --force-recreate frontend
```

Verify the public DID is set:

```bash
curl -s http://localhost:8031/wallet/did/public | python3 -m json.tool
```

## VC Issuance Flow (wallet QR)

1. Applicant's KYC is approved (`PENDING → VERIFIED`)
2. Applicant clicks **"Receive Credential in BC Wallet"** on the Status page
3. Backend creates OOB invitation → QR displayed
4. Applicant scans with BC Wallet → DIDComm connection established
5. Backend calls `POST /issue-credential-2.0/send` → VC delivered to wallet

## Revocation

Revocation is fully enabled:

- tails-server running at `localhost:6543`
- Revocation accumulator published to BCovrin
- Bank proof requests include `non_revoked: { to: now }` — revoked credentials are rejected

After `docker compose down -v`, the tails file must be re-uploaded manually (see root README — Post-teardown Recovery).

## Indy Ledger

ACA-Py connects to the **BCovrin public test ledger** — internet access required at runtime. There is no local `indy-node` container. For a fully offline setup:

```bash
# Run von-network locally
git clone https://github.com/bcgov/von-network && cd von-network
./manage build && ./manage start

# Set in .env
INDY_GENESIS_URL=http://localhost:9000/genesis
INDY_LEDGER_URL=http://localhost:9000
```

## Secrets at Runtime

Both agents fetch their wallet key and Postgres password from HashiCorp Vault KV at startup (not from environment variables directly). The startup scripts (`acapy-start.sh`, `bank-acapy-start.sh`) use a Python one-liner to call the Vault HTTP API, then `exec aca-py start`.
