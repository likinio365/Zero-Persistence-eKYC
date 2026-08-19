# KYC Chaincode (Hyperledger Fabric)

Go chaincode that manages the KYC record lifecycle on the Hyperledger Fabric ledger.

## State machine

```
PENDING ──► VERIFIED ──► REVOKED  (terminal)
PENDING ──► REJECTED              (terminal)
```

Transition guards live in `model.go → KYCRecord.canTransitionTo()`. Invalid transitions return an error and leave the ledger unchanged.

## On-ledger record

Only the **encrypted IPFS manifest CID** (`ipfsHash`) is stored on-chain — no personal data, no raw documents.

```go
type KYCRecord struct {
    ID              string    // UUID, used as ledger key
    DID             string    // holder's self-sovereign DID
    Status          KYCStatus // PENDING | VERIFIED | REVOKED | REJECTED
    IPFSHash        string    // encrypted manifest CID
    CredDefID       string    // set on VERIFIED (Indy cred def used for VC)
    RejectionReason string    // set on REJECTED (optional)
    CreatedAt       string
    UpdatedAt       string
}
```

## Contract functions

| Function | Transition | Description |
|----------|-----------|-------------|
| `SubmitKYC(id, did, ipfsHash)` | → PENDING | Creates a new record |
| `VerifyKYC(id, credDefId)` | PENDING → VERIFIED | Stores the credential definition ID |
| `RejectKYC(id, reason)` | PENDING → REJECTED | Stores optional rejection reason |
| `RevokeKYC(id)` | VERIFIED → REVOKED | Terminal revocation |
| `GetKYC(id)` | — | Fetch current state |
| `GetKYCHistory(id)` | — | Full audit trail via `GetHistoryForKey` |
| `QueryByDID(did)` | — | CouchDB rich query — all records for a DID |
| `QueryByStatus(status)` | — | CouchDB rich query — all records at a given status |

## Files

| File | Purpose |
|------|---------|
| `kyc.go` | Contract implementation — all 8 functions above |
| `model.go` | `KYCRecord`, `HistoryEntry` structs; state machine table |
| `kyc_test.go` | 20+ unit tests using `MockStub` (no real Fabric needed) |
| `main.go` | Chaincode entry point |

## Running tests

```bash
go test ./...
```

Tests cover: full lifecycle (submit → verify → revoke), reject path, duplicate submit, invalid DID, all invalid state transitions, `GetKYCHistory`. `QueryByDID` and `QueryByStatus` use CouchDB rich queries and require a live peer — skipped in unit tests.

## Deploying

From the repo root:

```bash
# Fresh network
CC_VERSION=1.0 CC_SEQUENCE=1 ./fabric/scripts/deploy-chaincode.sh

# Upgrade on a running network
CC_VERSION=2.0 CC_SEQUENCE=2 ./fabric/scripts/deploy-chaincode.sh
```

`deploy-chaincode.sh` handles: package → install on peer → approve for org → commit to channel.
