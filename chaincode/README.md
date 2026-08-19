# KYC Chaincode (Go)

Hyperledger Fabric chaincode implementing the KYC record ledger. Written in Go using `fabric-contract-api-go`.

## Functions

| Function | Description |
|----------|-------------|
| `SubmitKYC(id, did, ipfsHash)` | Create a new `KYCRecord` in `PENDING` state |
| `VerifyKYC(id, credDefId)` | Transition `PENDING → VERIFIED`; store credential definition ID |
| `RejectKYC(id, reason)` | Transition `PENDING → REJECTED`; store optional rejection reason |
| `RevokeKYC(id)` | Transition `VERIFIED → REVOKED` (terminal) |
| `ResubmitKYC(id, newIpfsHash)` | Transition `VERIFIED|REJECTED → PENDING`; clears `credDefId`, `rejectionReason`; updates `ipfsHash` |
| `StoreCredExchangeID(id, credExchangeId)` | Store the ACA-Py credential exchange ID for later revocation |
| `EraseKYC(id)` | GDPR Art. 17 — transition any state → `DELETED`; clears `ipfsHash` |
| `GetKYC(id)` | Return the current `KYCRecord` JSON |
| `GetKYCHistory(id)` | Return full on-chain audit trail via `GetHistoryForKey` |
| `QueryByDID(did)` | Rich query (CouchDB) — all records for a DID |
| `QueryByStatus(status)` | Rich query (CouchDB) — all records with a given status |

## State Machine

```
                  ┌──────────┐
         ┌───────►│ PENDING  │◄──────────────────┐
         │        └────┬─────┘                   │
         │             │                          │
     ResubmitKYC  VerifyKYC / RejectKYC      ResubmitKYC
         │             │                          │
         │        ┌────▼──────────────────────────┤
         │        │  VERIFIED  │   REJECTED        │
         │        └────┬───────┘───────────────────┘
         │         RevokeKYC
         │        ┌────▼─────┐
         └────────│ REVOKED  │  (terminal)
                  └──────────┘

         EraseKYC(any state) → DELETED  (GDPR Art. 17, terminal)
```

Transition guards live in `KYCRecord.canTransitionTo()` in `model.go`. An invalid transition returns an error — the record is not modified.

## KYCRecord

```go
type KYCRecord struct {
    ID                   string    `json:"id"`
    DID                  string    `json:"did"`
    IPFSHash             string    `json:"ipfsHash"`     // manifest CID; cleared on EraseKYC
    Status               string    `json:"status"`
    CredDefID            string    `json:"credDefId"`    // set by VerifyKYC; cleared on ResubmitKYC
    CredentialExchangeID string    `json:"credentialExchangeId"` // set by StoreCredExchangeID
    RejectionReason      string    `json:"rejectionReason,omitempty"`
    CreatedAt            time.Time `json:"createdAt"`
    UpdatedAt            time.Time `json:"updatedAt"`
}
```

## File Layout

```
chaincode/
├── kyc.go           # contract — all 11 functions
├── model.go         # KYCRecord + HistoryEntry structs; state machine
├── kyc_test.go      # 20+ unit tests (full lifecycle, reject, resubmit, erase)
├── go.mod / go.sum
└── Dockerfile       # CaaS image — multi-stage Go build, listens on 7052
```

## Build & Test

```bash
cd chaincode

# Compile
go build ./...

# Run all tests
go test ./... -v

# Vendor dependencies (needed before Docker build)
go mod vendor
```

All tests use `shim.NewMockStub` — no running Fabric network required.

## CaaS (Chaincode as a Service)

The peer does **not** build the chaincode image. The image is built on the host and the peer connects to it over gRPC:

```bash
# Build CaaS image
docker build -t kyccc-service:1.0 chaincode/

# The deployment script handles packaging and lifecycle commands
./fabric/scripts/deploy-chaincode.sh
```

Environment variable for the shim: `CORE_CHAINCODE_ID_NAME` (not `CHAINCODE_ID`).

## Rich Queries

`QueryByDID` and `QueryByStatus` use CouchDB selector syntax. They require CouchDB as the state database (`CORE_LEDGER_STATE_COUCHDBCONFIG_COUCHDBADDRESS` in peer config). They do not work with the default LevelDB state database.

## Deployment

The chaincode is deployed via the Fabric lifecycle:

```bash
CC_VERSION=1.0 CC_SEQUENCE=1 ./fabric/scripts/deploy-chaincode.sh
```

After adding new functions, increment `CC_SEQUENCE`:

```bash
CC_VERSION=2.0 CC_SEQUENCE=2 ./fabric/scripts/deploy-chaincode.sh
```
